#!/usr/bin/env node
import process from 'node:process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature, signUnsignedEnvelopeHex } from '../src/protocol/signedMessage.js';
import { KIND, ASSET, PAIR, STATE } from '../src/swap/constants.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { buildSettlementContext } from '../src/swap/settlementContext.js';
import { createInitialTrade, applySwapEnvelope } from '../src/swap/stateMachine.js';
import {
  getAmountFieldForPair,
  getAmountForPair,
  getDirectionForPair,
  getPairSettlementKind,
  getQuoteRefundFieldForPair,
  getRfqRefundRangeFieldsForPair,
  isTaoPair,
  normalizePair,
} from '../src/swap/pairs.js';
import { createSignedWelcome, createSignedInvite, signPayloadHex } from '../src/sidechannel/capabilities.js';
import { normalizeClnNetwork } from '../src/ln/cln.js';
import { normalizeLndNetwork } from '../src/ln/lnd.js';
import { decodeBolt11 } from '../src/ln/bolt11.js';
import { lnInvoice } from '../src/ln/client.js';
import { openTradeReceiptsStore } from '../src/receipts/store.js';
import { loadPeerWalletFromFile } from '../src/peer/keypair.js';
import {
  DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC,
  resolveSettlementRefundAfterSec,
  resolveUnsafeMinSettlementRefundAfterSec,
} from '../src/rfq/cliFlags.js';
import { computeTaoSwapIdFromLockInputs } from '../settlement/tao-evm/TaoEvmSettlementProvider.js';
import {
  getSettlementProvider,
  normalizeSettlementKind,
  SETTLEMENT_KIND,
  SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID,
} from '../settlement/providerFactory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultComposeFile = path.join(repoRoot, 'dev/ln-regtest/docker-compose.yml');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function parseIntFlag(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

const TAO_AMOUNT_VALIDATION_ERROR = 'Invalid TAO amount: expected decimal format with up to 18 decimal places';
const TAO_AMOUNT_LEADING_ZERO_ERROR =
  'Invalid TAO amount: must include a leading zero (e.g. 0.002), up to 18 decimal places';

function parseTaoAmountToAtomicString(value) {
  const raw = String(value ?? '').trim();
  if (/^\.\d+$/.test(raw)) {
    throw new Error(TAO_AMOUNT_LEADING_ZERO_ERROR);
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(TAO_AMOUNT_VALIDATION_ERROR);
  }
  const [whole, fractional = ''] = raw.split('.');
  if (fractional.length > 18) {
    throw new Error(TAO_AMOUNT_VALIDATION_ERROR);
  }
  const atomic = `${whole}${fractional.padEnd(18, '0')}`.replace(/^0+(?=\d)/, '');
  return atomic || '0';
}

function formatTaoAtomic(atomicStr) {
  try {
    const v = BigInt(atomicStr);
    const whole = v / 1000000000000000000n;
    const frac = v % 1000000000000000000n;

    if (frac === 0n) return `${whole.toString()}`;

    const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracStr}`;
  } catch {
    return atomicStr;
  }
}

function formatBtcSats(sats) {
  try {
    const v = BigInt(sats);
    const whole = v / 100000000n;
    const frac = v % 100000000n;

    if (frac === 0n) return `${whole.toString()}`;

    const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracStr}`;
  } catch {
    return String(sats);
  }
}

const withinBounds = (value, min, max) => {
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
};

export const DEFAULT_LN_INVOICE_EXPIRY_SEC = 3600;

export function resolveLnInvoiceExpirySec(value) {
  const expirySec = parseIntFlag(value, 'ln-invoice-expiry-sec', null);
  if (expirySec === null) return DEFAULT_LN_INVOICE_EXPIRY_SEC;
  if (expirySec < 60) die('Invalid --ln-invoice-expiry-sec (must be >= 60)');
  if (expirySec > 7 * 24 * 3600) die('Invalid --ln-invoice-expiry-sec (must be <= 604800)');
  return expirySec;
}

function normalizeHex32WithOptional0x(value, label) {
  const raw = String(value || '').trim();
  const noPrefix = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(noPrefix)) {
    throw new Error(`${label} must be 32-byte hex`);
  }
  return `0x${noPrefix.toLowerCase()}`;
}

function normalizeAtomicAmountString(value, label) {
  const s = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(s) || BigInt(s) <= 0n) throw new Error(`${label} must be a positive base-unit integer`);
  return s;
}

function normalizeUnixSec(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new Error(`${label} must be unix seconds`);
  return n;
}

export function deriveDeterministicTaoClientSalt({ tradeId, rfqId, quoteId }) {
  const seed = [
    'intercomswap:tao-client-salt:v1',
    String(tradeId || '').trim().toLowerCase(),
    String(rfqId || '').trim().toLowerCase(),
    String(quoteId || '').trim().toLowerCase(),
  ].join('|');
  const digestHex = crypto.createHash('sha256').update(seed).digest('hex');
  return `0x${digestHex}`;
}

export function buildTaoLockCheckpoint({
  tradeId,
  rfqId,
  quoteId,
  sender,
  receiver,
  amountAtomic,
  refundAfterUnix,
  paymentHashHex,
  htlcAddress,
}) {
  const clientSalt = deriveDeterministicTaoClientSalt({ tradeId, rfqId, quoteId });
  const hashlock = normalizeHex32WithOptional0x(paymentHashHex, 'paymentHashHex');
  const normalizedAmountAtomic = normalizeAtomicAmountString(amountAtomic, 'amountAtomic');
  const normalizedRefundAfterUnix = normalizeUnixSec(refundAfterUnix, 'refundAfterUnix');
  const settlementId = computeTaoSwapIdFromLockInputs({
    sender,
    receiver,
    value: normalizedAmountAtomic,
    refundAfter: normalizedRefundAfterUnix,
    hashlock,
    clientSalt,
  });
  return {
    clientSalt,
    settlementId,
    hashlock,
    amountAtomic: normalizedAmountAtomic,
    refundAfterUnix: normalizedRefundAfterUnix,
    recipient: String(receiver || '').trim(),
    refundAddress: String(sender || '').trim(),
    htlcAddress: String(htlcAddress || '').trim() || null,
  };
}

function parseSignedEnvelopeLike(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
}

function normalizeAnnounceOffersJson(rawValue, { repoRoot, debug = false } = {}) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';
  const jsonText = raw.startsWith('@')
    ? fs.readFileSync(path.isAbsolute(raw.slice(1)) ? raw.slice(1) : path.resolve(repoRoot, raw.slice(1)), 'utf8')
    : raw;
  const parsed = JSON.parse(jsonText);
  const normalizeOffer = (offer) => {
    if (!offer || typeof offer !== 'object' || Array.isArray(offer)) return offer;
    if (Object.prototype.hasOwnProperty.call(offer, 'tao_amount') && Object.prototype.hasOwnProperty.call(offer, 'tao_amount_atomic')) {
      throw new Error('Provide only one of tao_amount or tao_amount_atomic in announce-offers-json');
    }
    if (!Object.prototype.hasOwnProperty.call(offer, 'tao_amount')) return offer;
    const normalized = { ...offer };
    normalized.tao_amount_atomic = parseTaoAmountToAtomicString(offer.tao_amount);
    delete normalized.tao_amount;
    if (debug) {
      process.stderr.write(`[maker] auto announce normalized tao_amount_atomic=${normalized.tao_amount_atomic}\n`);
    }
    return normalized;
  };
  if (Array.isArray(parsed)) {
    return JSON.stringify(parsed.map(normalizeOffer));
  }
  if (Array.isArray(parsed?.offers)) {
    return JSON.stringify({
      ...parsed,
      offers: parsed.offers.map(normalizeOffer),
    });
  }
  return JSON.stringify(parsed);
}

export function quoteMatchesCurrentSettlementPolicy({
  signedQuote,
  pair,
  settlementKind,
  settlementRefundAfterSec,
}) {
  if (normalizeSettlementKind(settlementKind) !== SETTLEMENT_KIND.TAO_EVM) return true;
  const normalizedPair = normalizePair(pair);
  if (!isTaoPair(normalizedPair)) return true;
  const quoteEnvelope = parseSignedEnvelopeLike(signedQuote);
  if (!quoteEnvelope || typeof quoteEnvelope.body !== 'object') return false;
  const refundField = getQuoteRefundFieldForPair(normalizedPair);
  const quoteRefundAfterSec = Number(quoteEnvelope.body?.[refundField]);
  if (!Number.isFinite(quoteRefundAfterSec)) return false;
  return quoteRefundAfterSec === Number(settlementRefundAfterSec);
}

export async function maybeReuseExistingQuote({
  existingLock,
  pair,
  settlementKind,
  settlementRefundAfterSec,
  sendQuote,
  nowMs = Date.now(),
}) {
  if (!existingLock || existingLock.state !== 'quoted' || !existingLock.signedQuote) {
    return { reused: false, sent: false, cleared: false, reason: 'missing_existing_quote' };
  }
  if (
    !quoteMatchesCurrentSettlementPolicy({
      signedQuote: existingLock.signedQuote,
      pair,
      settlementKind,
      settlementRefundAfterSec,
    })
  ) {
    return { reused: false, sent: false, cleared: true, reason: 'quote_policy_changed_repost' };
  }
  await sendQuote(existingLock.signedQuote);
  existingLock.lastSeenMs = nowMs;
  existingLock.lastQuoteSendAtMs = nowMs;
  return { reused: true, sent: true, cleared: false, reason: 'resend_existing_quote' };
}

export function shouldSkipMissingSolRecipient({
  runSwap,
  makerSettlementKind,
  pair,
  solRecipient,
}) {
  if (!runSwap) return false;
  if (normalizeSettlementKind(makerSettlementKind) !== SETTLEMENT_KIND.SOLANA) return false;
  const normalizedPair = normalizePair(pair);
  if (getPairSettlementKind(normalizedPair) !== SETTLEMENT_KIND.SOLANA) return false;
  return !String(solRecipient || '').trim();
}

export function resolveMakerSettlementRefundConfig({
  settlementRefundAfterSecRaw,
  legacySolanaRefundAfterSecRaw,
  unsafeMinSettlementRefundAfterSecRaw,
  fallbackSec = 72 * 3600,
  defaultSafeMinSec = DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC,
  minSec = 3600,
  maxSec = 7 * 24 * 3600,
}) {
  const unsafeMinConfig = resolveUnsafeMinSettlementRefundAfterSec({
    unsafeMinSettlementRefundAfterSecRaw,
    fallbackSec: defaultSafeMinSec,
    maxSec,
    roleLabel: 'maker',
  });
  const refundConfig = resolveSettlementRefundAfterSec({
    settlementRefundAfterSecRaw,
    legacySolanaRefundAfterSecRaw,
    fallbackSec,
    minSec: unsafeMinConfig.effectiveMinSettlementRefundAfterSec,
    maxSec,
  });
  return {
    settlementRefundAfterSec: refundConfig.settlementRefundAfterSec,
    effectiveMinSettlementRefundAfterSec: unsafeMinConfig.effectiveMinSettlementRefundAfterSec,
    unsafeMinProvided: unsafeMinConfig.unsafeMinProvided,
    warnings: unsafeMinConfig.warnings.concat(refundConfig.warnings),
  };
}

export function resolveMakerCleanupPersistence(ctx, { reason = null } = {}) {
  const txId = String(ctx?.taoLockTxId || '').trim();
  const lockPhase = String(ctx?.taoLockPhase || '').trim().toLowerCase();
  let state = String(ctx?.trade?.state || '').trim() || null;
  if ([STATE.CLAIMED, STATE.REFUNDED, STATE.CANCELED].includes(state)) {
    return {
      state,
      last_error: String(ctx?.lastLockError || '').trim() || (reason ? String(reason) : null),
    };
  }
  if (isTaoPair(ctx?.pair)) {
    if (txId) state = STATE.ESCROW;
    else if (lockPhase === 'locking') state = 'locking';
  }
  const lastLockError = String(ctx?.lastLockError || '').trim();
  return {
    state,
    last_error: lastLockError || (reason ? String(reason) : null),
  };
}

export function handleMakerTaoLockStage({
  ctx,
  stage,
  details = {},
  persistTrade = null,
  log = null,
}) {
  const normalizedStage = String(stage || '').trim().toLowerCase();
  const tradeId = String(ctx?.tradeId || '').trim() || null;
  const settlementId =
    String(details.settlementId || details.settlement_id || ctx?.taoSettlementId || '').trim() || null;
  const txId = String(details.txId || details.tx_id || ctx?.taoLockTxId || '').trim() || null;
  const errorMessage = String(details.error || '').trim() || null;

  if (normalizedStage === 'prepare' || normalizedStage === 'rpc_send') {
    ctx.taoLockPhase = 'locking';
  }
  if (normalizedStage === 'confirmed') {
    ctx.taoLockPhase = 'escrow';
  }
  if (settlementId) ctx.taoSettlementId = settlementId;
  if (txId) ctx.taoLockTxId = txId;
  if (errorMessage) ctx.lastLockError = errorMessage;

  const eventKindByStage = {
    prepare: 'tao_lock_prepare',
    rpc_send: 'tao_lock_rpc_send',
    tx_hash: 'tao_lock_tx_hash',
    wait_confirm: 'tao_lock_wait_confirm',
    confirmed: 'tao_lock_confirmed',
    error: 'tao_lock_error',
  };
  const eventKind = eventKindByStage[normalizedStage] || null;
  const patch =
    normalizedStage === 'error'
      ? {
          state: resolveMakerCleanupPersistence(ctx).state,
          last_error: ctx.lastLockError || null,
          ...(ctx.taoSettlementId ? { tao_settlement_id: ctx.taoSettlementId } : {}),
          ...(ctx.taoLockTxId ? { tao_lock_tx_id: ctx.taoLockTxId } : {}),
        }
      : null;
  const eventPayload = {
    trade_id: tradeId,
    stage: normalizedStage,
    settlement_id: settlementId,
    tx_id: txId,
    error: errorMessage,
    ...details,
  };

  if (typeof log === 'function') {
    log(
      `[maker] tao_lock_stage trade_id=${tradeId || 'n/a'} stage=${normalizedStage || 'n/a'} ` +
        `settlement_id=${settlementId || 'n/a'} tx_id=${txId || 'n/a'}${errorMessage ? ` error=${JSON.stringify(errorMessage)}` : ''}`
    );
  }
  if (tradeId && eventKind && typeof persistTrade === 'function') {
    persistTrade(tradeId, patch || {}, eventKind, eventPayload);
  }

  return { eventKind, patch, eventPayload };
}

function stripSignature(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const { sig: _sig, signer: _signer, ...unsigned } = envelope;
  return unsigned;
}

function ensureOk(res, label) {
  if (!res || typeof res !== 'object') throw new Error(`${label} failed (no response)`);
  if (res.type === 'error') throw new Error(`${label} failed: ${res.error}`);
  return res;
}

export function validateLocalMakerEnvelope(envelope, { effectiveMinSettlementRefundAfterSec } = {}) {
  return validateSwapEnvelope(envelope, {
    minSettlementRefundSec: effectiveMinSettlementRefundAfterSec,
  });
}

function signSwapEnvelope(unsignedEnvelope, { pubHex, secHex }, validationOptions = {}) {
  const sigHex = signUnsignedEnvelopeHex(unsignedEnvelope, secHex);
  const signed = attachSignature(unsignedEnvelope, { signerPubKeyHex: pubHex, sigHex });
  const v = validateLocalMakerEnvelope(signed, validationOptions);
  if (!v.ok) throw new Error(`Internal error: signed envelope invalid: ${v.error}`);
  return signed;
}

function normalizeAmountString(value) {
  const s = String(value ?? '').trim();
  if (!s) return '0';
  if (!/^[0-9]+$/.test(s)) return s;
  const n = s.replace(/^0+(?=\d)/, '');
  return n || '0';
}

export function resolveReceiptsDbPath({ receiptsDbPathRaw, peerKeypairPath, env = process.env }) {
  const explicit = String(receiptsDbPathRaw || '').trim();
  const envOverride = String(env?.INTERCOMSWAP_RECEIPTS_DB || '').trim();
  const picked = explicit || envOverride;
  if (picked) return path.isAbsolute(picked) ? picked : path.resolve(picked);
  const peerDir = path.dirname(path.resolve(peerKeypairPath));
  return path.join(peerDir, 'receipts.db');
}

export function initReceiptsStore({ dbPath, runSwap, allowNoReceipts = false, role = 'maker' }) {
  const resolved = path.isAbsolute(String(dbPath || '').trim()) ? String(dbPath).trim() : path.resolve(String(dbPath || '').trim());
  const hint =
    'Set --receipts-db <path> or INTERCOMSWAP_RECEIPTS_DB=<path>; use --allow-no-receipts 1 to bypass (UNSAFE).';
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const receipts = openTradeReceiptsStore({ dbPath: resolved });
    receipts.db.exec('BEGIN IMMEDIATE; ROLLBACK;');
    return {
      enabled: true,
      dbPath: receipts.dbPath || resolved,
      receipts,
    };
  } catch (err) {
    const details = `[receipts] enabled=false db_path=${resolved} error=${err?.message ?? String(err)}`;
    if (runSwap && !allowNoReceipts) throw new Error(`${details}\n${hint}`);
    process.stderr.write(`${details}\n`);
    process.stderr.write(`[receipts] warning: continuing without receipts (role=${role} run_swap=${runSwap ? 1 : 0})\n`);
    process.stderr.write(`[receipts] hint: ${hint}\n`);
    return { enabled: false, dbPath: resolved, receipts: null };
  }
}

export function persistTradeReceipt({
  receipts,
  tradeId,
  settlementKind,
  patch,
  eventKind = null,
  eventPayload = null,
  onError = null,
}) {
  if (!receipts) return false;
  const normalizedTradeId = String(tradeId || '').trim();
  if (!normalizedTradeId) return false;
  try {
    receipts.upsertTrade(normalizedTradeId, {
      settlement_kind: settlementKind,
      ...patch,
    });
    if (eventKind) receipts.appendEvent(normalizedTradeId, eventKind, eventPayload);
    return true;
  } catch (err) {
    try {
      receipts.upsertTrade(normalizedTradeId, { last_error: err?.message ?? String(err) });
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
    if (typeof onError === 'function') onError(err);
    return false;
  }
}

function buildRfqLockKey(msg) {
  const body = msg?.body && typeof msg.body === 'object' ? msg.body : {};
  const pair = normalizePair(body.pair);
  const quoteRefundField = getQuoteRefundFieldForPair(pair);
  const { minField, maxField } = getRfqRefundRangeFieldsForPair(pair);
  return [
    String(msg?.signer || '').trim().toLowerCase(),
    String(msg?.trade_id || '').trim(),
    pair,
    String(body.direction || '').trim(),
    String(body.btc_sats ?? '').trim(),
    normalizeAmountString(getAmountForPair(body, pair, { allowLegacyTaoFallback: true })),
    String(body.max_platform_fee_bps ?? '').trim(),
    String(body.max_trade_fee_bps ?? '').trim(),
    String(body.max_total_fee_bps ?? '').trim(),
    String(body[minField] ?? '').trim(),
    String(body[maxField] ?? '').trim(),
    String(body[quoteRefundField] ?? '').trim(),
    String(body.sol_recipient || '').trim().toLowerCase(),
    String(body.sol_mint || '').trim(),
    String(body.app_hash || '').trim().toLowerCase(),
  ].join('|');
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const url = requireFlag(flags, 'url');
  const token = requireFlag(flags, 'token');
  const peerKeypairPath = requireFlag(flags, 'peer-keypair');
  const rfqChannel = (flags.get('rfq-channel') && String(flags.get('rfq-channel')).trim()) || '0000intercomswapbtcusdt';
  const swapChannelTemplate =
    (flags.get('swap-channel-template') && String(flags.get('swap-channel-template')).trim()) || 'swap:{trade_id}';
  const quoteValidSec = parseIntFlag(flags.get('quote-valid-sec'), 'quote-valid-sec', 60);
  const inviteTtlSec = parseIntFlag(flags.get('invite-ttl-sec'), 'invite-ttl-sec', 7 * 24 * 3600);
  const onceExitDelayMs = parseIntFlag(flags.get('once-exit-delay-ms'), 'once-exit-delay-ms', 750);
  const once = parseBool(flags.get('once'), false);
  const debug = parseBool(flags.get('debug'), false);
  const rawMaxTrades = flags.get('max-trades');
  let maxTrades;
  if (rawMaxTrades === undefined) {
    maxTrades = 1;
  } else {
    maxTrades = Number(rawMaxTrades);
    if (!Number.isInteger(maxTrades) || maxTrades < 0) die('Invalid --max-trades (expected integer >= 0)');
  }
  const autoAnnounceIntervalSec = flags.get('auto-announce-interval-sec')
    ? Number(flags.get('auto-announce-interval-sec'))
    : null;
  const announceName = flags.get('announce-name')
    ? String(flags.get('announce-name')).trim()
    : '';
  const announceOffersJson = flags.get('announce-offers-json')
    ? String(flags.get('announce-offers-json'))
    : '';
  let normalizedAnnounceOffersJson = announceOffersJson;
  const announceTtlSec = flags.get('announce-ttl-sec') !== undefined
    ? parseIntFlag(flags.get('announce-ttl-sec'), 'announce-ttl-sec', null)
    : null;
  const announceJoin = flags.get('announce-join') !== undefined
    ? parseBool(flags.get('announce-join'), false)
    : false;
  const minBtcSats = flags.get('min-btc-sats') !== undefined
    ? parseIntFlag(flags.get('min-btc-sats'), 'min-btc-sats', null)
    : undefined;
  const maxBtcSats = flags.get('max-btc-sats') !== undefined
    ? parseIntFlag(flags.get('max-btc-sats'), 'max-btc-sats', null)
    : undefined;
  const minTaoRaw = flags.get('min-tao');
  const maxTaoRaw = flags.get('max-tao');
  const minTaoAtomicCompatRaw = flags.get('min-tao-atomic');
  const maxTaoAtomicCompatRaw = flags.get('max-tao-atomic');

  if (autoAnnounceIntervalSec !== null) {
    if (!Number.isInteger(autoAnnounceIntervalSec) || autoAnnounceIntervalSec < 5) {
      die('Invalid --auto-announce-interval-sec (expected integer >= 5)');
    }
  }
  if (minBtcSats !== undefined && (!Number.isInteger(minBtcSats) || minBtcSats < 0)) {
    die('Invalid --min-btc-sats (expected integer >= 0)');
  }
  if (maxBtcSats !== undefined && (!Number.isInteger(maxBtcSats) || maxBtcSats < 0)) {
    die('Invalid --max-btc-sats (expected integer >= 0)');
  }
  if (minTaoRaw !== undefined && minTaoAtomicCompatRaw !== undefined) {
    die('Provide only one of --min-tao or --min-tao-atomic');
  }
  if (maxTaoRaw !== undefined && maxTaoAtomicCompatRaw !== undefined) {
    die('Provide only one of --max-tao or --max-tao-atomic');
  }
  if (minTaoAtomicCompatRaw !== undefined && !/^[0-9]+$/.test(String(minTaoAtomicCompatRaw))) {
    die(TAO_AMOUNT_VALIDATION_ERROR);
  }
  if (maxTaoAtomicCompatRaw !== undefined && !/^[0-9]+$/.test(String(maxTaoAtomicCompatRaw))) {
    die(TAO_AMOUNT_VALIDATION_ERROR);
  }
  let minTaoAtomic;
  if (minTaoRaw !== undefined) {
    try {
      minTaoAtomic = BigInt(parseTaoAmountToAtomicString(minTaoRaw));
    } catch (err) {
      die(err?.message || String(err));
    }
  } else if (minTaoAtomicCompatRaw !== undefined) {
    minTaoAtomic = BigInt(String(minTaoAtomicCompatRaw));
  }
  let maxTaoAtomic;
  if (maxTaoRaw !== undefined) {
    try {
      maxTaoAtomic = BigInt(parseTaoAmountToAtomicString(maxTaoRaw));
    } catch (err) {
      die(err?.message || String(err));
    }
  } else if (maxTaoAtomicCompatRaw !== undefined) {
    maxTaoAtomic = BigInt(String(maxTaoAtomicCompatRaw));
  }
  if (minBtcSats !== undefined && maxBtcSats !== undefined && minBtcSats > maxBtcSats) {
    die('Invalid BTC size bounds (min > max)');
  }
  if (minTaoAtomic !== undefined && maxTaoAtomic !== undefined && minTaoAtomic > maxTaoAtomic) {
    die('Invalid TAO size bounds (min > max)');
  }
  if (announceTtlSec !== null) {
    if (!Number.isInteger(announceTtlSec) || announceTtlSec < 1) {
      die('Invalid --announce-ttl-sec (expected integer >= 1)');
    }
  }
  if (announceOffersJson) {
    try {
      normalizedAnnounceOffersJson = normalizeAnnounceOffersJson(announceOffersJson, { repoRoot, debug });
    } catch (err) {
      die(err?.message || String(err));
    }
  }

  if (autoAnnounceIntervalSec) {
    process.stderr.write(`[maker] auto announce enabled (${autoAnnounceIntervalSec}s)\n`);
    process.stderr.write(
      `[maker] auto announce config: name=${announceName ? 'set' : 'missing'} ` +
      `offers=${normalizedAnnounceOffersJson ? 'set' : 'missing'} ttl=${announceTtlSec ?? 'missing'} join=${announceJoin ? 1 : 0}\n`
    );
  }
  const settlementKind = normalizeSettlementKind(flags.get('settlement') || SETTLEMENT_KIND.SOLANA);
  const isSolanaSettlement = settlementKind === SETTLEMENT_KIND.SOLANA;
  const isTaoSettlement = settlementKind === SETTLEMENT_KIND.TAO_EVM;

  const receiptsDbPath = resolveReceiptsDbPath({
    receiptsDbPathRaw: flags.get('receipts-db'),
    peerKeypairPath,
  });

  const runSwap = parseBool(flags.get('run-swap'), false);
  const allowNoReceipts = parseBool(flags.get('allow-no-receipts'), false);
  const swapTimeoutSec = parseIntFlag(flags.get('swap-timeout-sec'), 'swap-timeout-sec', 300);
  const swapResendMs = parseIntFlag(flags.get('swap-resend-ms'), 'swap-resend-ms', 1200);
  const retryResendMinMs = parseIntFlag(flags.get('retry-resend-min-ms'), 'retry-resend-min-ms', 20_000);
  const termsValidSec = parseIntFlag(flags.get('terms-valid-sec'), 'terms-valid-sec', 300);
  const lnInvoiceExpirySec = resolveLnInvoiceExpirySec(flags.get('ln-invoice-expiry-sec'));

  // Hard guardrails for safety + inventory lockup.
  // - Too short => increases "paid but can't claim before refund" risk.
  // - Too long  => griefing can lock maker inventory for excessive time.
  const SETTLEMENT_REFUND_MIN_SEC = 3600; // 1h
  const SETTLEMENT_REFUND_MAX_SEC = 7 * 24 * 3600; // 1w
  let settlementRefundAfterSec = 72 * 3600;
  let effectiveMinSettlementRefundAfterSec = DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC;
  try {
    const settlementRefund = resolveMakerSettlementRefundConfig({
      settlementRefundAfterSecRaw: flags.get('settlement-refund-after-sec'),
      legacySolanaRefundAfterSecRaw: flags.get('solana-refund-after-sec'),
      unsafeMinSettlementRefundAfterSecRaw: flags.get('unsafe-min-settlement-refund-after-sec'),
      fallbackSec: 72 * 3600,
      defaultSafeMinSec: DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC,
      minSec: SETTLEMENT_REFUND_MIN_SEC,
      maxSec: SETTLEMENT_REFUND_MAX_SEC,
    });
    settlementRefundAfterSec = settlementRefund.settlementRefundAfterSec;
    effectiveMinSettlementRefundAfterSec = settlementRefund.effectiveMinSettlementRefundAfterSec;
    for (const warning of settlementRefund.warnings) process.stderr.write(`Warning: ${warning}\n`);
  } catch (err) {
    die(err?.message || String(err));
  }

  const solRpcUrl = (flags.get('solana-rpc-url') && String(flags.get('solana-rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const solKeypairPath = flags.get('solana-keypair') ? String(flags.get('solana-keypair')).trim() : '';
  const taoKeyfilePath = flags.get('tao-keyfile') ? String(flags.get('tao-keyfile')).trim() : '';
  const solMintStr = flags.get('solana-mint') ? String(flags.get('solana-mint')).trim() : '';
  const solDecimals = parseIntFlag(flags.get('solana-decimals'), 'solana-decimals', 6);
  const solProgramIdStr = flags.get('solana-program-id') ? String(flags.get('solana-program-id')).trim() : '';
  const solComputeUnitLimit = parseIntFlag(flags.get('solana-cu-limit'), 'solana-cu-limit', null);
  const solComputeUnitPriceMicroLamports = parseIntFlag(flags.get('solana-cu-price'), 'solana-cu-price', null);
  const solTradeFeeCollectorStr = flags.get('solana-trade-fee-collector')
    ? String(flags.get('solana-trade-fee-collector')).trim()
    : '';

  const lnImpl = (flags.get('ln-impl') && String(flags.get('ln-impl')).trim().toLowerCase()) || 'cln';
  if (lnImpl !== 'cln' && lnImpl !== 'lnd') die('Invalid --ln-impl (expected cln|lnd)');
  const lnBackend = (flags.get('ln-backend') && String(flags.get('ln-backend')).trim()) || 'docker';
  const lnComposeFile = (flags.get('ln-compose-file') && String(flags.get('ln-compose-file')).trim()) || defaultComposeFile;
  const lnService = flags.get('ln-service') ? String(flags.get('ln-service')).trim() : '';
  const lnNetworkRaw = (flags.get('ln-network') && String(flags.get('ln-network')).trim()) || 'regtest';
  let lnNetwork;
  try {
    lnNetwork = lnImpl === 'lnd' ? normalizeLndNetwork(lnNetworkRaw) : normalizeClnNetwork(lnNetworkRaw);
  } catch (err) {
    die(err?.message ?? String(err));
  }
  const lnCliBin = flags.get('ln-cli-bin') ? String(flags.get('ln-cli-bin')).trim() : '';
  const lndRpcserver = flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '';
  const lndTlsCert = flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '';
  const lndMacaroon = flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '';
  const lndDir = flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '';

  const expectedProgramId = solProgramIdStr || SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID;
  const settlementCtx = buildSettlementContext({
    settlementKind,
    solanaProgramId: expectedProgramId,
  });
  const settlementBinding = settlementCtx.settlementBinding;
  const settlementProgramId = settlementBinding.binding_id;
  const expectedAppHash = settlementCtx.expectedAppHash;

  let receiptsRuntime;
  try {
    receiptsRuntime = initReceiptsStore({
      dbPath: receiptsDbPath,
      runSwap,
      allowNoReceipts,
      role: 'maker',
    });
  } catch (err) {
    die(err?.message || String(err));
  }
  const receipts = receiptsRuntime.receipts;
  process.stderr.write(`[receipts] enabled=${receiptsRuntime.enabled} db_path=${receiptsRuntime.dbPath}\n`);
  if (rawMaxTrades === undefined) {
    process.stderr.write('[maker] max trades set to 1 (default)\n');
  } else if (maxTrades > 0) {
    process.stderr.write(`[maker] max trades set to ${maxTrades}\n`);
  } else {
    process.stderr.write('[maker] max trades: unlimited\n');
    process.stderr.write('[maker] WARNING: unlimited mode enabled — may consume all available liquidity\n');
  }
  if (maxTrades === 0) {
    process.stderr.write('[maker] capacity mode: unlimited\n');
  } else {
    process.stderr.write('[maker] capacity mode: remaining capacity enforced\n');
  }

  if (runSwap) {
    if (isSolanaSettlement) {
      if (!solKeypairPath) die('Missing --solana-keypair (required when --run-swap 1 and --settlement solana)');
      if (!solMintStr) die('Missing --solana-mint (required when --run-swap 1 and --settlement solana)');
    }
    if (isTaoSettlement) {
      if (!taoKeyfilePath && !process.env.TAO_EVM_PRIVATE_KEY) {
        die('Missing TAO signer: provide --tao-keyfile or TAO_EVM_PRIVATE_KEY');
      }
    }
    if (!lnService && lnBackend === 'docker') die('Missing --ln-service (required when --ln-backend docker)');
  }

  const ln = {
    impl: lnImpl,
    backend: lnBackend,
    composeFile: lnComposeFile,
    service: lnService,
    network: lnNetwork,
    cliBin: lnCliBin,
    cwd: repoRoot,
    lnd: {
      rpcserver: lndRpcserver,
      tlscertpath: lndTlsCert,
      macaroonpath: lndMacaroon,
      lnddir: lndDir,
    },
  };

  const sc = new ScBridgeClient({ url, token });
  await sc.connect();
  ensureOk(await sc.join(rfqChannel), `join ${rfqChannel}`);
  ensureOk(await sc.subscribe([rfqChannel]), `subscribe ${rfqChannel}`);

  const makerPubkey = String(sc.hello?.peer || '').trim().toLowerCase();
  if (!makerPubkey) die('SC-Bridge hello missing peer pubkey');
  const signing = await loadPeerWalletFromFile(peerKeypairPath);
  if (signing.pubHex !== makerPubkey) {
    die(`peer keypair pubkey mismatch: sc_bridge=${makerPubkey} keypair=${signing.pubHex}`);
  }

  const quotes = new Map(); // quote_id -> { rfq_id, trade_id, btc_sats, usdt_amount, sol_recipient, sol_mint }
  const swaps = new Map(); // swap_channel -> ctx
  const pendingSwaps = new Map(); // swap_channel -> invitee_pubkey (dedupe concurrent QUOTE_ACCEPT handlers)
  const rfqLocks = new Map(); // lockKey -> { state, tradeId, quoteId, ... }
  const quoteIdToLockKey = new Map(); // quote_id -> lockKey
  const tradeIdToLockKey = new Map(); // trade_id -> lockKey
  const swapChannelToLockKey = new Map(); // swap_channel -> lockKey
  let activeTrades = 0;
  let completedTrades = 0;
  let shouldStop = false;
  let autoAnnounceInProgress = false;
  let autoAnnounceTimer = null;
  let warnedMissingAutoAnnounceConfig = false;
  let warnedAutoAnnounceCapacitySuppressed = false;

  const getRemainingCapacity = () => {
    if (maxTrades === 0) return Number.POSITIVE_INFINITY;
    return Math.max(maxTrades - completedTrades - activeTrades, 0);
  };

  const runAutoAnnounce = async () => {
    if (!autoAnnounceIntervalSec || autoAnnounceInProgress) return false;
    if (getRemainingCapacity() <= 0) {
      if (!warnedAutoAnnounceCapacitySuppressed) {
        process.stderr.write('[maker] auto announce suppressed: no remaining capacity\n');
        warnedAutoAnnounceCapacitySuppressed = true;
      }
      return false;
    }
    warnedAutoAnnounceCapacitySuppressed = false;
    if (maxTrades > 0 && completedTrades >= maxTrades) return false;
    if (!announceName || !normalizedAnnounceOffersJson) {
      if (!warnedMissingAutoAnnounceConfig) {
        process.stderr.write('[maker] auto announce skipped: missing announce-name or announce-offers-json\n');
        warnedMissingAutoAnnounceConfig = true;
      }
      return false;
    }
    autoAnnounceInProgress = true;

    try {
      await new Promise((resolve, reject) => {
        const argv = [
          path.join(repoRoot, 'scripts/swapctl.mjs'),
          'svc-announce',
          '--url',
          url,
          '--token',
          token,
          '--peer-keypair',
          peerKeypairPath,
          '--channels',
          rfqChannel,
          '--rfq-channels',
          rfqChannel,
          '--name',
          announceName,
          '--offers-json',
          normalizedAnnounceOffersJson,
          '--join',
          announceJoin ? '1' : '0',
        ];
        if (announceTtlSec !== null) {
          argv.push('--ttl-sec', String(announceTtlSec));
        }
        const proc = spawn(
          process.execPath,
          argv,
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );

        let errBuf = '';

        proc.stderr.on('data', (chunk) => {
          errBuf += String(chunk);
        });

        proc.on('error', reject);

        proc.on('close', (code) => {
          if (code === 0) return resolve();
          reject(new Error(errBuf.trim() || `svc-announce failed (${code})`));
        });
      });

      warnedMissingAutoAnnounceConfig = false;
      return true;
    } finally {
      autoAnnounceInProgress = false;
    }
  };

  const clearRfqLock = (lockKey, reason = 'unknown') => {
    if (!lockKey) return;
    const lock = rfqLocks.get(lockKey);
    rfqLocks.delete(lockKey);
    if (!lock) return;
    if (lock.quoteId) quoteIdToLockKey.delete(lock.quoteId);
    if (lock.tradeId && tradeIdToLockKey.get(lock.tradeId) === lockKey) tradeIdToLockKey.delete(lock.tradeId);
    if (lock.swapChannel && swapChannelToLockKey.get(lock.swapChannel) === lockKey) swapChannelToLockKey.delete(lock.swapChannel);
    if (debug) {
      process.stderr.write(
        `[maker] clear rfq lock trade_id=${lock.tradeId || '-'} state=${lock.state || '-'} reason=${String(reason || 'unknown')}\n`
      );
    }
  };

  const lockPruneTimer = setInterval(() => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    for (const [lockKey, lock] of rfqLocks.entries()) {
      if (!lock || typeof lock !== 'object') {
        clearRfqLock(lockKey, 'invalid_lock');
        continue;
      }
      if (lock.state === 'quoted') {
        const until = Number(lock.quoteValidUntilUnix || 0);
        if (Number.isFinite(until) && until > 0 && nowSec > until) clearRfqLock(lockKey, 'quote_expired');
        continue;
      }
      if (lock.state === 'accepting' || lock.state === 'swapping') {
        const deadline = Number(lock.lockDeadlineMs || 0);
        if (Number.isFinite(deadline) && deadline > 0 && nowMs > deadline) clearRfqLock(lockKey, 'lock_timeout');
      }
    }
  }, 5_000);

  const persistTrade = (tradeId, patch, eventKind = null, eventPayload = null) => {
    return persistTradeReceipt({
      receipts,
      tradeId,
      settlementKind,
      patch,
      eventKind,
      eventPayload,
      onError: (err) => {
        process.stderr.write(`[maker] ERROR: ${err?.stack || err?.message || String(err)}\n`);
      },
    });
  };

  const sol = runSwap
    ? await (async () => {
        /** @type {import('../settlement/SettlementProvider').SettlementProvider} */
        const settlement = getSettlementProvider(settlementKind, {
          solana: {
            rpcUrls: solRpcUrl,
            commitment: 'confirmed',
            keypairPath: solKeypairPath,
            mint: solMintStr,
            programId: expectedProgramId,
            tradeFeeCollector: solTradeFeeCollectorStr || '',
            computeUnitLimit: solComputeUnitLimit,
            computeUnitPriceMicroLamports: solComputeUnitPriceMicroLamports,
          },
          taoEvm: {
            chainId: 964,
            privateKey: process.env.TAO_EVM_PRIVATE_KEY || '',
            keyfilePath: taoKeyfilePath,
            confirmations: 1,
          },
        });
        return {
          settlement,
          kind: settlementKind,
          mint: isSolanaSettlement ? solMintStr : settlementProgramId,
          programId: settlementProgramId,
          refundAddress: await settlement.getSignerAddress(),
          tradeFeeCollector: isSolanaSettlement ? (solTradeFeeCollectorStr || null) : null,
        };
      })()
    : null;

  let done = false;
  let shuttingDown = false;
  let signalShutdownScheduled = false;

  const safeShutdown = async (reason = 'shutdown') => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (debug) process.stderr.write(`[maker] shutdown start reason=${reason}\n`);
    try {
      clearInterval(lockPruneTimer);
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
    for (const ctx of Array.from(swaps.values())) {
      try {
        if (ctx?.resender) clearInterval(ctx.resender);
      } catch (_e) {
        process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
    }
    try {
      const st = await sc.stats();
      const channels = Array.isArray(st?.channels) ? st.channels : [];
      for (const ch of channels) {
        const channel = String(ch || '').trim();
        if (channel.startsWith('swap:')) {
          try {
            await sc.leave(channel);
          } catch (_e) {
            process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
          }
        }
      }
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
    for (const swapChannel of Array.from(swaps.keys())) {
      try {
        await sc.leave(swapChannel);
      } catch (_e) {
        process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
    }
    if (receipts) {
      const seenTradeIds = new Set();
      for (const ctx of Array.from(swaps.values())) {
        const tradeId = String(ctx?.tradeId || '').trim();
        if (!tradeId || seenTradeIds.has(tradeId)) continue;
        seenTradeIds.add(tradeId);
        persistTrade(
          tradeId,
          { state: String(ctx?.trade?.state || '').trim() || null },
          'shutdown',
          {
            reason: String(reason || 'shutdown'),
            trade_id: tradeId,
            swap_channel: String(ctx?.swapChannel || '').trim() || null,
          }
        );
      }
    }
    try {
      receipts?.close();
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
    try {
      sc.close();
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
    if (debug) process.stderr.write(`[maker] shutdown done reason=${reason}\n`);
  };

  process.on('SIGINT', () => {
    if (signalShutdownScheduled) return;
    signalShutdownScheduled = true;
    void (async () => {
      await Promise.race([safeShutdown('sigint'), new Promise((resolve) => setTimeout(resolve, 1500))]);
      process.exit(130);
    })();
  });
  process.on('SIGTERM', () => {
    if (signalShutdownScheduled) return;
    signalShutdownScheduled = true;
    void (async () => {
      await Promise.race([safeShutdown('sigterm'), new Promise((resolve) => setTimeout(resolve, 1500))]);
      process.exit(143);
    })();
  });

  const maybeExit = () => {
    if (!once) return;
    if (!done) return;
    const delay = Number.isFinite(onceExitDelayMs) ? Math.max(onceExitDelayMs, 0) : 0;
    setTimeout(() => {
      void (async () => {
        await safeShutdown('once_done');
        process.exit(0);
      })();
    }, delay);
  };

  const leaveSidechannel = async (channel) => {
    try {
      await sc.leave(channel);
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
  };

  const cancelSwap = async (ctx, reason) => {
    try {
      const cancelUnsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.CANCEL,
        tradeId: ctx.tradeId,
        body: { reason: String(reason || 'canceled') },
      });
      const cancelSigned = signSwapEnvelope(cancelUnsigned, signing, { effectiveMinSettlementRefundAfterSec });
      await sc.send(ctx.swapChannel, cancelSigned, { invite: ctx.invite || null });
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
  };

  const cleanupSwap = async (ctx, { reason = null, sendCancel = false } = {}) => {
    if (!ctx || ctx.cleanedUp) return;
    ctx.cleanedUp = true;
    if (ctx.resender) clearInterval(ctx.resender);
    try {
      swaps.delete(ctx.swapChannel);
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
    try {
      pendingSwaps.delete(ctx.swapChannel);
    } catch (_e) {
      process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
    {
      const lockKey = swapChannelToLockKey.get(ctx.swapChannel) || tradeIdToLockKey.get(ctx.tradeId) || null;
      clearRfqLock(lockKey, reason || 'swap_cleanup');
    }
    if (sendCancel) {
      // Best-effort: cancellation is only accepted before escrow creation.
      await cancelSwap(ctx, reason || 'swap timeout');
    }
    const cleanupPatch = resolveMakerCleanupPersistence(ctx, { reason });
    persistTrade(
      ctx.tradeId,
      cleanupPatch,
      'swap_cleanup',
      { trade_id: ctx.tradeId, swap_channel: ctx.swapChannel, reason: reason ? String(reason) : null }
    );
    await leaveSidechannel(ctx.swapChannel);
  };

  const fetchFeeSnapshot = async () => {
    if (!runSwap) {
      return {
        platformFeeBps: 0,
        platformFeeCollector: null,
        tradeFeeBps: 0,
        tradeFeeCollector: null,
      };
    }
    return sol.settlement.feeSnapshot({
      ...(sol.tradeFeeCollector ? { tradeFeeCollector: sol.tradeFeeCollector } : {}),
    });
  };

  const createAndSendTerms = async (ctx) => {
    const nowSec = Math.floor(Date.now() / 1000);

    // Fees are part of the agreed terms (and must match what we advertised in the QUOTE).
    const fees = await fetchFeeSnapshot();

    const termsUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.TERMS,
      tradeId: ctx.tradeId,
      body: {
        pair: ctx.pair,
        direction: getDirectionForPair(ctx.pair),
        app_hash: expectedAppHash,
        btc_sats: ctx.btcSats,
        [getAmountFieldForPair(ctx.pair)]: ctx.usdtAmount,
        ...(isTaoPair(ctx.pair) ? {} : { usdt_decimals: solDecimals }),
        settlement_kind: settlementKind,
        sol_mint: sol.mint,
        sol_recipient: ctx.solRecipient,
        sol_refund: sol.refundAddress,
        sol_refund_after_unix: nowSec + settlementRefundAfterSec,
        platform_fee_bps: fees.platformFeeBps,
        platform_fee_collector: fees.platformFeeCollector || null,
        trade_fee_bps: fees.tradeFeeBps,
        trade_fee_collector: fees.tradeFeeCollector || null,
        ln_receiver_peer: makerPubkey,
        ln_payer_peer: ctx.inviteePubKey,
        terms_valid_until_unix: nowSec + termsValidSec,
      },
    });
    const signed = signSwapEnvelope(termsUnsigned, signing, { effectiveMinSettlementRefundAfterSec });
    const applied = applySwapEnvelope(ctx.trade, signed);
    if (!applied.ok) throw new Error(applied.error);
    ctx.trade = applied.trade;
    ctx.sent.terms = signed;
    await sc.send(ctx.swapChannel, signed, { invite: ctx.invite || null });
    ctx.lastTermsSendAtMs = Date.now();
    process.stdout.write(`${JSON.stringify({ type: 'terms_sent', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel })}\n`);

    persistTrade(
      ctx.tradeId,
      {
        role: 'maker',
        rfq_channel: rfqChannel,
        swap_channel: ctx.swapChannel,
        maker_peer: makerPubkey,
        taker_peer: ctx.inviteePubKey,
        btc_sats: ctx.btcSats,
        usdt_amount: isTaoPair(ctx.pair) ? null : ctx.usdtAmount,
        ...(isTaoPair(ctx.pair) ? { tao_amount_atomic: ctx.usdtAmount } : {}),
        ...(isSolanaSettlement
          ? {
              sol_mint: signed.body.sol_mint,
              sol_program_id: sol?.programId ?? null,
              sol_recipient: signed.body.sol_recipient,
              sol_refund: signed.body.sol_refund,
              sol_refund_after_unix: signed.body.sol_refund_after_unix,
            }
          : {}),
        state: ctx.trade.state,
      },
      'terms_sent',
      signed
    );
  };

  const createInvoiceAndEscrow = async (ctx) => {
    if (ctx.startedSettlement) {
      process.stderr.write(`[maker] SKIP settlement already started trade_id=${ctx.tradeId}\n`);
      return;
    }
    if (maxTrades > 0 && completedTrades >= maxTrades) {
      process.stderr.write(`[maker] capacity reached (${completedTrades}/${maxTrades}), skipping execution\n`);
      return;
    }
    ctx.startedSettlement = true;
    activeTrades += 1;
    ctx.lifecycle.executionStarted = true;
    process.stderr.write(
      `[maker] execution_start trade_id=${ctx.tradeId} ` +
        `btc=${ctx.btcSats} sats (${formatBtcSats(ctx.btcSats)} BTC)` +
        (isTaoPair(ctx.pair) ? ` tao=${formatTaoAtomic(ctx.usdtAmount)} TAO (${ctx.usdtAmount} atomic)` : '') +
        '\n'
    );

    const isRetryableSettlementError = (err) => {
      const message = String(err?.message ?? err ?? '').toLowerCase();
      if (!message) return false;
      const permanentMarkers = [
        'missing ',
        'invalid ',
        'mismatch',
        'must ',
        'requires ',
        'failed to persist',
        'signed envelope invalid',
        'deterministic settlement_id mismatch',
        'refundafterunix too soon',
        'too soon',
        'already exists',
        'duplicate',
        'label',
      ];
      if (permanentMarkers.some((marker) => message.includes(marker))) return false;
      const transientMarkers = [
        'timeout',
        'timed out',
        'temporar',
        'econn',
        'connection reset',
        'connection closed',
        'disconnected',
        'network',
        'socket',
        '429',
        '503',
        '502',
        '504',
        'unavailable',
        'rate limit',
        'transport',
        'rpc',
      ];
      return transientMarkers.some((marker) => message.includes(marker));
    };
    const retryDelayMs = [1000, 2000, 3000];

    if (!ctx.trade?.terms) throw new Error('Missing terms');
    if (ctx.trade?.invoice || ctx.sent.invoice) throw new Error('LN invoice already exists before settlement start');
    if (ctx.trade?.escrow || ctx.sent.escrow) throw new Error('Settlement lock already exists before settlement start');

    const sats = ctx.btcSats;
    if (lnInvoiceExpirySec < 60 || lnInvoiceExpirySec > 3600) {
      process.stderr.write(`[maker] WARN unusual LN invoice expiry trade_id=${ctx.tradeId} expiry_sec=${lnInvoiceExpirySec}\n`);
    }
    let invoice = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        process.stderr.write(`[maker] ln_invoice_create trade_id=${ctx.tradeId} sats=${ctx.btcSats} attempt=${attempt + 1}\n`);
        invoice = await lnInvoice(ln, {
          amountMsat: (BigInt(String(sats)) * 1000n).toString(),
          label: ctx.tradeId,
          description: 'swap',
          expirySec: lnInvoiceExpirySec,
        });
        break;
      } catch (err) {
        const retryable = !ctx.trade?.invoice && !ctx.sent.invoice && attempt < 2 && isRetryableSettlementError(err);
        process.stderr.write(
          `[maker] ERROR: ln_invoice attempt=${attempt + 1} trade_id=${ctx.tradeId} retry=${retryable ? 1 : 0} ` +
            `${err?.stack || err?.message || String(err)}\n`
        );
        if (!retryable) throw err;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs[attempt]));
      }
    }

    const bolt11 = String(invoice?.bolt11 || '').trim();
    const paymentHashHex = String(invoice?.payment_hash || '').trim().toLowerCase();
    if (!bolt11) throw new Error('LN invoice missing bolt11');
    if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) throw new Error('LN invoice missing payment_hash');

    ctx.paymentHashHex = paymentHashHex;

    const decoded = decodeBolt11(bolt11);
    process.stderr.write(
      `[maker] ln_invoice_created trade_id=${ctx.tradeId} payment_hash_hex=${paymentHashHex} expires_at_unix=${decoded.expires_at_unix}\n`
    );
    const lnInvUnsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.LN_INVOICE,
      tradeId: ctx.tradeId,
      body: {
        bolt11,
        payment_hash_hex: paymentHashHex,
        amount_msat: String(BigInt(sats) * 1000n),
        expires_at_unix: decoded.expires_at_unix,
      },
    });
    const lnInvSigned = signSwapEnvelope(lnInvUnsigned, signing, { effectiveMinSettlementRefundAfterSec });
    {
      const r = applySwapEnvelope(ctx.trade, lnInvSigned);
      if (!r.ok) throw new Error(r.error);
      ctx.trade = r.trade;
    }
    ctx.sent.invoice = lnInvSigned;
    ctx.lifecycle.invoiceCreated = true;
    const invoicePersisted = persistTrade(
      ctx.tradeId,
      {
        ln_invoice_bolt11: bolt11,
        ln_payment_hash_hex: paymentHashHex,
        state: ctx.trade.state,
      },
      'ln_invoice_sent',
      lnInvSigned
    );
    if (receipts && !invoicePersisted) {
      throw new Error('Failed to persist LN invoice before send');
    }
    await sc.send(ctx.swapChannel, lnInvSigned, { invite: ctx.invite || null });
    ctx.lastInvoiceSendAtMs = Date.now();
    process.stdout.write(`${JSON.stringify({ type: 'ln_invoice_sent', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel, payment_hash_hex: paymentHashHex })}\n`);

    if (!ctx.paymentHashHex) throw new Error('Missing paymentHashHex');
    if (!ctx.trade?.terms) throw new Error('Missing terms');
    if (!ctx.trade?.terms?.sol_refund_after_unix) throw new Error('Missing refund timing');
    const refundAfterUnix = Number(ctx.trade.terms.sol_refund_after_unix);
    if (!Number.isFinite(refundAfterUnix) || refundAfterUnix <= 0) throw new Error('Invalid sol_refund_after_unix');
    const taoLockCheckpoint = isTaoSettlement
      ? buildTaoLockCheckpoint({
          tradeId: ctx.tradeId,
          rfqId: ctx.rfqId,
          quoteId: ctx.quoteId,
          sender: sol.refundAddress,
          receiver: ctx.solRecipient,
          amountAtomic: String(ctx.usdtAmount),
          refundAfterUnix,
          paymentHashHex,
          htlcAddress: sol.programId,
        })
      : null;
    if (isTaoSettlement) {
      const preLockPersisted = persistTrade(
        ctx.tradeId,
        {
          ln_payment_hash_hex: paymentHashHex,
          tao_settlement_id: taoLockCheckpoint.settlementId,
          tao_htlc_address: taoLockCheckpoint.htlcAddress,
          tao_amount_atomic: taoLockCheckpoint.amountAtomic,
          tao_recipient: taoLockCheckpoint.recipient,
          tao_refund: taoLockCheckpoint.refundAddress,
          tao_refund_after_unix: taoLockCheckpoint.refundAfterUnix,
          state: 'locking',
        },
        'tao_locking',
        {
          payment_hash_hex: paymentHashHex,
          settlement_id: taoLockCheckpoint.settlementId,
          htlc_address: taoLockCheckpoint.htlcAddress,
          amount_atomic: taoLockCheckpoint.amountAtomic,
          recipient: taoLockCheckpoint.recipient,
          refund: taoLockCheckpoint.refundAddress,
          refund_after_unix: taoLockCheckpoint.refundAfterUnix,
          client_salt: taoLockCheckpoint.clientSalt,
        }
      );
      if (receipts && !preLockPersisted) {
        throw new Error('Failed to persist TAO lock checkpoint before broadcast');
      }
      ctx.taoLockPhase = 'locking';
      ctx.taoSettlementId = taoLockCheckpoint.settlementId;
      ctx.taoLockTxId = null;
      ctx.lastLockError = null;
      handleMakerTaoLockStage({
        ctx,
        stage: 'prepare',
        details: {
          payment_hash_hex: paymentHashHex,
          settlement_id: taoLockCheckpoint.settlementId,
          htlc_address: taoLockCheckpoint.htlcAddress,
          amount_atomic: taoLockCheckpoint.amountAtomic,
          refund_after_unix: taoLockCheckpoint.refundAfterUnix,
          recipient: taoLockCheckpoint.recipient,
          refund: taoLockCheckpoint.refundAddress,
        },
        persistTrade,
        log: (line) => process.stderr.write(`${line}\n`),
      });
    }
    const termsForLock = isTaoSettlement
      ? { ...(ctx.trade.terms || {}), client_salt: taoLockCheckpoint.clientSalt }
      : ctx.trade.terms;

    let lock;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (ctx.taoLockTxId) throw new Error('TAO lock tx already exists before retry');
        if (ctx.trade?.escrow || ctx.sent.escrow) throw new Error('Settlement lock proof already exists before retry');
        if (isTaoSettlement) {
          process.stderr.write(
            `[maker] tao_lock_start trade_id=${ctx.tradeId} amount=${ctx.usdtAmount} recipient=${ctx.solRecipient} attempt=${attempt + 1}\n`
          );
        }
        lock = await sol.settlement.lock({
          paymentHashHex,
          amountAtomic: String(ctx.usdtAmount),
          recipient: ctx.solRecipient,
          refundAddress: sol.refundAddress,
          refundAfterUnix,
          terms: termsForLock,
          ...(isTaoSettlement
            ? {
                onStage: ({ stage, ...details }) => {
                  handleMakerTaoLockStage({
                    ctx,
                    stage,
                    details,
                    persistTrade,
                    log: (line) => process.stderr.write(`${line}\n`),
                  });
                },
                onBroadcast: ({ txId, settlementId, clientSalt }) => {
                  ctx.taoLockTxId = txId;
                  const persisted = persistTrade(
                    ctx.tradeId,
                    {
                      tao_settlement_id: settlementId,
                      tao_lock_tx_id: txId,
                      state: STATE.ESCROW,
                    },
                    'tao_lock_broadcast',
                    {
                      payment_hash_hex: paymentHashHex,
                      settlement_id: settlementId,
                      tx_id: txId,
                      client_salt: clientSalt || taoLockCheckpoint.clientSalt,
                    }
                  );
                  if (receipts && !persisted) {
                    throw new Error('Failed to persist TAO lock tx_id immediately after broadcast');
                  }
                },
              }
            : {}),
        });
        break;
      } catch (err) {
        if (isTaoSettlement && !ctx.lastLockError) {
          handleMakerTaoLockStage({
            ctx,
            stage: 'error',
            details: {
              error: err?.message ?? String(err),
            },
            persistTrade,
            log: (line) => process.stderr.write(`${line}\n`),
          });
        }
        const retryable =
          !ctx.taoLockTxId &&
          !ctx.trade?.escrow &&
          !ctx.sent.escrow &&
          attempt < 2 &&
          isRetryableSettlementError(err);
        process.stderr.write(
          `[maker] ERROR: tao_lock attempt=${attempt + 1} trade_id=${ctx.tradeId} retry=${retryable ? 1 : 0} ` +
            `${err?.stack || err?.message || String(err)}\n`
        );
        if (!retryable) throw err;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs[attempt]));
      }
    }
    const settlementId = lock.settlementId;
    const settlementTxId = lock.txId;
    const lockMeta = lock?.metadata && typeof lock.metadata === 'object' ? lock.metadata : {};
    if (isTaoSettlement && taoLockCheckpoint && String(settlementId).toLowerCase() !== String(taoLockCheckpoint.settlementId).toLowerCase()) {
      throw new Error(
        `deterministic settlement_id mismatch (computed=${taoLockCheckpoint.settlementId} provider=${settlementId})`
      );
    }
    if (isTaoSettlement) {
      const persisted = persistTrade(
        ctx.tradeId,
        {
          tao_settlement_id: settlementId,
          tao_lock_tx_id: settlementTxId,
          state: STATE.ESCROW,
        },
        'tao_lock_ack',
        {
          payment_hash_hex: paymentHashHex,
          settlement_id: settlementId,
          tx_id: settlementTxId,
        }
      );
      if (receipts && !persisted) {
        throw new Error('Failed to persist TAO lock acknowledgement');
      }
    }

    const escrowUnsigned = isTaoSettlement
      ? createUnsignedEnvelope({
          v: 1,
          kind: KIND.TAO_HTLC_LOCKED,
          tradeId: ctx.tradeId,
          body: {
            payment_hash_hex: paymentHashHex,
            settlement_id: settlementId,
            htlc_address: String(lockMeta.contract_address || sol.programId).trim(),
            amount_atomic: String(lockMeta.amount_atomic || ctx.usdtAmount),
            refund_after_unix: Number(lockMeta.refund_after_unix || refundAfterUnix),
            recipient: String(lockMeta.receiver || ctx.solRecipient).trim(),
            refund: String(lockMeta.sender || sol.refundAddress).trim(),
            tx_id: settlementTxId,
            fee_snapshot: {
              platform_fee_bps: Number(ctx.trade.terms?.platform_fee_bps || 0),
              platform_fee_collector: ctx.trade.terms?.platform_fee_collector || null,
              trade_fee_bps: Number(ctx.trade.terms?.trade_fee_bps || 0),
              trade_fee_collector: ctx.trade.terms?.trade_fee_collector || null,
            },
          },
        })
      : (() => {
          const vaultAta = String(lockMeta.vault_ata || '').trim();
          if (!vaultAta) throw new Error('settlement metadata missing vault_ata');
          const programId = String(lockMeta.program_id || sol.programId).trim();
          const mint = String(lockMeta.mint || sol.mint).trim();
          const recipient = String(lockMeta.recipient || ctx.solRecipient).trim();
          const refund = String(lockMeta.refund || sol.refundAddress).trim();
          return createUnsignedEnvelope({
            v: 1,
            kind: KIND.SOL_ESCROW_CREATED,
            tradeId: ctx.tradeId,
            body: {
              payment_hash_hex: paymentHashHex,
              program_id: programId,
              escrow_pda: settlementId,
              vault_ata: vaultAta,
              mint,
              amount: String(ctx.usdtAmount),
              refund_after_unix: refundAfterUnix,
              recipient,
              refund,
              tx_sig: settlementTxId,
            },
          });
        })();

    const solEscrowSigned = signSwapEnvelope(escrowUnsigned, signing, { effectiveMinSettlementRefundAfterSec });
    {
      const r = applySwapEnvelope(ctx.trade, solEscrowSigned);
      if (!r.ok) throw new Error(r.error);
      ctx.trade = r.trade;
    }
    const escrowPersisted = isTaoSettlement
      ? persistTrade(
          ctx.tradeId,
          {
            tao_htlc_address: solEscrowSigned.body.htlc_address,
            tao_settlement_id: solEscrowSigned.body.settlement_id,
            tao_amount_atomic: solEscrowSigned.body.amount_atomic,
            tao_refund_after_unix: solEscrowSigned.body.refund_after_unix,
            tao_recipient: solEscrowSigned.body.recipient,
            tao_refund: solEscrowSigned.body.refund,
            tao_lock_tx_id: solEscrowSigned.body.tx_id,
            state: ctx.trade.state,
          },
          'tao_htlc_locked_sent',
          solEscrowSigned
        )
      : persistTrade(
          ctx.tradeId,
          {
            sol_program_id: solEscrowSigned.body.program_id,
            sol_mint: solEscrowSigned.body.mint,
            sol_escrow_pda: solEscrowSigned.body.escrow_pda,
            sol_vault_ata: solEscrowSigned.body.vault_ata,
            sol_refund_after_unix: solEscrowSigned.body.refund_after_unix,
            sol_recipient: solEscrowSigned.body.recipient,
            sol_refund: solEscrowSigned.body.refund,
            state: ctx.trade.state,
          },
          'sol_escrow_sent',
          solEscrowSigned
        );
    if (receipts && !escrowPersisted) {
      throw new Error('Failed to persist settlement lock proof before send');
    }
    ctx.sent.escrow = solEscrowSigned;
    ctx.lifecycle.settlementLocked = true;
    await sc.send(ctx.swapChannel, solEscrowSigned, { invite: ctx.invite || null });
    ctx.lastEscrowSendAtMs = Date.now();
    process.stdout.write(
      `${JSON.stringify({
        type: isTaoSettlement ? 'tao_htlc_locked_sent' : 'sol_escrow_sent',
        trade_id: ctx.tradeId,
        swap_channel: ctx.swapChannel,
        tx_id: isTaoSettlement ? settlementTxId : undefined,
        tx_sig: isTaoSettlement ? undefined : settlementTxId,
      })}\n`
    );
  };

  const startSwapResender = (ctx) => {
    if (ctx.resender) return;
    ctx.resender = setInterval(async () => {
      try {
        if (ctx.done) return;
        if (Date.now() > ctx.deadlineMs) {
          ctx.done = true;
          const reason = `swap timeout (swap-timeout-sec=${swapTimeoutSec})`;
          await cleanupSwap(ctx, { reason, sendCancel: true });
          try {
            clearInterval(ctx.resender);
          } catch (_e) {
            process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
          }
          ctx.resender = null;
          swaps.delete(ctx.swapChannel);
          // Once-mode should never hang indefinitely.
          if (once) die(reason);
          return;
        }
        const nowMs = Date.now();
        const lastRemoteMs = Number(ctx.lastRemoteActivityAtMs || 0);
        const idleMs = lastRemoteMs > 0 ? nowMs - lastRemoteMs : Number.POSITIVE_INFINITY;
        const termsCadenceMs = idleMs > 30_000 ? Math.max(swapResendMs, 20_000) : Math.max(swapResendMs, 10_000);
        const invoiceCadenceMs = idleMs > 30_000 ? Math.max(swapResendMs, 25_000) : Math.max(swapResendMs, 12_000);

        if (ctx.trade.state === STATE.TERMS && ctx.sent.terms && (nowMs - Number(ctx.lastTermsSendAtMs || 0) >= termsCadenceMs)) {
          await sc.send(ctx.swapChannel, ctx.sent.terms, { invite: ctx.invite || null });
          ctx.lastTermsSendAtMs = nowMs;
        }
        if (
          [STATE.ACCEPTED, STATE.INVOICE, STATE.ESCROW].includes(ctx.trade.state) &&
          ctx.sent.invoice &&
          !ctx.trade.ln_paid &&
          (nowMs - Number(ctx.lastInvoiceSendAtMs || 0) >= invoiceCadenceMs)
        ) {
          await sc.send(ctx.swapChannel, ctx.sent.invoice, { invite: ctx.invite || null });
          ctx.lastInvoiceSendAtMs = nowMs;
        }
        if (
          [STATE.INVOICE, STATE.ESCROW].includes(ctx.trade.state) &&
          ctx.sent.escrow &&
          !ctx.trade.ln_paid &&
          (nowMs - Number(ctx.lastEscrowSendAtMs || 0) >= invoiceCadenceMs)
        ) {
          await sc.send(ctx.swapChannel, ctx.sent.escrow, { invite: ctx.invite || null });
          ctx.lastEscrowSendAtMs = nowMs;
        }
      } catch (_e) {
        process.stderr.write(`[maker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
    }, Math.max(swapResendMs, 200));
  };

  sc.on('sidechannel_message', async (evt) => {
    try {
      if (evt?.channel !== rfqChannel && !swaps.has(evt?.channel)) return;
      const msg = evt?.message;
      if (!msg || typeof msg !== 'object') return;
      let duplicateQuoteAcceptIgnored = false;
      if (evt?.channel === rfqChannel && msg.kind === KIND.QUOTE_ACCEPT) {
        const tradeId = String(msg.trade_id || '');
        const quoteId = String(msg.body?.quote_id || '').trim().toLowerCase();
        const swapChannel = tradeId ? swapChannelTemplate.replaceAll('{trade_id}', tradeId) : '';
        const known = quoteId ? quotes.get(quoteId) : null;
        const lockKey =
          known?.lock_key ||
          (quoteId ? quoteIdToLockKey.get(quoteId) : null) ||
          (tradeId ? tradeIdToLockKey.get(tradeId) : null) ||
          (swapChannel ? swapChannelToLockKey.get(swapChannel) : null) ||
          null;
        const lock = lockKey ? rfqLocks.get(lockKey) : null;
        const existing = swapChannel ? swaps.get(swapChannel) : null;
        const pendingInvitee = swapChannel ? pendingSwaps.get(swapChannel) : null;
        const duplicateQuoteAcceptLogTarget = existing || lock || known || null;
        if ((lock?.swapChannel || existing || pendingInvitee) && duplicateQuoteAcceptLogTarget) {
          duplicateQuoteAcceptIgnored = true;
          if (!duplicateQuoteAcceptLogTarget.duplicateQuoteAcceptLogged) {
            process.stderr.write(`[maker] duplicate quote_accept ignored trade_id=${tradeId}\n`);
            duplicateQuoteAcceptLogTarget.duplicateQuoteAcceptLogged = true;
          }
        }
      }
      if (!duplicateQuoteAcceptIgnored) {
        process.stderr.write(`[maker] msg kind=${msg?.kind} trade_id=${msg?.trade_id} channel=${evt?.channel}\n`);
      }

      // Swap channel traffic
      if (swaps.has(evt.channel)) {
        const ctx = swaps.get(evt.channel);
        if (!ctx) return;
        ctx.lastRemoteActivityAtMs = Date.now();
        const v = validateLocalMakerEnvelope(msg, { effectiveMinSettlementRefundAfterSec });
        if (!v.ok) {
          process.stderr.write(`[maker] envelope rejected kind=${msg?.kind} error=${v.error}\n`);
          return;
        }
        if (msg.kind === KIND.ACCEPT && ctx.trade?.state === STATE.ACCEPTED && ctx.startedSettlement) {
          if (!ctx.duplicateAcceptLogged) {
            process.stderr.write(`[maker] SKIP duplicate ACCEPT trade_id=${ctx.tradeId}\n`);
            ctx.duplicateAcceptLogged = true;
          }
          return;
        }
        const prevState = ctx.trade?.state;
        const r = applySwapEnvelope(ctx.trade, msg);
        if (!r.ok) {
          process.stderr.write(`[maker] applySwapEnvelope rejected kind=${msg?.kind} prev_state=${prevState} error=${r.error}\n`);
          return;
        }
        ctx.trade = r.trade;
        process.stderr.write(`[maker] state transition kind=${msg?.kind} ${prevState} -> ${ctx.trade.state}\n`);
        if (msg.kind === KIND.LN_PAID) {
          process.stderr.write(
            `[maker] ln_paid_received trade_id=${ctx.tradeId} payment_hash_hex=${String(msg.body?.payment_hash_hex || 'n/a')}\n`
          );
        }
        if (msg.kind === KIND.TAO_CLAIMED) {
          process.stderr.write(
            `[maker] tao_claimed_received trade_id=${ctx.tradeId} settlement_id=${String(msg.body?.settlement_id || 'n/a')} tx_id=${String(msg.body?.tx_id || 'n/a')}\n`
          );
        }
        if (ctx.trade.state === STATE.CLAIMED) {
          ctx.lifecycle.settlementClaimed = true;
        }

        const statusNote = String(msg.body?.note || '').trim().toLowerCase();
        if (msg.kind === KIND.STATUS && statusNote === 'ready' && ctx.awaitingTakerReady && !ctx.sendingTerms) {
          ctx.sendingTerms = true;
          try {
            process.stderr.write('[maker] taker ready received, sending TERMS\n');
            await createAndSendTerms(ctx);
            ctx.awaitingTakerReady = false;
          } finally {
            ctx.sendingTerms = false;
          }
        }

        // Taker can re-send STATUS after join; once TERMS exists, force a TERMS re-send so both peers converge deterministically.
        if (msg.kind === KIND.STATUS && ctx.trade.state === STATE.TERMS && ctx.sent.terms) {
          await sc.send(ctx.swapChannel, ctx.sent.terms, { invite: ctx.invite || null });
          ctx.lastTermsSendAtMs = Date.now();
        }

        process.stderr.write(
          `[maker] gate check kind=${msg.kind} state=${ctx.trade.state} runSwap=${runSwap} started=${ctx.startedSettlement}\n`
        );
        if (msg.kind === KIND.ACCEPT && ctx.trade.state === STATE.ACCEPTED && runSwap) {
          await createInvoiceAndEscrow(ctx);
        }

        if ([STATE.CLAIMED, STATE.REFUNDED, STATE.CANCELED].includes(ctx.trade.state) && !ctx.done) {
          ctx.done = true;
          done = true;
          const evtType =
            ctx.trade.state === STATE.CLAIMED ? 'swap_done' : (ctx.trade.state === STATE.REFUNDED ? 'swap_refunded' : 'swap_canceled');
          process.stdout.write(
            `${JSON.stringify({ type: evtType, trade_id: ctx.tradeId, swap_channel: ctx.swapChannel, state: ctx.trade.state })}\n`
          );
          if (ctx.trade.state === STATE.CLAIMED) {
            completedTrades += 1;
            process.stdout.write(`[maker] completed trades: ${completedTrades}\n`);
            if (maxTrades && completedTrades >= maxTrades && !shouldStop) {
              if (autoAnnounceTimer) {
                clearInterval(autoAnnounceTimer);
                autoAnnounceTimer = null;
                process.stderr.write('[maker] max trades reached, stopping auto announce timer\n');
              }
              shouldStop = true;
              process.stderr.write('[maker] reached max trades, stopping new trades\n');
            }
          }
          if (activeTrades > 0) {
            activeTrades -= 1;
          }
          const endTs = Date.now();
          process.stdout.write(
            JSON.stringify({
              type: 'swap_summary',
              trade_id: ctx.tradeId,
              swap_channel: ctx.swapChannel,
              state: ctx.trade.state,
              settlement: {
                type: ctx.settlementKind || settlementKind || null,
              },
              path: ctx.initiationPath,
              timing: {
                start_ts: ctx.lifecycle.startTs,
                end_ts: endTs,
                duration_ms: endTs - ctx.lifecycle.startTs,
              },
              stages: {
                execution_started: ctx.lifecycle.executionStarted,
                invoice_created: ctx.lifecycle.invoiceCreated,
                settlement_locked: ctx.lifecycle.settlementLocked,
                settlement_claimed: ctx.lifecycle.settlementClaimed,
              },
            }) + '\n'
          );
          const terminalPatch = { state: ctx.trade.state };
          if (isTaoSettlement && msg?.kind === KIND.TAO_CLAIMED) {
            terminalPatch.tao_settlement_id = msg.body?.settlement_id || null;
            terminalPatch.tao_claim_tx_id = msg.body?.tx_id || null;
            terminalPatch.ln_payment_hash_hex = msg.body?.payment_hash_hex || null;
          }
          if (isTaoSettlement && msg?.kind === KIND.TAO_REFUNDED) {
            terminalPatch.tao_settlement_id = msg.body?.settlement_id || null;
            terminalPatch.tao_refund_tx_id = msg.body?.tx_id || null;
            terminalPatch.ln_payment_hash_hex = msg.body?.payment_hash_hex || null;
          }
          persistTrade(ctx.tradeId, terminalPatch, evtType, {
            trade_id: ctx.tradeId,
            state: ctx.trade.state,
          });
          await cleanupSwap(ctx, { reason: ctx.trade.state === STATE.CLAIMED ? 'swap_done' : String(ctx.trade.state).toLowerCase() });
          maybeExit();
        }
        return;
      }

      if (msg.kind === KIND.RFQ) {
        if (shouldStop) {
          process.stderr.write('[maker] max trades reached — ignoring new RFQs\n');
          return;
        }
        const v = validateLocalMakerEnvelope(msg, { effectiveMinSettlementRefundAfterSec });
        const logRfqEarlyReturn = (reason, extra = {}) => {
          const body = msg?.body && typeof msg.body === 'object' ? msg.body : {};
          process.stderr.write(
            `${JSON.stringify({
              type: 'rfq_skip',
              reason,
              trade_id: msg?.trade_id ?? null,
              rfq_id: extra.rfq_id ?? null,
              settlement_kind: body.settlement_kind ?? null,
              settlement_refund_after_sec: body.settlement_refund_after_sec ?? null,
              pair: extra.pair ?? body.pair ?? null,
              btc_sats: body.btc_sats ?? null,
              tao_amount_atomic: body.tao_amount_atomic ?? null,
              ...extra,
            })}\n`
          );
        };
        if (!v.ok) {
          logRfqEarlyReturn('invalid_envelope', { validation_error: v.error || null });
          return;
        }
        const rfqAppHash = String(msg?.body?.app_hash || '').trim().toLowerCase();
        if (rfqAppHash !== expectedAppHash) {
          logRfqEarlyReturn('app_hash_mismatch');
          if (debug) process.stderr.write(`[maker] skip rfq app_hash mismatch trade_id=${msg.trade_id}\n`);
          return;
        }
        const rfqUnsigned = stripSignature(msg);
        const rfqId = hashUnsignedEnvelope(rfqUnsigned);
        const pair = normalizePair(msg.body?.pair || PAIR.BTC_LN__USDT_SOL);
        const rfqAmountAtomic = normalizeAmountString(getAmountForPair(msg.body, pair, { allowLegacyTaoFallback: true }));
        const rfqBtc = Number(msg.body?.btc_sats);
        const rfqTaoAtomic = rfqAmountAtomic;
        persistTrade(
          String(msg.trade_id || '').trim(),
          {
            role: 'maker',
            rfq_channel: rfqChannel,
            maker_peer: makerPubkey,
            taker_peer: String(msg.signer || '').trim().toLowerCase() || null,
            btc_sats: msg.body?.btc_sats ?? null,
            usdt_amount: isTaoPair(pair) ? null : rfqAmountAtomic,
            ...(isTaoPair(pair) ? { tao_amount_atomic: rfqAmountAtomic } : {}),
            sol_mint: String(msg.body?.sol_mint || '').trim() || null,
            sol_recipient: String(msg.body?.sol_recipient || '').trim() || null,
            state: STATE.INIT,
          },
          'rfq_received',
          msg
        );
        process.stderr.write(
          `[maker] rfq_received rfq_id=${rfqId} trade_id=${String(msg.trade_id || '').trim() || 'n/a'} ` +
            `rfq_channel=${rfqChannel} settlement_kind=${String(msg.body?.settlement_kind || '').trim() || 'n/a'} ` +
            `settlement_refund_after_sec=${msg.body?.settlement_refund_after_sec ?? 'n/a'} ` +
            `btc=${rfqBtc} sats (${formatBtcSats(rfqBtc)} BTC)` +
            (isTaoPair(pair) ? ` tao=${formatTaoAtomic(rfqTaoAtomic)} TAO (${rfqTaoAtomic} atomic)` : '') +
            '\n'
        );
        if (
          !withinBounds(rfqBtc, minBtcSats, maxBtcSats) ||
          !withinBounds(BigInt(rfqTaoAtomic), minTaoAtomic, maxTaoAtomic)
        ) {
          process.stderr.write(
            `[maker] SKIP rfq size_out_of_bounds ` +
              `btc=${rfqBtc} sats (${formatBtcSats(rfqBtc)} BTC)` +
              (isTaoPair(pair) ? ` tao=${formatTaoAtomic(rfqTaoAtomic)} TAO (${rfqTaoAtomic} atomic)` : '') +
              '\n'
          );
          return;
        }

        if (msg.body?.valid_until_unix !== undefined) {
          const nowSec = Math.floor(Date.now() / 1000);
          if (Number(msg.body.valid_until_unix) <= nowSec) {
            logRfqEarlyReturn('expired_rfq', { rfq_id: rfqId });
            if (debug) process.stderr.write(`[maker] skip expired rfq trade_id=${msg.trade_id} rfq_id=${rfqId}\n`);
            return;
          }
        }

        const solRecipient = msg.body?.sol_recipient ? String(msg.body.sol_recipient).trim() : '';
        if (
          shouldSkipMissingSolRecipient({
            runSwap,
            makerSettlementKind: settlementKind,
            pair,
            solRecipient,
          })
        ) {
          logRfqEarlyReturn('missing_sol_recipient', { rfq_id: rfqId });
          if (debug) process.stderr.write(`[maker] skip rfq missing sol_recipient trade_id=${msg.trade_id} rfq_id=${rfqId}\n`);
          return;
        }
        const lockKey = buildRfqLockKey(msg);
        const lockNowMs = Date.now();
        const lockNowSec = Math.floor(lockNowMs / 1000);
        const existingLock = rfqLocks.get(lockKey);
        const existingQuoteEnvelope =
          existingLock && existingLock.signedQuote ? parseSignedEnvelopeLike(existingLock.signedQuote) : null;
        const existingQuoteBody =
          existingQuoteEnvelope && typeof existingQuoteEnvelope.body === 'object' ? existingQuoteEnvelope.body : null;
        process.stderr.write(
          `[maker] quote_decision rfq_id=${rfqId} trade_id=${String(msg.trade_id || '').trim() || 'n/a'} ` +
            `existing_lock=${existingLock ? 'yes' : 'no'} existing_quote_id=${existingLock?.quoteId || 'n/a'} ` +
            `existing_settlement_kind=${String(existingQuoteBody?.settlement_kind || '').trim() || 'n/a'} ` +
            `existing_settlement_refund_after_sec=${existingQuoteBody?.settlement_refund_after_sec ?? 'n/a'} ` +
            `maker_settlement_refund_after_sec=${settlementRefundAfterSec} ` +
            `btc=${rfqBtc} sats (${formatBtcSats(rfqBtc)} BTC)` +
            (isTaoPair(pair) ? ` tao=${formatTaoAtomic(rfqTaoAtomic)} TAO (${rfqTaoAtomic} atomic)` : '') +
            '\n'
        );
        if (existingLock) {
          existingLock.lastSeenMs = lockNowMs;
          const quotedUntil = Number(existingLock.quoteValidUntilUnix || 0);
          if (
            existingLock.state === 'quoted' &&
            existingLock.signedQuote &&
            Number.isFinite(quotedUntil) &&
            quotedUntil > lockNowSec
          ) {
            const reuseResult = await maybeReuseExistingQuote({
              existingLock,
              pair,
              settlementKind,
              settlementRefundAfterSec,
              nowMs: lockNowMs,
              sendQuote: async (signedQuote) => {
                process.stderr.write(
                  `[maker] reuse_quote begin rfq_id=${rfqId} quote_id=${existingLock.quoteId || 'n/a'}\n`
                );
                ensureOk(await sc.send(rfqChannel, signedQuote), 'resend quote');
                process.stderr.write(
                  `[maker] reuse_quote sent rfq_id=${rfqId} quote_id=${existingLock.quoteId || 'n/a'}\n`
                );
              },
            });
            if (reuseResult.cleared) {
              clearRfqLock(lockKey, 'quote_policy_changed_repost');
            } else {
              logRfqEarlyReturn('resend_existing_quote', { rfq_id: rfqId, quote_id: existingLock.quoteId });
              if (debug) {
                process.stderr.write(
                  `[maker] resend existing quote trade_id=${msg.trade_id} rfq_id=${rfqId} quote_id=${existingLock.quoteId}\n`
                );
              }
              return;
            }
          }
          const currentLock = rfqLocks.get(lockKey);
          if (currentLock && (currentLock.state === 'accepting' || currentLock.state === 'swapping')) {
            logRfqEarlyReturn('repost_while_in_flight', { rfq_id: rfqId, state: currentLock.state });
            if (debug) {
              process.stderr.write(`[maker] skip rfq repost while in-flight trade_id=${msg.trade_id} state=${currentLock.state}\n`);
            }
            return;
          }
          if (currentLock && currentLock.state === 'quoted' && Number.isFinite(quotedUntil) && quotedUntil <= lockNowSec) {
            clearRfqLock(lockKey, 'quote_expired_repost');
          }
        }
        if (getRemainingCapacity() <= 0) {
          process.stderr.write(
            `[maker] SKIP rfq no remaining capacity remaining=0 completed=${completedTrades} active=${activeTrades} max=${maxTrades}\n`
          );
          return;
        }
        if (maxTrades > 0 && activeTrades >= maxTrades) {
          process.stderr.write(
            `[maker] SKIP rfq active trade limit reached active=${activeTrades} max=${maxTrades}\n`
          );
          return;
        }

        // Pre-filtering: only quote if we can meet the RFQ fee ceilings.
        const fees = await fetchFeeSnapshot();
        const rfqMaxPlatformFeeBps =
          msg.body?.max_platform_fee_bps !== undefined && msg.body?.max_platform_fee_bps !== null
            ? Number(msg.body.max_platform_fee_bps)
            : null;
        const rfqMaxTradeFeeBps =
          msg.body?.max_trade_fee_bps !== undefined && msg.body?.max_trade_fee_bps !== null
            ? Number(msg.body.max_trade_fee_bps)
            : null;
        const rfqMaxTotalFeeBps =
          msg.body?.max_total_fee_bps !== undefined && msg.body?.max_total_fee_bps !== null
            ? Number(msg.body.max_total_fee_bps)
            : null;
        if (rfqMaxPlatformFeeBps !== null && Number.isFinite(rfqMaxPlatformFeeBps) && fees.platformFeeBps > rfqMaxPlatformFeeBps) {
          logRfqEarlyReturn('platform_fee_cap_exceeded', {
            rfq_id: rfqId,
            platform_fee_bps: fees.platformFeeBps,
            max_platform_fee_bps: rfqMaxPlatformFeeBps,
          });
          if (debug) process.stderr.write(`[maker] skip rfq fee cap: platform_fee_bps=${fees.platformFeeBps} > max=${rfqMaxPlatformFeeBps}\n`);
          return;
        }
        if (rfqMaxTradeFeeBps !== null && Number.isFinite(rfqMaxTradeFeeBps) && fees.tradeFeeBps > rfqMaxTradeFeeBps) {
          logRfqEarlyReturn('trade_fee_cap_exceeded', {
            rfq_id: rfqId,
            trade_fee_bps: fees.tradeFeeBps,
            max_trade_fee_bps: rfqMaxTradeFeeBps,
          });
          if (debug) process.stderr.write(`[maker] skip rfq fee cap: trade_fee_bps=${fees.tradeFeeBps} > max=${rfqMaxTradeFeeBps}\n`);
          return;
        }
        if (
          rfqMaxTotalFeeBps !== null &&
          Number.isFinite(rfqMaxTotalFeeBps) &&
          fees.platformFeeBps + fees.tradeFeeBps > rfqMaxTotalFeeBps
        ) {
          logRfqEarlyReturn('total_fee_cap_exceeded', {
            rfq_id: rfqId,
            total_fee_bps: fees.platformFeeBps + fees.tradeFeeBps,
            max_total_fee_bps: rfqMaxTotalFeeBps,
          });
          if (debug) {
            process.stderr.write(
              `[maker] skip rfq fee cap: total_fee_bps=${fees.platformFeeBps + fees.tradeFeeBps} > max=${rfqMaxTotalFeeBps}\n`
            );
          }
          return;
        }

        if (getPairSettlementKind(pair) !== settlementKind) {
          logRfqEarlyReturn('pair_settlement_mismatch', {
            rfq_id: rfqId,
            pair,
            maker_settlement_kind: settlementKind,
          });
          if (debug) process.stderr.write(`[maker] skip rfq pair/settlement mismatch pair=${pair} settlement=${settlementKind}\n`);
          return;
        }
        // Pre-filtering: only quote if we can meet the RFQ refund-window preference (seconds).
        if (isTaoPair(pair)) {
          const rfqRefundWindowSec =
            msg.body?.settlement_refund_after_sec !== undefined && msg.body?.settlement_refund_after_sec !== null
              ? Number(msg.body.settlement_refund_after_sec)
              : null;
          if (
            rfqRefundWindowSec !== null &&
            Number.isFinite(rfqRefundWindowSec) &&
            settlementRefundAfterSec !== rfqRefundWindowSec
          ) {
            logRfqEarlyReturn('settlement_refund_window_mismatch', {
              rfq_id: rfqId,
              pair,
              requested_settlement_refund_after_sec: rfqRefundWindowSec,
              maker_settlement_refund_after_sec: settlementRefundAfterSec,
            });
            if (debug) {
              process.stderr.write(
                `[maker] skip rfq settlement refund window: want=${rfqRefundWindowSec}s have=${settlementRefundAfterSec}s\n`
              );
            }
            return;
          }
        } else {
          const rfqMinRefundWindowSec =
            msg.body?.min_sol_refund_window_sec !== undefined && msg.body?.min_sol_refund_window_sec !== null
              ? Number(msg.body.min_sol_refund_window_sec)
              : null;
          const rfqMaxRefundWindowSec =
            msg.body?.max_sol_refund_window_sec !== undefined && msg.body?.max_sol_refund_window_sec !== null
              ? Number(msg.body.max_sol_refund_window_sec)
              : null;
          if (
            rfqMinRefundWindowSec !== null &&
            Number.isFinite(rfqMinRefundWindowSec) &&
            settlementRefundAfterSec < rfqMinRefundWindowSec
          ) {
            logRfqEarlyReturn('refund_window_too_short', {
              rfq_id: rfqId,
              pair,
              min_sol_refund_window_sec: rfqMinRefundWindowSec,
              maker_settlement_refund_after_sec: settlementRefundAfterSec,
            });
            if (debug) {
              process.stderr.write(
                `[maker] skip rfq refund window: want>=${rfqMinRefundWindowSec}s have=${settlementRefundAfterSec}s\n`
              );
            }
            return;
          }
          if (
            rfqMaxRefundWindowSec !== null &&
            Number.isFinite(rfqMaxRefundWindowSec) &&
            settlementRefundAfterSec > rfqMaxRefundWindowSec
          ) {
            logRfqEarlyReturn('refund_window_too_long', {
              rfq_id: rfqId,
              pair,
              max_sol_refund_window_sec: rfqMaxRefundWindowSec,
              maker_settlement_refund_after_sec: settlementRefundAfterSec,
            });
            if (debug) {
              process.stderr.write(
                `[maker] skip rfq refund window: want<=${rfqMaxRefundWindowSec}s have=${settlementRefundAfterSec}s\n`
              );
            }
            return;
          }
        }
        let quoteUsdtAmount = String(getAmountForPair(msg.body, pair) || '').trim();
        if (!quoteUsdtAmount) quoteUsdtAmount = '0';
        if (!/^[0-9]+$/.test(quoteUsdtAmount)) {
          logRfqEarlyReturn('invalid_amount', { rfq_id: rfqId, pair });
          if (debug) process.stderr.write(`[maker] skip rfq invalid amount trade_id=${msg.trade_id}\n`);
          return;
        }
        if (quoteUsdtAmount === '0') {
          // Negotiated flow requires explicit amounts; no oracle-priced/open RFQs.
          logRfqEarlyReturn('open_amount_unsupported', { rfq_id: rfqId, pair });
          if (debug) process.stderr.write(`[maker] skip rfq open amount unsupported trade_id=${msg.trade_id}\n`);
          return;
        }

        // Quote at chosen terms.
        const nowSec = Math.floor(Date.now() / 1000);
        const quoteValidUntilUnix = nowSec + quoteValidSec;
        const quoteUnsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.QUOTE,
          tradeId: String(msg.trade_id),
          body: {
            rfq_id: rfqId,
            pair,
            direction: getDirectionForPair(pair),
            app_hash: expectedAppHash,
            btc_sats: msg.body.btc_sats,
            [getAmountFieldForPair(pair)]: quoteUsdtAmount,
            settlement_kind: settlementKind,
            // Pre-filtering: fee preview (binding fees are still in TERMS).
            platform_fee_bps: fees.platformFeeBps,
            platform_fee_collector: fees.platformFeeCollector || null,
            trade_fee_bps: fees.tradeFeeBps,
            trade_fee_collector: fees.tradeFeeCollector || null,
            [getQuoteRefundFieldForPair(pair)]: settlementRefundAfterSec,
            ...(runSwap ? { sol_mint: sol.mint, sol_recipient: solRecipient } : {}),
            valid_until_unix: quoteValidUntilUnix,
          },
        });
        const quoteId = hashUnsignedEnvelope(quoteUnsigned);
        const signed = signSwapEnvelope(quoteUnsigned, signing, { effectiveMinSettlementRefundAfterSec });
        process.stderr.write(
          `[maker] new_quote begin rfq_id=${rfqId} quote_id=${quoteId} settlement_kind=${settlementKind} ` +
            `settlement_refund_after_sec=${isTaoPair(pair) ? settlementRefundAfterSec : 'n/a'} ` +
            `btc=${msg.body.btc_sats} sats (${formatBtcSats(msg.body.btc_sats)} BTC)` +
            (isTaoPair(pair) ? ` tao=${formatTaoAtomic(quoteUsdtAmount)} TAO (${quoteUsdtAmount} atomic)` : '') +
            '\n'
        );
        const sent = ensureOk(await sc.send(rfqChannel, signed), 'send quote');
        process.stderr.write(`[maker] new_quote sent rfq_id=${rfqId} quote_id=${quoteId}\n`);
        if (debug) process.stderr.write(`[maker] quoted trade_id=${msg.trade_id} rfq_id=${rfqId} quote_id=${quoteId} sent=${sent.type}\n`);
        quotes.set(quoteId, {
          rfq_id: rfqId,
          rfq_signer: String(msg.signer || '').trim().toLowerCase(),
          trade_id: String(msg.trade_id),
          pair,
          btc_sats: msg.body.btc_sats,
          usdt_amount: quoteUsdtAmount,
          platform_fee_bps: fees.platformFeeBps,
          platform_fee_collector: fees.platformFeeCollector || null,
          trade_fee_bps: fees.tradeFeeBps,
          trade_fee_collector: fees.tradeFeeCollector || null,
          [getQuoteRefundFieldForPair(pair)]: settlementRefundAfterSec,
          sol_recipient: solRecipient,
          sol_mint: runSwap ? sol.mint : (msg.body?.sol_mint ? String(msg.body.sol_mint).trim() : ''),
          lock_key: lockKey,
        });
        rfqLocks.set(lockKey, {
          key: lockKey,
          state: 'quoted',
          tradeId: String(msg.trade_id),
          rfqSigner: String(msg.signer || '').trim().toLowerCase(),
          quoteId,
          signedQuote: signed,
          quoteValidUntilUnix,
          swapChannel: null,
          inviteePubKey: null,
          lockDeadlineMs: 0,
          createdAtMs: lockNowMs,
          lastSeenMs: lockNowMs,
          lastQuoteSendAtMs: lockNowMs,
        });
        quoteIdToLockKey.set(quoteId, lockKey);
        tradeIdToLockKey.set(String(msg.trade_id), lockKey);
        return;
      }

      if (msg.kind === KIND.QUOTE_ACCEPT) {
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const quoteId = String(msg.body.quote_id || '').trim().toLowerCase();
        const rfqId = String(msg.body.rfq_id || '').trim().toLowerCase();
        const known = quotes.get(quoteId);
        if (!known) return;
        if (known.rfq_id !== rfqId) return;
        const lockKey = known.lock_key || quoteIdToLockKey.get(quoteId) || null;
        const lock = lockKey ? rfqLocks.get(lockKey) : null;

        const tradeId = String(msg.trade_id);
        if (String(known.trade_id) !== tradeId) return;
        const swapChannel = swapChannelTemplate.replaceAll('{trade_id}', tradeId);
        const inviteePubKey = String(msg.signer || '').trim().toLowerCase();
        if (!inviteePubKey) return;
        // Prevent quote hijacking: only the original RFQ signer is allowed to accept its quote.
        if (known.rfq_signer && inviteePubKey !== String(known.rfq_signer).trim().toLowerCase()) return;

        // If a swap is already in-flight for this trade, treat quote_accept as a retry signal.
        const existing = swaps.get(swapChannel);
        const pendingInvitee = pendingSwaps.get(swapChannel);
        const isRetry = Boolean(existing || pendingInvitee);
        if (shouldStop && !isRetry) {
          process.stderr.write('[maker] reached max trades, ignoring new quote accepts\n');
          return;
        }
        if (existing) {
          if (String(existing.inviteePubKey || '').trim().toLowerCase() !== inviteePubKey) return;
        }
        if (pendingInvitee) {
          if (String(pendingInvitee || '').trim().toLowerCase() !== inviteePubKey) return;
        }
        if (!isRetry) {
          // Mark early to dedupe concurrent QUOTE_ACCEPT handlers (node event handlers are not awaited).
          pendingSwaps.set(swapChannel, inviteePubKey);
          if (lock) {
            lock.state = 'accepting';
            lock.inviteePubKey = inviteePubKey;
            lock.swapChannel = swapChannel;
            lock.lockDeadlineMs = Date.now() + Math.max(1, swapTimeoutSec) * 1000;
            lock.lastSeenMs = Date.now();
            tradeIdToLockKey.set(tradeId, lockKey);
            swapChannelToLockKey.set(swapChannel, lockKey);
          }
        }

        if (isRetry) {
          const nowMs = Date.now();
          const resendFloorMs = Math.max(5_000, retryResendMinMs);
          let resent = 0;
          if (existing?.sent?.swap_invite && nowMs - Number(existing.lastInviteSendAtMs || 0) >= resendFloorMs) {
            ensureOk(await sc.send(rfqChannel, existing.sent.swap_invite), 'resend swap_invite');
            existing.lastInviteSendAtMs = nowMs;
            resent += 1;
            process.stdout.write(
              `${JSON.stringify({ type: 'swap_invite_resent', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId, swap_channel: swapChannel })}\n`
            );
          }
          if (existing?.sent?.terms && nowMs - Number(existing.lastTermsSendAtMs || 0) >= resendFloorMs) {
            ensureOk(await sc.send(swapChannel, existing.sent.terms, { invite: existing.invite || null }), 'resend terms');
            existing.lastTermsSendAtMs = nowMs;
            resent += 1;
            process.stdout.write(
              `${JSON.stringify({ type: 'terms_resent', trade_id: tradeId, swap_channel: swapChannel })}\n`
            );
          }
          const duplicateQuoteAcceptLogTarget = existing || lock || known;
          if (duplicateQuoteAcceptLogTarget && !duplicateQuoteAcceptLogTarget.duplicateQuoteAcceptLogged) {
            process.stderr.write(`[maker] duplicate quote_accept ignored trade_id=${tradeId}\n`);
            duplicateQuoteAcceptLogTarget.duplicateQuoteAcceptLogged = true;
          }
          return;
        }

        // Build welcome + invite signed by this peer (local keypair signing).
        const issuedAt = Date.now();
        const welcome = createSignedWelcome(
          { channel: swapChannel, ownerPubKey: makerPubkey, text: `swap ${tradeId}`, issuedAt, version: 1 },
          (payload) => signPayloadHex(payload, signing.secHex)
        );
        const invite = createSignedInvite(
          {
            channel: swapChannel,
            inviteePubKey,
            inviterPubKey: makerPubkey,
            inviterAddress: null,
            issuedAt,
            ttlMs: inviteTtlSec * 1000,
            version: 1,
          },
          (payload) => signPayloadHex(payload, signing.secHex),
          { welcome }
        );

        const swapInviteUnsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.SWAP_INVITE,
          tradeId,
          body: {
            rfq_id: rfqId,
            quote_id: quoteId,
            swap_channel: swapChannel,
            owner_pubkey: makerPubkey,
            invite,
            welcome,
          },
        });
        const swapInviteSigned = signSwapEnvelope(swapInviteUnsigned, signing, { effectiveMinSettlementRefundAfterSec });

        try {
          ensureOk(await sc.send(rfqChannel, swapInviteSigned), 'send swap_invite');
          ensureOk(await sc.join(swapChannel, { welcome }), `join ${swapChannel}`);
          ensureOk(await sc.subscribe([swapChannel]), `subscribe ${swapChannel}`);
          process.stdout.write(
            `${JSON.stringify({ type: 'swap_invite_sent', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId, swap_channel: swapChannel })}\n`
          );

          if (!runSwap) {
            if (once) await leaveSidechannel(swapChannel);
            done = true;
            maybeExit();
            return;
          }

          const ctx = {
            tradeId,
            rfqId,
            quoteId,
            swapChannel,
            settlementKind,
            inviteePubKey,
            pair: buildSettlementContext({ settlementKind, pair: known.pair }).pair,
            invite,
            btcSats: Number(known.btc_sats),
            usdtAmount: String(known.usdt_amount),
            solRecipient: String(known.sol_recipient),
            trade: createInitialTrade(tradeId),
            sent: {},
            startedSettlement: false,
            initiationPath: 'rfq',
            lifecycle: {
              startTs: Date.now(),
              executionStarted: false,
              invoiceCreated: false,
              settlementLocked: false,
              settlementClaimed: false,
            },
            paymentHashHex: null,
            done: false,
            deadlineMs: Date.now() + swapTimeoutSec * 1000,
            resender: null,
            lastRemoteActivityAtMs: Date.now(),
            lastInviteSendAtMs: 0,
            lastTermsSendAtMs: 0,
            lastInvoiceSendAtMs: 0,
            lastEscrowSendAtMs: 0,
            awaitingTakerReady: true,
            sendingTerms: false,
          };
          ctx.sent.swap_invite = swapInviteSigned;
          ctx.lastInviteSendAtMs = Date.now();
          swaps.set(swapChannel, ctx);
          if (lock) {
            lock.state = 'swapping';
            lock.swapChannel = swapChannel;
            lock.inviteePubKey = inviteePubKey;
            lock.lockDeadlineMs = Date.now() + Math.max(1, swapTimeoutSec) * 1000;
            lock.lastSeenMs = Date.now();
            swapChannelToLockKey.set(swapChannel, lockKey);
          }

          // Begin swap: wait for taker readiness on swap:* before sending TERMS.
          process.stderr.write('[maker] waiting for taker ready before sending TERMS\n');
          startSwapResender(ctx);

          persistTrade(
            tradeId,
            {
              role: 'maker',
              rfq_channel: rfqChannel,
              swap_channel: swapChannel,
              maker_peer: makerPubkey,
              taker_peer: inviteePubKey,
              btc_sats: ctx.btcSats,
              usdt_amount: isTaoPair(ctx.pair) ? null : ctx.usdtAmount,
              ...(isTaoPair(ctx.pair) ? { tao_amount_atomic: ctx.usdtAmount } : {}),
              ...(isSolanaSettlement
                ? {
                    sol_mint: runSwap ? sol.mint : null,
                    sol_recipient: ctx.solRecipient,
                  }
                : {}),
              state: ctx.trade.state,
            },
            'swap_started',
            { trade_id: tradeId, swap_channel: swapChannel }
          );
        } catch (err) {
          // If invite/swap startup fails before the swap loop settles, roll back lock to allow a clean retry.
          if (lock) {
            lock.state = 'quoted';
            lock.inviteePubKey = null;
            lock.swapChannel = null;
            lock.lockDeadlineMs = 0;
            lock.lastSeenMs = Date.now();
          }
          swapChannelToLockKey.delete(swapChannel);
          throw err;
        } finally {
          pendingSwaps.delete(swapChannel);
        }
      }
    } catch (err) {
      process.stderr.write(`[maker] ERROR: ${err?.stack || err?.message || String(err)}\n`);
    }
  });

  process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'maker', rfq_channel: rfqChannel, pubkey: makerPubkey })}\n`);
  if (autoAnnounceIntervalSec) {
    const jitterMs = Math.floor(Math.random() * 2000);
    const autoAnnounceIntervalMs = autoAnnounceIntervalSec * 1000 + jitterMs;

    process.stderr.write(`[maker] auto announce jitter applied (+${jitterMs}ms)\n`);

    autoAnnounceTimer = setInterval(async () => {
      try {
        if (maxTrades > 0 && completedTrades >= maxTrades) return;
        if (shouldStop) return;

        const ok = await runAutoAnnounce();

        if (ok) {
          process.stderr.write('[maker] auto announce fired (jittered)\n');
        }
      } catch (e) {
        process.stderr.write(`[maker] auto announce error: ${e?.message || e}\n`);
      }
    }, autoAnnounceIntervalMs);
  }
  // Keep process alive.
  await new Promise(() => {});
}

const isDirectRun = (() => {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
  return import.meta.url === entry;
})();

if (isDirectRun) {
  main().catch((err) => die(err?.stack || err?.message || String(err)));
}
