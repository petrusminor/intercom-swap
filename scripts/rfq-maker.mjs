#!/usr/bin/env node
import process from 'node:process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
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
  if (settlementId) ctx.taoSettlementId = settlementId;
  if (txId) ctx.taoLockTxId = txId;
  if (errorMessage) ctx.lastLockError = errorMessage;

  const eventKindByStage = {
    prepare: 'tao_lock_prepare',
    rpc_send: 'tao_lock_rpc_send',
    tx_hash: 'tao_lock_tx_hash',
    wait_confirm: 'tao_lock_wait_confirm',
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
      JSON.stringify({
        type: 'tao_lock_stage',
        trade_id: tradeId,
        stage: normalizedStage,
        settlement_id: settlementId,
        tx_id: txId,
        error: errorMessage,
      })
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
    } catch (_e) {}
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
    taoHtlcAddress: process.env.TAO_EVM_HTLC_ADDRESS || '',
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

  if (runSwap) {
    if (isSolanaSettlement) {
      if (!solKeypairPath) die('Missing --solana-keypair (required when --run-swap 1 and --settlement solana)');
      if (!solMintStr) die('Missing --solana-mint (required when --run-swap 1 and --settlement solana)');
    }
    if (isTaoSettlement) {
      if (!process.env.TAO_EVM_PRIVATE_KEY) die('Missing TAO_EVM_PRIVATE_KEY (required when --settlement tao-evm)');
      if (!process.env.TAO_EVM_HTLC_ADDRESS) die('Missing TAO_EVM_HTLC_ADDRESS (required when --settlement tao-evm)');
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
        if (debug) process.stderr.write(`[maker] receipts persist error: ${err?.message ?? String(err)}\n`);
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
            rpcUrl: process.env.TAO_EVM_RPC_URL || 'https://lite.chain.opentensor.ai',
            chainId: 964,
            privateKey: process.env.TAO_EVM_PRIVATE_KEY || '',
            confirmations: 1,
            htlcAddress: process.env.TAO_EVM_HTLC_ADDRESS || '',
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
    } catch (_e) {}
    for (const ctx of Array.from(swaps.values())) {
      try {
        if (ctx?.resender) clearInterval(ctx.resender);
      } catch (_e) {}
    }
    try {
      const st = await sc.stats();
      const channels = Array.isArray(st?.channels) ? st.channels : [];
      for (const ch of channels) {
        const channel = String(ch || '').trim();
        if (channel.startsWith('swap:')) {
          try {
            await sc.leave(channel);
          } catch (_e) {}
        }
      }
    } catch (_e) {}
    for (const swapChannel of Array.from(swaps.keys())) {
      try {
        await sc.leave(swapChannel);
      } catch (_e) {}
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
    } catch (_e) {}
    try {
      sc.close();
    } catch (_e) {}
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
    } catch (_e) {}
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
    } catch (_e) {}
  };

  const cleanupSwap = async (ctx, { reason = null, sendCancel = false } = {}) => {
    if (!ctx || ctx.cleanedUp) return;
    ctx.cleanedUp = true;
    if (ctx.resender) clearInterval(ctx.resender);
    try {
      swaps.delete(ctx.swapChannel);
    } catch (_e) {}
    try {
      pendingSwaps.delete(ctx.swapChannel);
    } catch (_e) {}
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
    if (ctx.startedSettlement) return;
    ctx.startedSettlement = true;

    const sats = ctx.btcSats;
    const invoice = await lnInvoice(ln, {
      amountMsat: (BigInt(String(sats)) * 1000n).toString(),
      label: ctx.tradeId,
      description: 'swap',
      expirySec: lnInvoiceExpirySec,
    });

    const bolt11 = String(invoice?.bolt11 || '').trim();
    const paymentHashHex = String(invoice?.payment_hash || '').trim().toLowerCase();
    if (!bolt11) throw new Error('LN invoice missing bolt11');
    if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) throw new Error('LN invoice missing payment_hash');

    ctx.paymentHashHex = paymentHashHex;

    const decoded = decodeBolt11(bolt11);
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
    await sc.send(ctx.swapChannel, lnInvSigned, { invite: ctx.invite || null });
    ctx.lastInvoiceSendAtMs = Date.now();
    process.stdout.write(`${JSON.stringify({ type: 'ln_invoice_sent', trade_id: ctx.tradeId, swap_channel: ctx.swapChannel, payment_hash_hex: paymentHashHex })}\n`);

    persistTrade(
      ctx.tradeId,
      {
        ln_invoice_bolt11: bolt11,
        ln_payment_hash_hex: paymentHashHex,
        state: ctx.trade.state,
      },
      'ln_invoice_sent',
      lnInvSigned
    );

    // Solana escrow (locks net + platform fee + trade fee; terms.usdt_amount is the net amount).
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
    try {
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
      throw err;
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
    ctx.sent.escrow = solEscrowSigned;
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

    if (isTaoSettlement) {
      persistTrade(
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
      );
    } else {
      persistTrade(
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
    }
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
          } catch (_e) {}
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
      } catch (_e) {}
    }, Math.max(swapResendMs, 200));
  };

  sc.on('sidechannel_message', async (evt) => {
    try {
      if (evt?.channel !== rfqChannel && !swaps.has(evt?.channel)) return;
      const msg = evt?.message;
      if (!msg || typeof msg !== 'object') return;

      // Swap channel traffic
      if (swaps.has(evt.channel)) {
        const ctx = swaps.get(evt.channel);
        if (!ctx) return;
        ctx.lastRemoteActivityAtMs = Date.now();
        const v = validateLocalMakerEnvelope(msg, { effectiveMinSettlementRefundAfterSec });
        if (!v.ok) return;
        const r = applySwapEnvelope(ctx.trade, msg);
        if (!r.ok) {
          if (debug) process.stderr.write(`[maker] swap apply error: ${r.error}\n`);
          return;
        }
        ctx.trade = r.trade;

        // Taker can join and send STATUS before it has seen TERMS due delivery races.
        // On STATUS, force a TERMS re-send so both peers converge deterministically.
        if (msg.kind === KIND.STATUS && ctx.trade.state === STATE.TERMS && ctx.sent.terms) {
          await sc.send(ctx.swapChannel, ctx.sent.terms, { invite: ctx.invite || null });
        }

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
            `settlement_refund_after_sec=${msg.body?.settlement_refund_after_sec ?? 'n/a'}\n`
        );

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
            `maker_settlement_refund_after_sec=${settlementRefundAfterSec}\n`
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
            `settlement_refund_after_sec=${isTaoPair(pair) ? settlementRefundAfterSec : 'n/a'}\n`
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
        // Recovery for duplicate quote_accept while in-flight:
        // resend invite/terms with hard throttling so taker recovery works without flooding.
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
          if (debug) {
            process.stderr.write(
              `[maker] duplicate quote_accept in-flight trade_id=${tradeId} swap_channel=${swapChannel} resent=${resent}\n`
            );
          }
          return;
        }

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
            inviteePubKey,
            pair: buildSettlementContext({ settlementKind, pair: known.pair }).pair,
            invite,
            btcSats: Number(known.btc_sats),
            usdtAmount: String(known.usdt_amount),
            solRecipient: String(known.sol_recipient),
            trade: createInitialTrade(tradeId),
            sent: {},
            startedSettlement: false,
            paymentHashHex: null,
            done: false,
            deadlineMs: Date.now() + swapTimeoutSec * 1000,
            resender: null,
            lastRemoteActivityAtMs: Date.now(),
            lastInviteSendAtMs: 0,
            lastTermsSendAtMs: 0,
            lastInvoiceSendAtMs: 0,
            lastEscrowSendAtMs: 0,
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

          // Begin swap: send terms and start the resend loop.
          await createAndSendTerms(ctx);
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
      if (debug) process.stderr.write(`[maker] error: ${err?.message ?? String(err)}\n`);
    }
  });

  process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'maker', rfq_channel: rfqChannel, pubkey: makerPubkey })}\n`);
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
