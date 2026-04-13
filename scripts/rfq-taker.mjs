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
  getHaveAssetForPair,
  getPairSettlementKind,
  getQuoteRefundFieldForPair,
  getRfqRefundRangeFieldsForPair,
  isTaoPair,
  normalizePair,
} from '../src/swap/pairs.js';
import { normalizeClnNetwork } from '../src/ln/cln.js';
import { normalizeLndNetwork } from '../src/ln/lnd.js';
import { decodeBolt11 } from '../src/ln/bolt11.js';
import { lnPay } from '../src/ln/client.js';
import { openTradeReceiptsStore } from '../src/receipts/store.js';
import { loadPeerWalletFromFile } from '../src/peer/keypair.js';
import {
  DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC,
  resolveRfqSettlementAmountAtomic,
  resolveSettlementRefundAfterSec,
  resolveUnsafeMinSettlementRefundAfterSec,
} from '../src/rfq/cliFlags.js';
import { buildRfqUnsignedEnvelope } from '../src/rfq/buildRfq.js';
import { matchOfferAnnouncementEvent } from '../src/rfq/offerMatch.js';
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

function parseBps(value, label, fallback) {
  const n = parseIntFlag(value, label, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10_000, n));
}

function parsePositiveIntEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function parsePositiveIntLike(value, fallback) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function splitCsv(value) {
  const s = String(value ?? '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
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

export function validateLocalTakerEnvelope(envelope, { effectiveMinSettlementRefundAfterSec } = {}) {
  return validateSwapEnvelope(envelope, {
    minSettlementRefundSec: effectiveMinSettlementRefundAfterSec,
  });
}

function signSwapEnvelope(unsignedEnvelope, { pubHex, secHex }, validationOptions = {}) {
  const sigHex = signUnsignedEnvelopeHex(unsignedEnvelope, secHex);
  const signed = attachSignature(unsignedEnvelope, { signerPubKeyHex: pubHex, sigHex });
  const v = validateLocalTakerEnvelope(signed, validationOptions);
  if (!v.ok) throw new Error(`Internal error: signed envelope invalid: ${v.error}`);
  return signed;
}

function asBigIntAmount(value) {
  try {
    const s = String(value ?? '').trim();
    if (!s) return null;
    return BigInt(s);
  } catch (_e) {
    process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    return null;
  }
}

function buildSwapLogFields({ pair, settlementKind, btcSats, amountAtomic }) {
  const normalizedPair = normalizePair(pair);
  return {
    pair: normalizedPair,
    direction: getDirectionForPair(normalizedPair),
    settlement_kind: settlementKind,
    btc_sats: btcSats,
    [getAmountFieldForPair(normalizedPair)]: amountAtomic,
  };
}

function normalizeNonEmptyTextOrNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function normalizeHex32PatchValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = String(value).trim().toLowerCase();
  return s ? s : null;
}

export function resolveEffectiveQuoteMinRefundWindowSec({
  quotePair,
  effectiveMinSettlementRefundAfterSec,
  minSolRefundWindowSec,
  maxSolRefundWindowSec,
  settlementRefundAfterSec,
  minSec = 3600,
  maxSec = 7 * 24 * 3600,
}) {
  const normalizedQuotePair = normalizePair(quotePair);
  if (isTaoPair(normalizedQuotePair)) {
    return Number(effectiveMinSettlementRefundAfterSec);
  }
  const quoteMinPolicy = buildSettlementContext({
    pair: normalizedQuotePair,
    refundRaw: {
      min_sol_refund_window_sec: minSolRefundWindowSec,
      max_sol_refund_window_sec: maxSolRefundWindowSec,
    },
    refundDefaults: {
      minSec,
      maxSec,
      defaultQuoteRefundSec: settlementRefundAfterSec,
      defaultMinRefundSec: minSolRefundWindowSec,
      defaultMaxRefundSec: maxSolRefundWindowSec,
    },
  }).refundPolicy;
  return quoteMinPolicy.minRefundSec;
}

export function resolveTakerSettlementRefundConfig({
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
    roleLabel: 'taker',
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

export function resolveTakerRefundAfterMarginConfig({
  env = process.env,
  fallbackSec = 900,
}) {
  const unsafeOverrideRaw = String(env?.INTERCOMSWAP_MIN_REFUND_AFTER_MARGIN_SEC || '').trim();
  if (unsafeOverrideRaw) {
    const invoiceExpirySafetyMarginSec = parsePositiveIntLike(unsafeOverrideRaw, null);
    if (!Number.isFinite(invoiceExpirySafetyMarginSec) || invoiceExpirySafetyMarginSec < 1) {
      throw new Error('Invalid INTERCOMSWAP_MIN_REFUND_AFTER_MARGIN_SEC (must be >= 1)');
    }
    return {
      invoiceExpirySafetyMarginSec,
      unsafeOverrideProvided: true,
      warnings: [
        `UNSAFE: lowering taker refund-after vs invoice-expiry margin to ${invoiceExpirySafetyMarginSec}s for this process only`,
      ],
    };
  }

  const legacyRaw = String(env?.INTERCOMSWAP_INVOICE_EXPIRY_SAFETY_MARGIN_SEC || '').trim();
  return {
    invoiceExpirySafetyMarginSec: parsePositiveIntLike(legacyRaw, fallbackSec),
    unsafeOverrideProvided: false,
    warnings: [],
  };
}

export function resolveTestStopBeforeLnPayConfig({ enabledRaw, lnNetwork } = {}) {
  const enabled = parseBool(enabledRaw, false);
  if (!enabled) {
    return {
      enabled: false,
      warnings: [],
    };
  }
  const normalizedNetwork = String(lnNetwork || '').trim().toLowerCase();
  if (normalizedNetwork !== 'regtest') {
    throw new Error('Invalid --test-stop-before-ln-pay (only supported when --ln-network regtest)');
  }
  return {
    enabled: true,
    warnings: [
      'TEST MODE: stopping taker immediately before lnPay() for deterministic refund-path testing',
    ],
  };
}

export function resolveTestStopAfterLnPayBeforeClaimConfig({ enabledRaw, lnNetwork } = {}) {
  const enabled = parseBool(enabledRaw, false);
  if (!enabled) {
    return {
      enabled: false,
      warnings: [],
    };
  }
  const normalizedNetwork = String(lnNetwork || '').trim().toLowerCase();
  if (normalizedNetwork !== 'regtest') {
    throw new Error('Invalid --test-stop-after-ln-pay-before-claim (only supported when --ln-network regtest)');
  }
  return {
    enabled: true,
    warnings: [
      'TEST MODE: stopping taker immediately after successful lnPay() and before settlement claim for deterministic crash-recovery testing',
    ],
  };
}

export function buildTestStopBeforeLnPayPayload({ tradeId, swapChannel, invoice, escrow } = {}) {
  return {
    stop_reason: 'test_stop_before_ln_pay',
    trade_id: String(tradeId || '').trim() || null,
    swap_channel: String(swapChannel || '').trim() || null,
    ln_invoice_bolt11: String(invoice?.bolt11 || '').trim() || null,
    ln_payment_hash_hex: String(invoice?.payment_hash_hex || '').trim().toLowerCase() || null,
    settlement_id: String(escrow?.settlement_id || escrow?.escrow_pda || '').trim() || null,
    refund_after_unix: escrow?.refund_after_unix ?? null,
  };
}

export function buildTestStopAfterLnPayBeforeClaimPayload({
  tradeId,
  swapChannel,
  paymentHashHex,
  preimageHex,
  escrow,
} = {}) {
  return {
    stop_reason: 'test_stop_after_ln_pay_before_claim',
    trade_id: String(tradeId || '').trim() || null,
    swap_channel: String(swapChannel || '').trim() || null,
    ln_payment_hash_hex: String(paymentHashHex || '').trim().toLowerCase() || null,
    ln_preimage_hex: String(preimageHex || '').trim().toLowerCase() || null,
    settlement_id: String(escrow?.settlement_id || escrow?.escrow_pda || '').trim() || null,
    refund_after_unix: escrow?.refund_after_unix ?? null,
  };
}

export function buildTestStopAfterLnPayBeforeClaimPatch({
  settlementKind,
  tradeState,
  stopPayload,
} = {}) {
  const patch = {
    ln_payment_hash_hex: stopPayload?.ln_payment_hash_hex || null,
    ln_preimage_hex: stopPayload?.ln_preimage_hex || null,
    state: String(tradeState || '').trim() || null,
    last_error: stopPayload?.stop_reason || 'test_stop_after_ln_pay_before_claim',
  };
  if (settlementKind === SETTLEMENT_KIND.TAO_EVM) {
    patch.tao_settlement_id = stopPayload?.settlement_id || null;
    patch.tao_refund_after_unix = stopPayload?.refund_after_unix ?? null;
  } else {
    patch.sol_escrow_pda = stopPayload?.settlement_id || null;
    patch.sol_refund_after_unix = stopPayload?.refund_after_unix ?? null;
  }
  return patch;
}

export async function maybeHandleTestStopAfterLnPayBeforeClaim({
  enabled = false,
  tradeId,
  swapChannel,
  settlementKind,
  tradeState,
  paymentHashHex,
  preimageHex,
  escrow,
  persistTrade = null,
  writeWarning = null,
  writeEvent = null,
  cleanupAndExit = null,
} = {}) {
  if (!enabled) return false;
  const stopPayload = buildTestStopAfterLnPayBeforeClaimPayload({
    tradeId,
    swapChannel,
    paymentHashHex,
    preimageHex,
    escrow,
  });
  if (typeof writeWarning === 'function') {
    writeWarning(
      `[taker] TEST MODE: stopping immediately after successful lnPay() and before settlement claim; no claim will be attempted\n`
    );
    writeWarning(`[taker] TEST MODE: stop_reason=${stopPayload.stop_reason} trade_id=${stopPayload.trade_id || 'n/a'}\n`);
  }
  if (typeof writeEvent === 'function') {
    writeEvent({ type: 'test_stop_after_ln_pay_before_claim', ...stopPayload });
  }
  if (typeof persistTrade === 'function') {
    persistTrade(
      buildTestStopAfterLnPayBeforeClaimPatch({
        settlementKind,
        tradeState,
        stopPayload,
      }),
      'test_stop_after_ln_pay_before_claim',
      stopPayload
    );
  }
  if (typeof cleanupAndExit === 'function') {
    await cleanupAndExit({ stopPayload });
  }
  return true;
}

export function resolveTakerMinTimelockConfig({
  env = process.env,
  fallbackSec = 3600,
}) {
  const raw = String(env?.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC || '').trim();
  const minTimelockRemainingSec = parsePositiveIntLike(raw, fallbackSec);
  const unsafeOverrideProvided = raw !== '' && minTimelockRemainingSec < fallbackSec;
  return {
    minTimelockRemainingSec,
    unsafeOverrideProvided,
    warnings: unsafeOverrideProvided
      ? [
          `UNSAFE: lowering taker minimum timelock remaining to ${minTimelockRemainingSec}s for this process only`,
        ]
      : [],
  };
}

export function evaluateLocalTakerPrePayTimelockSafety({
  refundAfterUnix,
  invoiceExpiryUnix,
  nowUnix,
  minTimelockRemainingSec,
  invoiceExpirySafetyMarginSec,
}) {
  return buildSettlementContext({
    timelock: {
      refundAfterUnix,
      invoiceExpiryUnix,
      nowUnix,
      minTimelockRemainingSec,
      invoiceExpirySafetyMarginSec,
      requireRefundAfterGreaterThanInvoiceExpiryPlusMin: false,
    },
  }).timelockSafety;
}

export function deriveInvoiceReceiptFields(invoiceBody) {
  const body = invoiceBody && typeof invoiceBody === 'object' ? invoiceBody : {};
  const lnInvoiceBolt11 = normalizeNonEmptyTextOrNull(body.bolt11);
  let paymentHashHex = normalizeHex32PatchValue(body.payment_hash_hex);
  if (!paymentHashHex && lnInvoiceBolt11) {
    try {
      paymentHashHex = normalizeHex32PatchValue(decodeBolt11(lnInvoiceBolt11).payment_hash_hex);
    } catch (_e) {
      process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
    }
  }
  return {
    ln_invoice_bolt11: lnInvoiceBolt11,
    ln_payment_hash_hex: paymentHashHex ?? null,
  };
}

export function resolveReceiptsDbPath({ receiptsDbPathRaw, peerKeypairPath, env = process.env }) {
  const explicit = String(receiptsDbPathRaw || '').trim();
  const envOverride = String(env?.INTERCOMSWAP_RECEIPTS_DB || '').trim();
  const picked = explicit || envOverride;
  if (picked) return path.isAbsolute(picked) ? picked : path.resolve(picked);
  const peerDir = path.dirname(path.resolve(peerKeypairPath));
  return path.join(peerDir, 'receipts.db');
}

export function initReceiptsStore({ dbPath, runSwap, allowNoReceipts = false, role = 'taker' }) {
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

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const url = requireFlag(flags, 'url');
  const token = requireFlag(flags, 'token');
  const peerKeypairPath = requireFlag(flags, 'peer-keypair');
  const rfqChannel = (flags.get('rfq-channel') && String(flags.get('rfq-channel')).trim()) || '0000intercomswapbtcusdt';
  const listenOffers = parseBool(flags.get('listen-offers'), false);
  const offerChannels = (() => {
    const raw = flags.get('offer-channels') ?? flags.get('offer-channel') ?? '';
    const chans = splitCsv(raw);
    const list = chans.length > 0 ? chans : [rfqChannel];
    return Array.from(new Set(list.map((c) => String(c || '').trim()).filter(Boolean)));
  })();
  const receiptsDbPath = resolveReceiptsDbPath({
    receiptsDbPathRaw: flags.get('receipts-db'),
    peerKeypairPath,
  });
  const persistPreimage = parseBool(flags.get('persist-preimage'), true);
  const stopAfterLnPay = parseBool(flags.get('stop-after-ln-pay'), false);
  const testStopBeforeLnPayRaw = flags.get('test-stop-before-ln-pay');
  const testStopAfterLnPayBeforeClaimRaw = flags.get('test-stop-after-ln-pay-before-claim');

  const tradeId = (flags.get('trade-id') && String(flags.get('trade-id')).trim()) || `swap_${crypto.randomUUID()}`;
  let settlementKind = normalizeSettlementKind(flags.get('settlement') || SETTLEMENT_KIND.SOLANA);
  const initialSettlementKind = settlementKind;
  let isSolanaSettlement = settlementKind === SETTLEMENT_KIND.SOLANA;
  let isTaoSettlement = settlementKind === SETTLEMENT_KIND.TAO_EVM;
  let rfqPair = buildSettlementContext({ settlementKind }).pair;

  let btcSats = parseIntFlag(flags.get('btc-sats'), 'btc-sats', 50_000);
  let usdtAmount = '100000000';
  try {
    const amountConfig = resolveRfqSettlementAmountAtomic({
      settlementKind,
      usdtAmountRaw: flags.get('usdt-amount'),
      taoAmountAtomicRaw: flags.get('tao-amount-atomic'),
      fallbackUsdtAmount: '100000000',
    });
    usdtAmount = amountConfig.amountAtomic;
    for (const warning of amountConfig.warnings) process.stderr.write(`Warning: ${warning}\n`);
  } catch (err) {
    die(err?.message || String(err));
  }
  const rfqValidSec = parseIntFlag(flags.get('rfq-valid-sec'), 'rfq-valid-sec', 60);

  const timeoutSec = parseIntFlag(flags.get('timeout-sec'), 'timeout-sec', 30);
  const rfqResendMs = parseIntFlag(flags.get('rfq-resend-ms'), 'rfq-resend-ms', 1200);
  const acceptResendMs = parseIntFlag(flags.get('accept-resend-ms'), 'accept-resend-ms', 1200);

  const onceExitDelayMs = parseIntFlag(flags.get('once-exit-delay-ms'), 'once-exit-delay-ms', 200);
  const once = parseBool(flags.get('once'), false);
  const debug = parseBool(flags.get('debug'), false);

  const runSwap = parseBool(flags.get('run-swap'), false);
  const allowNoReceipts = parseBool(flags.get('allow-no-receipts'), false);
  const swapTimeoutSec = parseIntFlag(flags.get('swap-timeout-sec'), 'swap-timeout-sec', 300);
  const swapResendMs = parseIntFlag(flags.get('swap-resend-ms'), 'swap-resend-ms', 1200);
  // Guardrail: require the Solana refund timelock in TERMS to be far enough in the future
  // to allow recovery (crash/restart/RPC outage) after paying the LN invoice.
  const minSolRefundWindowSecCfg = parseIntFlag(
    flags.get('min-solana-refund-window-sec'),
    'min-solana-refund-window-sec',
    72 * 3600
  );
  const maxSolRefundWindowSecCfg = parseIntFlag(
    flags.get('max-solana-refund-window-sec'),
    'max-solana-refund-window-sec',
    7 * 24 * 3600
  );
  const maxPlatformFeeBpsCfg = parseBps(flags.get('max-platform-fee-bps'), 'max-platform-fee-bps', 500);
  const maxTradeFeeBpsCfg = parseBps(flags.get('max-trade-fee-bps'), 'max-trade-fee-bps', 1000);
  const maxTotalFeeBpsCfg = parseBps(flags.get('max-total-fee-bps'), 'max-total-fee-bps', 1500);
  const DEFAULT_SETTLEMENT_REFUND_AFTER_SEC = 72 * 3600;
  let settlementRefundAfterSec = DEFAULT_SETTLEMENT_REFUND_AFTER_SEC;
  let effectiveMinSettlementRefundAfterSec = DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC;
  let unsafeMinSettlementRefundAfterSecProvided = false;

  const SETTLEMENT_REFUND_MIN_SEC = 3600; // 1h
  const SETTLEMENT_REFUND_MAX_SEC = 7 * 24 * 3600; // 1w
  if (!Number.isFinite(minSolRefundWindowSecCfg) || minSolRefundWindowSecCfg < SETTLEMENT_REFUND_MIN_SEC) {
    die(`Invalid --min-solana-refund-window-sec (must be >= ${SETTLEMENT_REFUND_MIN_SEC})`);
  }
  if (!Number.isFinite(maxSolRefundWindowSecCfg) || maxSolRefundWindowSecCfg > SETTLEMENT_REFUND_MAX_SEC) {
    die(`Invalid --max-solana-refund-window-sec (must be <= ${SETTLEMENT_REFUND_MAX_SEC})`);
  }
  if (minSolRefundWindowSecCfg > maxSolRefundWindowSecCfg) {
    die('Invalid Solana refund window range (min > max)');
  }
  if (maxPlatformFeeBpsCfg > 500) die('Invalid --max-platform-fee-bps (must be <= 500)');
  if (maxTradeFeeBpsCfg > 1000) die('Invalid --max-trade-fee-bps (must be <= 1000)');
  if (maxTotalFeeBpsCfg > 1500) die('Invalid --max-total-fee-bps (must be <= 1500)');
  try {
    const refundConfig = resolveTakerSettlementRefundConfig({
      settlementRefundAfterSecRaw: flags.get('settlement-refund-after-sec'),
      legacySolanaRefundAfterSecRaw: flags.get('solana-refund-after-sec'),
      unsafeMinSettlementRefundAfterSecRaw: flags.get('unsafe-min-settlement-refund-after-sec'),
      fallbackSec: DEFAULT_SETTLEMENT_REFUND_AFTER_SEC,
      defaultSafeMinSec: DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC,
      minSec: SETTLEMENT_REFUND_MIN_SEC,
      maxSec: SETTLEMENT_REFUND_MAX_SEC,
    });
    settlementRefundAfterSec = refundConfig.settlementRefundAfterSec;
    effectiveMinSettlementRefundAfterSec = refundConfig.effectiveMinSettlementRefundAfterSec;
    unsafeMinSettlementRefundAfterSecProvided = refundConfig.unsafeMinProvided;
    for (const warning of refundConfig.warnings) process.stderr.write(`Warning: ${warning}\n`);
  } catch (err) {
    die(err?.message || String(err));
  }

  // The actual RFQ we post uses these variables. When listening to offers, they can be overridden
  // (but still constrained by the configured guardrails above).
  let minSolRefundWindowSec = minSolRefundWindowSecCfg;
  let maxSolRefundWindowSec = maxSolRefundWindowSecCfg;
  let maxPlatformFeeBps = maxPlatformFeeBpsCfg;
  let maxTradeFeeBps = maxTradeFeeBpsCfg;
  let maxTotalFeeBps = maxTotalFeeBpsCfg;
  const timelockConfig = resolveTakerMinTimelockConfig({
    env: process.env,
    fallbackSec: 3600,
  });
  const minTimelockRemainingSec = timelockConfig.minTimelockRemainingSec;
  for (const warning of timelockConfig.warnings) process.stderr.write(`Warning: ${warning}\n`);
  const invoiceExpiryMarginConfig = resolveTakerRefundAfterMarginConfig({
    env: process.env,
    fallbackSec: 900,
  });
  const invoiceExpirySafetyMarginSec = invoiceExpiryMarginConfig.invoiceExpirySafetyMarginSec;
  for (const warning of invoiceExpiryMarginConfig.warnings) process.stderr.write(`Warning: ${warning}\n`);

  const solRpcUrl = (flags.get('solana-rpc-url') && String(flags.get('solana-rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const solKeypairPath = flags.get('solana-keypair') ? String(flags.get('solana-keypair')).trim() : '';
  const taoKeyfilePath = flags.get('tao-keyfile') ? String(flags.get('tao-keyfile')).trim() : '';
  const solMintStr = flags.get('solana-mint') ? String(flags.get('solana-mint')).trim() : '';
  const solProgramIdStr = flags.get('solana-program-id') ? String(flags.get('solana-program-id')).trim() : '';
  const solComputeUnitLimit = parseIntFlag(flags.get('solana-cu-limit'), 'solana-cu-limit', null);
  const solComputeUnitPriceMicroLamports = parseIntFlag(flags.get('solana-cu-price'), 'solana-cu-price', null);

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
  let testStopBeforeLnPay = false;
  let testStopAfterLnPayBeforeClaim = false;
  try {
    const testStopConfig = resolveTestStopBeforeLnPayConfig({
      enabledRaw: testStopBeforeLnPayRaw,
      lnNetwork,
    });
    testStopBeforeLnPay = testStopConfig.enabled;
    for (const warning of testStopConfig.warnings) process.stderr.write(`Warning: ${warning}\n`);
  } catch (err) {
    die(err?.message || String(err));
  }
  try {
    const testStopAfterLnPayConfig = resolveTestStopAfterLnPayBeforeClaimConfig({
      enabledRaw: testStopAfterLnPayBeforeClaimRaw,
      lnNetwork,
    });
    testStopAfterLnPayBeforeClaim = testStopAfterLnPayConfig.enabled;
    for (const warning of testStopAfterLnPayConfig.warnings) process.stderr.write(`Warning: ${warning}\n`);
  } catch (err) {
    die(err?.message || String(err));
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

  const expectedProgramId = solProgramIdStr || SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID;
  let settlementProgramId = null;
  let settlementBinding = null;
  let expectedAppHash = null;
  let receiptsRuntime;
  try {
    receiptsRuntime = initReceiptsStore({
      dbPath: receiptsDbPath,
      runSwap,
      allowNoReceipts,
      role: 'taker',
    });
  } catch (err) {
    die(err?.message || String(err));
  }
  let receipts = receiptsRuntime.receipts;
  process.stderr.write(`[receipts] enabled=${receiptsRuntime.enabled} db_path=${receiptsRuntime.dbPath}\n`);
  let sol = null;

  const persistTrade = (patch, eventKind = null, eventPayload = null) => {
    if (!receipts) return;
    const normalizedPatch = {
      ...patch,
      ...(Object.prototype.hasOwnProperty.call(patch || {}, 'ln_invoice_bolt11')
        ? { ln_invoice_bolt11: normalizeNonEmptyTextOrNull(patch.ln_invoice_bolt11) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch || {}, 'ln_payment_hash_hex')
        ? { ln_payment_hash_hex: normalizeHex32PatchValue(patch.ln_payment_hash_hex) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch || {}, 'ln_preimage_hex')
        ? { ln_preimage_hex: normalizeHex32PatchValue(patch.ln_preimage_hex) }
        : {}),
    };
    try {
      receipts.upsertTrade(tradeId, {
        settlement_kind: settlementKind,
        ...normalizedPatch,
      });
      if (eventKind) receipts.appendEvent(tradeId, eventKind, eventPayload);
    } catch (err) {
      try {
        receipts.upsertTrade(tradeId, { last_error: err?.message ?? String(err) });
      } catch (_e) {
        process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
      process.stderr.write(`[taker] ERROR: ${err?.stack || err?.message || String(err)}\n`);
    }
  };

  const initSettlementRuntime = async () => {
    const settlementCtx = buildSettlementContext({
      settlementKind,
      solanaProgramId: expectedProgramId,
    });
    settlementBinding = settlementCtx.settlementBinding;
    settlementProgramId = settlementBinding.binding_id;
    expectedAppHash = settlementCtx.expectedAppHash;

    if (runSwap) {
      if (isSolanaSettlement) {
        if (!solKeypairPath) die('Missing --solana-keypair (required when --run-swap 1 and --settlement solana)');
      }
      if (isTaoSettlement) {
        if (!taoKeyfilePath && !process.env.TAO_EVM_PRIVATE_KEY) {
          die('Missing TAO signer: provide --tao-keyfile or TAO_EVM_PRIVATE_KEY');
        }
      }
      if (!lnService && lnBackend === 'docker') die('Missing --ln-service (required when --ln-backend docker)');
    }

    sol = runSwap
      ? await (async () => {
          /** @type {import('../settlement/SettlementProvider').SettlementProvider} */
          const settlement = getSettlementProvider(settlementKind, {
            solana: {
              rpcUrls: solRpcUrl,
              commitment: 'confirmed',
              keypairPath: solKeypairPath,
              mint: solMintStr,
              programId: expectedProgramId,
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
            recipientAddress: await settlement.getSignerAddress(),
            expectedProgramId: settlementProgramId,
          };
        })()
      : null;
  };

  const sc = new ScBridgeClient({ url, token });
  await sc.connect();

  const joinedChannels = Array.from(new Set([rfqChannel, ...(listenOffers ? offerChannels : [])]));
  for (const ch of joinedChannels) {
    ensureOk(await sc.join(ch), `join ${ch}`);
  }
  ensureOk(await sc.subscribe(joinedChannels), `subscribe ${joinedChannels.join(',')}`);
  process.stderr.write(
    `[taker] subscribed rfq_channel=${rfqChannel} joined_channels=${joinedChannels.join(',')} trade_id=${tradeId} rfq_id=pending\n`
  );

  const takerPubkey = String(sc.hello?.peer || '').trim().toLowerCase();
  if (!takerPubkey) die('SC-Bridge hello missing peer pubkey');
  const signing = await loadPeerWalletFromFile(peerKeypairPath);
  if (signing.pubHex !== takerPubkey) {
    die(`peer keypair pubkey mismatch: sc_bridge=${takerPubkey} keypair=${signing.pubHex}`);
  }

  const runSingleTradeCycle = async () => {
    let offerMeta = null;
    if (listenOffers) {
      const offerWaitMs = Math.max(5_000, Math.trunc(Number(timeoutSec || 30) * 1000));
      const offerWaitLogIntervalMs = 10 * 60 * 1000;
      let firstOfferTimeout = true;
      let lastOfferWaitLogAtMs = 0;
      process.stdout.write(
        `${JSON.stringify({ type: 'waiting_offer', offer_channels: offerChannels, rfq_channel: rfqChannel, trade_id: tradeId, pubkey: takerPubkey })}\n`
      );

      for (;;) {
        try {
          offerMeta = await new Promise((resolve, reject) => {
            const deadline = setTimeout(() => {
              cleanup();
              const err = new Error(`offer wait timeout after ${offerWaitMs}ms`);
              err.code = 'OFFER_TIMEOUT';
              reject(err);
            }, offerWaitMs);

            const cleanup = () => {
              clearTimeout(deadline);
              sc.off('sidechannel_message', onMsg);
            };

            const onMsg = (evt) => {
              try {
                const matchedOffer = matchOfferAnnouncementEvent(evt, {
                  offerChannels,
                  rfqChannel,
                  fallbackPair: rfqPair,
                  expectedProgramId,
                  maxPlatformFeeBps: maxPlatformFeeBpsCfg,
                  maxTradeFeeBps: maxTradeFeeBpsCfg,
                  maxTotalFeeBps: maxTotalFeeBpsCfg,
                  minRefundSec: minSolRefundWindowSecCfg,
                  minSettlementRefundSec: effectiveMinSettlementRefundAfterSec,
                  maxRefundSec: maxSolRefundWindowSecCfg,
                });
                if (!matchedOffer) return;
                cleanup();
                resolve(matchedOffer);
                return;
              } catch (err) {
                cleanup();
                reject(err);
              }
            };

            sc.on('sidechannel_message', onMsg);
          });
          break;
        } catch (err) {
          if (err?.code !== 'OFFER_TIMEOUT') {
            throw err;
          }
          const nowMs = Date.now();
          if (firstOfferTimeout) {
            process.stderr.write(`[taker] no offers received (${Math.trunc(offerWaitMs / 1000)}s), continuing to listen...\n`);
            firstOfferTimeout = false;
            lastOfferWaitLogAtMs = nowMs;
          } else if (nowMs - lastOfferWaitLogAtMs > offerWaitLogIntervalMs) {
            process.stderr.write('[taker] still listening for offers...\n');
            lastOfferWaitLogAtMs = nowMs;
          }
        }
      }

      rfqPair = offerMeta.pair;
      if (offerMeta.settlement_kind !== settlementKind) {
        process.stderr.write(
          `Warning: matched ${rfqPair} offer overrides taker settlement from ${initialSettlementKind} to ${offerMeta.settlement_kind}\n`
        );
        settlementKind = offerMeta.settlement_kind;
        isSolanaSettlement = settlementKind === SETTLEMENT_KIND.SOLANA;
        isTaoSettlement = settlementKind === SETTLEMENT_KIND.TAO_EVM;
      }
      btcSats = offerMeta.btc_sats;
      usdtAmount = String(getAmountForPair(offerMeta, rfqPair) || '').trim();
      maxPlatformFeeBps = offerMeta.max_platform_fee_bps;
      maxTradeFeeBps = offerMeta.max_trade_fee_bps;
      maxTotalFeeBps = offerMeta.max_total_fee_bps;
      const offerRefundPolicy = buildSettlementContext({
        pair: rfqPair,
        refundRaw: offerMeta,
        refundDefaults: {
          minSec: SETTLEMENT_REFUND_MIN_SEC,
          maxSec: SETTLEMENT_REFUND_MAX_SEC,
          defaultQuoteRefundSec: settlementRefundAfterSec,
          defaultMinRefundSec: minSolRefundWindowSec,
          defaultMaxRefundSec: maxSolRefundWindowSec,
        },
      }).refundPolicy;
      settlementRefundAfterSec = offerRefundPolicy.quoteRefundSec;
      minSolRefundWindowSec = offerRefundPolicy.minRefundSec;
      maxSolRefundWindowSec = offerRefundPolicy.maxRefundSec;

      process.stdout.write(
        `${JSON.stringify({
          type: 'offer_matched',
          trade_id: tradeId,
          offer_channel: offerMeta.offer_channel,
          offer_name: offerMeta.offer_name,
          pair: rfqPair,
          btc_sats: btcSats,
          [getAmountFieldForPair(rfqPair)]: usdtAmount,
        })}\n`
      );
    }

    await initSettlementRuntime();

    const nowSec = Math.floor(Date.now() / 1000);
    let rfqValidUntil = nowSec + rfqValidSec;
    if (offerMeta && Number.isFinite(offerMeta.offer_valid_until_unix) && offerMeta.offer_valid_until_unix > 0) {
      rfqValidUntil = Math.min(rfqValidUntil, Math.trunc(offerMeta.offer_valid_until_unix));
    }
    if (!Number.isInteger(Number(btcSats)) || Number(btcSats) < 1) {
      die('Invalid --btc-sats (must be >= 1)');
    }
    if (!/^[0-9]+$/.test(String(usdtAmount || '').trim()) || BigInt(String(usdtAmount || '0')) <= 0n) {
      const amountFlagLabel = isTaoSettlement ? '--tao-amount-atomic' : '--usdt-amount';
      die(`Invalid ${amountFlagLabel} (must be a positive base-unit integer; open RFQ amount=0 is not supported)`);
    }
    const rfqUnsigned = buildRfqUnsignedEnvelope({
      tradeId,
      pair: rfqPair,
      expectedAppHash,
      btcSats,
      amountAtomic: usdtAmount,
      maxPlatformFeeBps,
      maxTradeFeeBps,
      maxTotalFeeBps,
      settlementRefundAfterSec,
      minSolRefundWindowSec,
      maxSolRefundWindowSec,
      solRecipient: runSwap ? sol.recipientAddress : null,
      solMint: runSwap && solMintStr ? solMintStr : null,
      validUntilUnix: rfqValidUntil,
    });
    process.stderr.write(
      `[taker] rfq settlement_refund_after_sec=${rfqUnsigned?.body?.settlement_refund_after_sec} rfq_id=${rfqUnsigned?.body?.rfq_id ?? 'n/a'} trade_id=${rfqUnsigned?.tradeId ?? 'n/a'}\n`
    );
    const rfqId = hashUnsignedEnvelope(rfqUnsigned);
    const rfqSigned = signSwapEnvelope(rfqUnsigned, signing, {
      effectiveMinSettlementRefundAfterSec,
    });
    ensureOk(await sc.send(rfqChannel, rfqSigned), 'send rfq');

    persistTrade(
      {
        role: 'taker',
        rfq_channel: rfqChannel,
        maker_peer: null,
        taker_peer: takerPubkey,
        btc_sats: btcSats,
        usdt_amount: isTaoPair(rfqPair) ? null : usdtAmount,
        ...(isTaoPair(rfqPair) ? { tao_amount_atomic: usdtAmount } : {}),
        ...(isSolanaSettlement
          ? {
              sol_mint: runSwap && solMintStr ? solMintStr : null,
              sol_recipient: runSwap ? sol.recipientAddress : null,
            }
          : {}),
        state: STATE.INIT,
      },
      'rfq_sent',
      rfqSigned
    );

    process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'taker', rfq_channel: rfqChannel, trade_id: tradeId, rfq_id: rfqId, pubkey: takerPubkey })}\n`);

    let chosen = null; // { rfq_id, quote_id, quote }
    let joined = false;
    let joinSwapInFlight = false;
    let done = false;
    let swapCtx = null; // { swapChannel, invite, trade, waiters, sent }

    const deadlineMs = Date.now() + timeoutSec * 1000;

    const maybeExit = () => {
      if (!once) return;
      if (!done) return;
      const delay = Number.isFinite(onceExitDelayMs) ? Math.max(onceExitDelayMs, 0) : 0;
      setTimeout(() => {
        try {
          receipts?.close();
        } catch (_e) {
          process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
        }
        sc.close();
        process.exit(0);
      }, delay);
    };

    const leaveSidechannel = async (channel) => {
      try {
        await sc.leave(channel);
      } catch (_e) {
        process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
    };

    const resendRfqTimer = setInterval(async () => {
      try {
        if (chosen) return;
        if (Date.now() > deadlineMs) return;
        ensureOk(await sc.send(rfqChannel, rfqSigned), 'resend rfq');
        if (debug) process.stderr.write(`[taker] resend rfq trade_id=${tradeId}\n`);
      } catch (err) {
        process.stderr.write(`[taker] ERROR: ${err?.stack || err?.message || String(err)}\n`);
      }
    }, Math.max(rfqResendMs, 200));

    let quoteAcceptSigned = null;
    const resendAcceptTimer = setInterval(async () => {
      try {
        if (!chosen) return;
        if (joined) return;
        if (Date.now() > deadlineMs) return;
        if (!quoteAcceptSigned) return;
        ensureOk(await sc.send(rfqChannel, quoteAcceptSigned), 'resend quote_accept');
        if (debug) process.stderr.write(`[taker] resend quote_accept trade_id=${tradeId} quote_id=${chosen.quote_id}\n`);
      } catch (err) {
        process.stderr.write(`[taker] ERROR: ${err?.stack || err?.message || String(err)}\n`);
      }
    }, Math.max(acceptResendMs, 200));

    const stopTimers = () => {
      clearInterval(resendRfqTimer);
      clearInterval(resendAcceptTimer);
    };

    const enforceTimeout = setInterval(() => {
      if (Date.now() <= deadlineMs) return;
      stopTimers();
      process.stderr.write(
        `[taker] still waiting for RFQ handshake expected_next=${chosen ? 'swap_invite' : 'quote'} ` +
          `trade_id=${tradeId} rfq_id=${rfqId} rfq_channel=${rfqChannel}\n`
      );
      process.stderr.write(
        '[taker] hint: common offer-listen skip causes: offer missing app_hash; offer app_hash mismatch vs settlement binding\n'
      );
      die(`Timeout waiting for RFQ handshake (timeout-sec=${timeoutSec})`);
    }, 200);

    const waitForSwapMessage = (match, { timeoutMs, label }) =>
      new Promise((resolve, reject) => {
        if (!swapCtx) return reject(new Error('swapCtx not initialized'));
        const timer = setTimeout(() => {
          swapCtx.waiters.delete(waiter);
          reject(new Error(`Timeout waiting for ${label}`));
        }, timeoutMs);
        const waiter = (msg) => {
          try {
            if (!match(msg)) return;
            clearTimeout(timer);
            swapCtx.waiters.delete(waiter);
            resolve(msg);
          } catch (err) {
            clearTimeout(timer);
            swapCtx.waiters.delete(waiter);
            reject(err);
          }
        };
        swapCtx.waiters.add(waiter);
      });

    let persistSwapMessageCheckpoint = (_msg) => {};

    const startSwap = async ({ swapChannel, invite }) => {
    ensureOk(await sc.subscribe([swapChannel]), `subscribe ${swapChannel}`);

    swapCtx = {
      swapChannel,
      invite,
      trade: createInitialTrade(tradeId),
      waiters: new Set(),
      sent: {},
      done: false,
      deadlineMs: Date.now() + swapTimeoutSec * 1000,
      timers: new Set(),
    };

    persistTrade(
      {
        swap_channel: swapChannel,
        state: swapCtx.trade.state,
      },
      'swap_started',
      { swap_channel: swapChannel }
    );

    persistSwapMessageCheckpoint = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const body = msg?.body && typeof msg.body === 'object' ? msg.body : {};
      const pair = normalizePair(body.pair || rfqPair);
      if (msg.kind === KIND.TERMS) {
        const amountAtomic = normalizeNonEmptyTextOrNull(getAmountForPair(body, pair, { allowLegacyTaoFallback: true }));
        persistTrade({
          swap_channel: swapChannel,
          btc_sats: body?.btc_sats ?? btcSats,
          usdt_amount: isTaoPair(pair) ? null : amountAtomic,
          ...(isTaoPair(pair) ? { tao_amount_atomic: amountAtomic } : {}),
          state: swapCtx.trade.state,
        });
        return;
      }
      if (msg.kind === KIND.LN_INVOICE) {
        persistTrade({
          ...deriveInvoiceReceiptFields(body),
          state: swapCtx.trade.state,
        });
        return;
      }
      if (msg.kind === KIND.TAO_HTLC_LOCKED) {
        persistTrade({
          tao_settlement_id: normalizeNonEmptyTextOrNull(body.settlement_id),
          tao_htlc_address: normalizeNonEmptyTextOrNull(body.htlc_address),
          tao_amount_atomic: normalizeNonEmptyTextOrNull(body.amount_atomic),
          tao_recipient: normalizeNonEmptyTextOrNull(body.recipient),
          tao_refund: normalizeNonEmptyTextOrNull(body.refund),
          tao_refund_after_unix: body.refund_after_unix ?? null,
          tao_lock_tx_id: normalizeNonEmptyTextOrNull(body.tx_id),
          state: swapCtx.trade.state,
        });
        return;
      }
      if (msg.kind === KIND.SOL_ESCROW_CREATED) {
        persistTrade({
          sol_program_id: normalizeNonEmptyTextOrNull(body.program_id),
          sol_mint: normalizeNonEmptyTextOrNull(body.mint),
          sol_recipient: normalizeNonEmptyTextOrNull(body.recipient),
          sol_refund: normalizeNonEmptyTextOrNull(body.refund),
          sol_escrow_pda: normalizeNonEmptyTextOrNull(body.escrow_pda),
          sol_vault_ata: normalizeNonEmptyTextOrNull(body.vault_ata),
          sol_refund_after_unix: body.refund_after_unix ?? null,
          state: swapCtx.trade.state,
        });
      }
    };

    const clearTimers = () => {
      for (const tmr of swapCtx.timers) clearInterval(tmr);
      swapCtx.timers.clear();
    };

    const checkSwapDeadline = () => {
      if (Date.now() <= swapCtx.deadlineMs) return;
      clearTimers();
      die(`Timeout waiting for swap completion (swap-timeout-sec=${swapTimeoutSec})`);
    };

    // Send ready status with invite attached to accelerate authorization.
  const readyUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.STATUS,
    tradeId,
    body: { state: STATE.INIT, note: 'ready' },
  });
  const readySigned = signSwapEnvelope(readyUnsigned, signing);
  swapCtx.sent.ready = readySigned;
  await sc.send(swapChannel, readySigned, { invite });
    process.stdout.write(
      `${JSON.stringify({
        type: 'swap_ready_sent',
        trade_id: tradeId,
        swap_channel: swapChannel,
        ...buildSwapLogFields({
          pair: rfqPair,
          settlementKind,
          btcSats,
          amountAtomic: usdtAmount,
        }),
      })}\n`
    );
    persistTrade({ state: swapCtx.trade.state }, 'swap_ready_sent', readySigned);

    const readyTimer = setInterval(async () => {
      try {
        checkSwapDeadline();
        if (swapCtx.done) return;
        if (swapCtx.trade.state !== STATE.INIT) return;
        await sc.send(swapChannel, readySigned, { invite });
      } catch (_e) {
        process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
    }, Math.max(swapResendMs, 200));
    swapCtx.timers.add(readyTimer);

    // Wait for terms.
    const termsMsg = await waitForSwapMessage((m) => m?.kind === KIND.TERMS && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'TERMS',
    });

    const termsAppHash = String(termsMsg?.body?.app_hash || '').trim().toLowerCase();
    if (termsAppHash !== expectedAppHash) {
      throw new Error('terms.app_hash mismatch (wrong app/program for this channel)');
    }

    // Guardrail: bind swap counterparty identity to the quote we accepted.
    const quoteMaker = String(chosen?.quote?.signer || '').trim().toLowerCase();
    const gotTermsSigner = String(termsMsg.signer || '').trim().toLowerCase();
    if (quoteMaker && gotTermsSigner && quoteMaker !== gotTermsSigner) {
      throw new Error(`terms signer mismatch vs quote signer (terms=${gotTermsSigner} quote=${quoteMaker})`);
    }
    const termsReceiver = String(termsMsg.body?.ln_receiver_peer || '').trim().toLowerCase();
    if (quoteMaker && termsReceiver && quoteMaker !== termsReceiver) {
      throw new Error(`terms.ln_receiver_peer mismatch vs quote signer (terms=${termsReceiver} quote=${quoteMaker})`);
    }
    const termsPayer = String(termsMsg.body?.ln_payer_peer || '').trim().toLowerCase();
    if (termsPayer && termsPayer !== takerPubkey) {
      throw new Error(`terms.ln_payer_peer mismatch vs our pubkey (terms=${termsPayer} want=${takerPubkey})`);
    }

    const termsCtx = buildSettlementContext({ pair: termsMsg.body?.pair || rfqPair, terms: termsMsg.body });
    const normalizedTerms = termsCtx.normalizedTerms;

    // Verify settlement recipient matches our signer before proceeding.
    const wantRecipient = sol.recipientAddress;
    const gotRecipient = String(normalizedTerms?.settlement_recipient || '');
    if (gotRecipient !== wantRecipient) {
      throw new Error(`terms.sol_recipient mismatch (got=${gotRecipient} want=${wantRecipient})`);
    }
    if (solMintStr) {
      const gotMint = String(normalizedTerms?.settlement_asset_id || '');
      if (gotMint !== solMintStr) throw new Error(`terms.sol_mint mismatch (got=${gotMint} want=${solMintStr})`);
    }

    {
      const nowSec = Math.floor(Date.now() / 1000);
      const refundAfterUnix = Number(normalizedTerms?.refund_after_unix);
      if (!Number.isFinite(refundAfterUnix) || refundAfterUnix <= 0) {
        throw new Error('terms.sol_refund_after_unix missing/invalid');
      }
      const termsTsSec = Math.floor(Number(termsMsg?.ts || 0) / 1000) || nowSec;
      const windowSec = refundAfterUnix - termsTsSec;
      const termsPair = termsCtx.pair;
      const effectiveMinRefundWindowSec = isTaoPair(termsPair)
        ? effectiveMinSettlementRefundAfterSec
        : minSolRefundWindowSec;
      // Allow small clock skew / rounding differences between unix-sec and ms timestamps.
      const slackSec = 120;
      if (effectiveMinRefundWindowSec !== null && windowSec + slackSec < effectiveMinRefundWindowSec) {
        throw new Error(
          `terms.sol_refund_after_unix too soon (window_sec=${windowSec} min=${effectiveMinRefundWindowSec}` +
            ` unsafe_min_provided=${unsafeMinSettlementRefundAfterSecProvided})`
        );
      }
      if (
        maxSolRefundWindowSec !== null &&
        Number.isFinite(maxSolRefundWindowSec) &&
        windowSec - slackSec > maxSolRefundWindowSec
      ) {
        throw new Error(
          `terms.sol_refund_after_unix too far (window_sec=${windowSec} max=${maxSolRefundWindowSec})`
        );
      }
    }

    // Guardrail: terms must match the quote we accepted (prevents bait-and-switch between RFQ and swap channel).
    if (chosen?.quote?.body) {
      const quotePair = normalizePair(chosen.quote.body?.pair || rfqPair);
      const amountField = getAmountFieldForPair(quotePair);
      if (Number(termsMsg.body?.btc_sats) !== Number(chosen.quote.body?.btc_sats)) {
        throw new Error(
          `terms.btc_sats mismatch vs quote (terms=${termsMsg.body?.btc_sats} quote=${chosen.quote.body?.btc_sats})`
        );
      }
      if (String(getAmountForPair(termsMsg.body, quotePair, { allowLegacyTaoFallback: true })) !== String(getAmountForPair(chosen.quote.body, quotePair))) {
        throw new Error(
          `terms.${amountField} mismatch vs quote`
        );
      }
      if (chosen.quote.body?.sol_mint) {
        if (String(termsMsg.body?.sol_mint) !== String(chosen.quote.body?.sol_mint)) {
          throw new Error(
            `terms.sol_mint mismatch vs quote (terms=${termsMsg.body?.sol_mint} quote=${chosen.quote.body?.sol_mint})`
          );
        }
      }
      const quoteRefundField = getQuoteRefundFieldForPair(quotePair);
      if (chosen.quote.body?.[quoteRefundField] !== undefined && chosen.quote.body?.[quoteRefundField] !== null) {
        const quoteWindow = Number(chosen.quote.body?.[quoteRefundField]);
        const refundAfterUnix = Number(normalizedTerms?.refund_after_unix);
        const termsTsSec = Math.floor(Number(termsMsg?.ts || 0) / 1000);
        if (Number.isFinite(quoteWindow) && quoteWindow > 0 && Number.isFinite(refundAfterUnix) && refundAfterUnix > 0 && termsTsSec > 0) {
          const termsWindow = refundAfterUnix - termsTsSec;
          // Allow small clock skew / rounding differences.
          if (Math.abs(termsWindow - quoteWindow) > 120) {
            throw new Error(
              `terms.sol_refund_after_unix mismatch vs quote window (terms_window_sec=${termsWindow} quote_window_sec=${quoteWindow})`
            );
          }
        }
      }
      if (chosen.quote.body?.platform_fee_bps !== undefined && chosen.quote.body?.platform_fee_bps !== null) {
        if (Number(termsMsg.body?.platform_fee_bps) !== Number(chosen.quote.body?.platform_fee_bps)) {
          throw new Error(
            `terms.platform_fee_bps mismatch vs quote (terms=${termsMsg.body?.platform_fee_bps} quote=${chosen.quote.body?.platform_fee_bps})`
          );
        }
      }
      if (chosen.quote.body?.trade_fee_bps !== undefined && chosen.quote.body?.trade_fee_bps !== null) {
        if (Number(termsMsg.body?.trade_fee_bps) !== Number(chosen.quote.body?.trade_fee_bps)) {
          throw new Error(
            `terms.trade_fee_bps mismatch vs quote (terms=${termsMsg.body?.trade_fee_bps} quote=${chosen.quote.body?.trade_fee_bps})`
          );
        }
      }
      if (chosen.quote.body?.trade_fee_collector) {
        if (String(termsMsg.body?.trade_fee_collector) !== String(chosen.quote.body?.trade_fee_collector)) {
          throw new Error(
            `terms.trade_fee_collector mismatch vs quote (terms=${termsMsg.body?.trade_fee_collector} quote=${chosen.quote.body?.trade_fee_collector})`
          );
        }
      }
      if (chosen.quote.body?.platform_fee_collector && termsMsg.body?.platform_fee_collector) {
        if (String(termsMsg.body?.platform_fee_collector) !== String(chosen.quote.body?.platform_fee_collector)) {
          throw new Error(
            `terms.platform_fee_collector mismatch vs quote (terms=${termsMsg.body?.platform_fee_collector} quote=${chosen.quote.body?.platform_fee_collector})`
          );
        }
      }
    }

    // Guardrail: fee ceilings (local policy; on-chain also enforces hard caps).
    const platformFeeBps = Number(termsMsg.body?.platform_fee_bps || 0);
    const tradeFeeBps = Number(termsMsg.body?.trade_fee_bps || 0);
    if (!Number.isFinite(platformFeeBps) || platformFeeBps < 0) throw new Error('terms.platform_fee_bps invalid');
    if (!Number.isFinite(tradeFeeBps) || tradeFeeBps < 0) throw new Error('terms.trade_fee_bps invalid');
    if (platformFeeBps > maxPlatformFeeBps) {
      throw new Error(`terms.platform_fee_bps too high (got=${platformFeeBps} max=${maxPlatformFeeBps})`);
    }
    if (tradeFeeBps > maxTradeFeeBps) {
      throw new Error(`terms.trade_fee_bps too high (got=${tradeFeeBps} max=${maxTradeFeeBps})`);
    }
    if (platformFeeBps + tradeFeeBps > maxTotalFeeBps) {
      throw new Error(
        `terms total fee too high (got=${platformFeeBps + tradeFeeBps} max=${maxTotalFeeBps})`
      );
    }

    const termsHash = hashUnsignedEnvelope(stripSignature(termsMsg));
  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: termsHash },
  });
  const acceptSigned = signSwapEnvelope(acceptUnsigned, signing);
  {
    const r = applySwapEnvelope(swapCtx.trade, acceptSigned);
    if (!r.ok) throw new Error(r.error);
    swapCtx.trade = r.trade;
  }
    swapCtx.sent.accept = acceptSigned;
    await sc.send(swapChannel, acceptSigned);
    process.stdout.write(`${JSON.stringify({ type: 'accept_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'accept_sent', acceptSigned);

    const acceptTimer = setInterval(async () => {
      try {
        checkSwapDeadline();
        if (swapCtx.done) return;
        if (swapCtx.trade.state !== STATE.ACCEPTED && swapCtx.trade.state !== STATE.INIT && swapCtx.trade.state !== STATE.TERMS) return;
        if (swapCtx.trade.invoice) return;
        await sc.send(swapChannel, acceptSigned);
      } catch (_e) {
        process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
    }, Math.max(swapResendMs, 200));
    swapCtx.timers.add(acceptTimer);

    // Wait for invoice + settlement lock proof.
    const invoiceMsg = await waitForSwapMessage((m) => m?.kind === KIND.LN_INVOICE && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'LN_INVOICE',
    });
    persistSwapMessageCheckpoint(invoiceMsg);
    const escrowMsg = await waitForSwapMessage((m) => {
      if (!m || m?.trade_id !== tradeId) return false;
      return isTaoSettlement ? m?.kind === KIND.TAO_HTLC_LOCKED : m?.kind === KIND.SOL_ESCROW_CREATED;
    }, {
      timeoutMs: swapTimeoutSec * 1000,
      label: isTaoSettlement ? 'TAO_HTLC_LOCKED' : 'SOL_ESCROW_CREATED',
    });
    persistSwapMessageCheckpoint(escrowMsg);

    if (swapCtx.trade.invoice) {
      persistTrade(
        {
          ln_invoice_bolt11: swapCtx.trade.invoice.bolt11,
          ln_payment_hash_hex: swapCtx.trade.invoice.payment_hash_hex,
          state: swapCtx.trade.state,
        },
        'ln_invoice_recv',
        swapCtx.trade.invoice
      );
    }
    if (swapCtx.trade.escrow) {
      if (sol?.expectedProgramId && isSolanaSettlement) {
        const gotProgram = String(swapCtx.trade.escrow.program_id || '').trim();
        const wantProgram = String(sol.expectedProgramId || '').trim();
        if (!gotProgram) throw new Error('escrow.program_id missing');
        if (gotProgram !== wantProgram) {
          throw new Error(`escrow.program_id mismatch (got=${gotProgram} want=${wantProgram})`);
        }
      }
      if (sol?.expectedProgramId && isTaoSettlement) {
        const gotProgram = String(swapCtx.trade.escrow.htlc_address || '').trim();
        const wantProgram = String(sol.expectedProgramId || '').trim();
        if (!gotProgram) throw new Error('escrow.htlc_address missing');
        if (gotProgram.toLowerCase() !== wantProgram.toLowerCase()) {
          throw new Error(`escrow.htlc_address mismatch (got=${gotProgram} want=${wantProgram})`);
        }
      }
      if (isTaoSettlement) {
        persistTrade(
          {
            tao_htlc_address: swapCtx.trade.escrow.htlc_address,
            tao_settlement_id: swapCtx.trade.escrow.settlement_id,
            tao_amount_atomic: swapCtx.trade.escrow.amount_atomic,
            tao_recipient: swapCtx.trade.escrow.recipient,
            tao_refund: swapCtx.trade.escrow.refund,
            tao_refund_after_unix: swapCtx.trade.escrow.refund_after_unix,
            tao_lock_tx_id: swapCtx.trade.escrow.tx_id,
            state: swapCtx.trade.state,
          },
          'tao_htlc_locked_recv',
          swapCtx.trade.escrow
        );
      } else {
        persistTrade(
          {
            sol_program_id: swapCtx.trade.escrow.program_id,
            sol_mint: swapCtx.trade.escrow.mint,
            sol_recipient: swapCtx.trade.escrow.recipient,
            sol_refund: swapCtx.trade.escrow.refund,
            sol_escrow_pda: swapCtx.trade.escrow.escrow_pda,
            sol_vault_ata: swapCtx.trade.escrow.vault_ata,
            sol_refund_after_unix: swapCtx.trade.escrow.refund_after_unix,
            state: swapCtx.trade.state,
          },
          'sol_escrow_recv',
          swapCtx.trade.escrow
        );
      }
    }

    // Hard rule: verify settlement lock on-chain before paying.
    const prepay = await sol.settlement.waitForPrepayOnchain({
      terms: swapCtx.trade.terms,
      invoiceBody: swapCtx.trade.invoice,
      escrowBody: swapCtx.trade.escrow,
      nowUnix: Math.floor(Date.now() / 1000),
    });
    if (!prepay.ok) throw new Error(`verify-prepay failed: ${prepay.error}`);
    if (isTaoSettlement && swapCtx.trade.escrow) {
      persistTrade({
        tao_settlement_id: normalizeNonEmptyTextOrNull(swapCtx.trade.escrow.settlement_id),
        tao_htlc_address: normalizeNonEmptyTextOrNull(swapCtx.trade.escrow.htlc_address),
        tao_amount_atomic: normalizeNonEmptyTextOrNull(swapCtx.trade.escrow.amount_atomic),
        tao_refund_after_unix: swapCtx.trade.escrow.refund_after_unix ?? null,
        state: swapCtx.trade.state,
      });
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    const timelockSafety = evaluateLocalTakerPrePayTimelockSafety({
      refundAfterUnix: swapCtx.trade.escrow?.refund_after_unix,
      invoiceExpiryUnix: swapCtx.trade.invoice?.expires_at_unix,
      nowUnix,
      minTimelockRemainingSec,
      invoiceExpirySafetyMarginSec,
    });
    if (timelockSafety.code === 'refund_after_invalid') {
      throw new Error('verify-prepay failed: escrow refund_after_unix missing/invalid');
    }
    if (timelockSafety.code === 'timelock_too_short') {
      throw new Error(
        `verify-prepay failed: refund_after_unix too soon for safe pay (remaining=${timelockSafety.remainingSec}s min=${minTimelockRemainingSec}s)`
      );
    }
    if (timelockSafety.code === 'invoice_expiry_violation_margin') {
      throw new Error(
        `verify-prepay failed: refund_after_unix must be >= invoice_expiry_unix + ${invoiceExpirySafetyMarginSec}s (refund_after_unix=${timelockSafety.refundAfterUnix} invoice_expiry_unix=${timelockSafety.invoiceExpiryUnix})`
      );
    }
    // Defense-in-depth: ensure the on-chain escrow fee receiver settings match the negotiated TERMS, otherwise
    // claim could fail (wrong trade fee vault PDA) or fees could be misrepresented.
    if (isSolanaSettlement && prepay?.onchain?.state?.v === 3) {
      const st = prepay.onchain.state;
      const wantTradeFeeCollector = String(swapCtx.trade.terms?.trade_fee_collector || '').trim();
      const gotTradeFeeCollector = String(st.tradeFeeCollector || '').trim();
      if (wantTradeFeeCollector && gotTradeFeeCollector !== wantTradeFeeCollector) {
        throw new Error(
          `onchain tradeFeeCollector mismatch vs terms (state=${gotTradeFeeCollector} terms=${wantTradeFeeCollector})`
        );
      }
      const wantTradeFeeBps = Number(swapCtx.trade.terms?.trade_fee_bps || 0);
      if (Number.isFinite(wantTradeFeeBps) && Number(st.tradeFeeBps) !== wantTradeFeeBps) {
        throw new Error(`onchain tradeFeeBps mismatch vs terms (state=${st.tradeFeeBps} terms=${wantTradeFeeBps})`);
      }
      const wantPlatformFeeCollector = String(swapCtx.trade.terms?.platform_fee_collector || '').trim();
      const gotPlatformFeeCollector = String(st.platformFeeCollector || '').trim();
      if (wantPlatformFeeCollector && gotPlatformFeeCollector !== wantPlatformFeeCollector) {
        throw new Error(
          `onchain platformFeeCollector mismatch vs terms (state=${gotPlatformFeeCollector} terms=${wantPlatformFeeCollector})`
        );
      }
      const wantPlatformFeeBps = Number(swapCtx.trade.terms?.platform_fee_bps || 0);
      if (Number.isFinite(wantPlatformFeeBps) && Number(st.platformFeeBps) !== wantPlatformFeeBps) {
        throw new Error(`onchain platformFeeBps mismatch vs terms (state=${st.platformFeeBps} terms=${wantPlatformFeeBps})`);
      }
    }

    if (testStopBeforeLnPay) {
      const stopPayload = buildTestStopBeforeLnPayPayload({
        tradeId,
        swapChannel,
        invoice: swapCtx.trade.invoice,
        escrow: swapCtx.trade.escrow,
      });
      process.stderr.write('[taker] TEST MODE: stopping immediately before lnPay(); invoice will not be paid\n');
      process.stdout.write(`${JSON.stringify({ type: 'test_stop_before_ln_pay', ...stopPayload })}\n`);
      persistTrade(
        {
          ln_invoice_bolt11: stopPayload.ln_invoice_bolt11,
          ln_payment_hash_hex: stopPayload.ln_payment_hash_hex,
          state: swapCtx.trade.state,
          last_error: stopPayload.stop_reason,
        },
        'test_stop_before_ln_pay',
        stopPayload
      );
      swapCtx.done = true;
      done = true;
      clearTimers();
      await leaveSidechannel(swapChannel);
      try {
        receipts?.close();
      } catch (_e) {
        process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
      sc.close();
      process.exit(0);
    }

    // Pay LN invoice and obtain preimage.
    const payRes = await lnPay(ln, { bolt11: swapCtx.trade.invoice.bolt11 });
    const preimageHex = String(payRes?.payment_preimage || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error('LN pay missing payment_preimage');

    const paymentHashHex = String(swapCtx.trade.invoice.payment_hash_hex || '').trim().toLowerCase();

  const lnPaidUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_PAID,
    tradeId,
    body: { payment_hash_hex: paymentHashHex },
  });
  const lnPaidSigned = signSwapEnvelope(lnPaidUnsigned, signing);
  {
    const r = applySwapEnvelope(swapCtx.trade, lnPaidSigned);
    if (!r.ok) throw new Error(r.error);
    swapCtx.trade = r.trade;
  }
    swapCtx.sent.ln_paid = lnPaidSigned;
    await sc.send(swapChannel, lnPaidSigned);
    process.stdout.write(`${JSON.stringify({ type: 'ln_paid_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);

    persistTrade(
      {
        ln_payment_hash_hex: paymentHashHex,
        ln_preimage_hex: persistPreimage ? preimageHex : null,
        state: swapCtx.trade.state,
      },
      'ln_paid',
      { payment_hash_hex: paymentHashHex }
    );

    const stoppedAfterLnPayBeforeClaim = await maybeHandleTestStopAfterLnPayBeforeClaim({
      enabled: testStopAfterLnPayBeforeClaim,
      tradeId,
      swapChannel,
      settlementKind,
      tradeState: swapCtx.trade.state,
      paymentHashHex,
      preimageHex: persistPreimage ? preimageHex : null,
      escrow: swapCtx.trade.escrow,
      persistTrade,
      writeWarning: (line) => process.stderr.write(line),
      writeEvent: (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`),
      cleanupAndExit: async () => {
        swapCtx.done = true;
        done = true;
        clearTimers();
        await leaveSidechannel(swapChannel);
        try {
          receipts?.close();
        } catch (_e) {
          process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
        }
        sc.close();
        process.exit(0);
      },
    });
    if (stoppedAfterLnPayBeforeClaim) return;

    if (stopAfterLnPay) {
      // Recovery path: operator can claim via `scripts/swaprecover.mjs claim ...`.
      swapCtx.done = true;
      done = true;
      clearTimers();
      process.stdout.write(`${JSON.stringify({ type: 'stopped_after_ln_pay', trade_id: tradeId, swap_channel: swapChannel })}\n`);
      await leaveSidechannel(swapChannel);
      try {
        receipts?.close();
      } catch (_e) {
        process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
      sc.close();
      process.exit(0);
    }

    // Claim settlement lock on-chain.
    const settlementId = String(isTaoSettlement ? swapCtx.trade.escrow?.settlement_id : swapCtx.trade.escrow?.escrow_pda || '').trim();
    if (!settlementId) throw new Error('Missing escrow settlementId');
    const claimRes = await sol.settlement.claim({ settlementId, preimageHex });
    const claimSig = String(claimRes?.txId || '').trim();
    if (!claimSig) throw new Error('Missing claim txId from settlement provider');

  const solClaimedUnsigned = createUnsignedEnvelope(
    isTaoSettlement
      ? {
          v: 1,
          kind: KIND.TAO_CLAIMED,
          tradeId,
          body: {
            payment_hash_hex: paymentHashHex,
            settlement_id: settlementId,
            tx_id: claimSig,
          },
        }
      : {
          v: 1,
          kind: KIND.SOL_CLAIMED,
          tradeId,
          body: {
            payment_hash_hex: paymentHashHex,
            escrow_pda: swapCtx.trade.escrow.escrow_pda,
            tx_sig: claimSig,
          },
        }
  );
  const solClaimedSigned = signSwapEnvelope(solClaimedUnsigned, signing);
  swapCtx.sent.sol_claimed = solClaimedSigned;
  await sc.send(swapChannel, solClaimedSigned);
    process.stdout.write(
      `${JSON.stringify({
        type: isTaoSettlement ? 'tao_claimed_sent' : 'sol_claimed_sent',
        trade_id: tradeId,
        swap_channel: swapChannel,
        tx_id: isTaoSettlement ? claimSig : undefined,
        tx_sig: isTaoSettlement ? undefined : claimSig,
      })}\n`
    );
    persistTrade(
      {
        ...(isTaoSettlement
          ? {
              tao_settlement_id: settlementId,
              tao_claim_tx_id: claimSig,
            }
          : {}),
        state: swapCtx.trade.state,
      },
      isTaoSettlement ? 'tao_claimed' : 'sol_claimed',
      solClaimedSigned
    );

    // Best-effort: resend final proofs a few times to reduce "sent but peer exited" flakiness.
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await sc.send(swapChannel, solClaimedSigned);
      } catch (_e) {
        process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
      }
    }

    swapCtx.done = true;
    done = true;
    clearTimers();
    process.stdout.write(`${JSON.stringify({ type: 'swap_done', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: STATE.CLAIMED }, 'swap_done', { trade_id: tradeId, swap_channel: swapChannel });
    await leaveSidechannel(swapChannel);
    maybeExit();
    };

    sc.on('sidechannel_message', async (evt) => {
      try {
        if (swapCtx && evt?.channel === swapCtx.swapChannel) {
          const msg = evt?.message;
          if (!msg || typeof msg !== 'object') return;
          const v = validateSwapEnvelope(msg);
          if (!v.ok) return;
          const r = applySwapEnvelope(swapCtx.trade, msg);
          if (r.ok) {
            swapCtx.trade = r.trade;
            persistSwapMessageCheckpoint(msg);
          }
          for (const waiter of swapCtx.waiters) {
            try {
              waiter(msg);
            } catch (_e) {
              process.stderr.write(`[taker] ERROR: ${_e?.stack || _e?.message || String(_e)}\n`);
            }
          }
          return;
        }

        if (evt?.channel !== rfqChannel) return;
        const msg = evt?.message;
        if (!msg || typeof msg !== 'object') return;
        process.stderr.write(
          `[taker] rfq_inbound channel=${rfqChannel} msg_kind=${String(msg.kind || msg.type || 'unknown')} ` +
            `looks_signed_quote=${msg.kind === KIND.QUOTE || (msg?.body?.quote_id && msg?.sig ? 'yes' : 'no')} ` +
            `trade_id=${String(msg.trade_id || 'n/a')} rfq_id=${String(msg?.body?.rfq_id || 'n/a')}\n`
        );

        if (msg.kind === KIND.QUOTE) {
          if (String(msg.trade_id) !== tradeId) {
            process.stderr.write(
              `[taker] quote_reject reason=trade_id_mismatch actual_trade_id=${String(msg.trade_id || '')} expected_trade_id=${tradeId}\n`
            );
            return;
          }
          const v = validateLocalTakerEnvelope(msg, { effectiveMinSettlementRefundAfterSec });
          if (!v.ok) {
            process.stderr.write(
              `[taker] quote_reject reason=invalid_envelope trade_id=${tradeId} rfq_id=${String(msg?.body?.rfq_id || 'n/a')} error=${v.error || 'unknown'}\n`
            );
            return;
          }
          const quoteAppHash = String(msg?.body?.app_hash || '').trim().toLowerCase();
          if (quoteAppHash !== expectedAppHash) {
            process.stderr.write(
              `[taker] quote_reject reason=app_hash_mismatch trade_id=${tradeId} rfq_id=${String(msg?.body?.rfq_id || 'n/a')} ` +
                `actual_app_hash=${quoteAppHash || 'n/a'} expected_app_hash=${expectedAppHash || 'n/a'}\n`
            );
            return;
          }
          const quoteUnsigned = stripSignature(msg);
          const quoteId = hashUnsignedEnvelope(quoteUnsigned);
          const rfqIdGot = String(msg.body?.rfq_id || '').trim().toLowerCase();
          if (rfqIdGot !== rfqId) {
            process.stderr.write(
              `[taker] quote_reject reason=rfq_id_mismatch trade_id=${tradeId} actual_rfq_id=${rfqIdGot || 'n/a'} expected_rfq_id=${rfqId}\n`
            );
            return;
          }

          const validUntil = Number(msg.body?.valid_until_unix);
          const now = Math.floor(Date.now() / 1000);
          if (Number.isFinite(validUntil) && validUntil <= now) {
            process.stderr.write(
              `[taker] quote_reject reason=expired quote_id=${quoteId} valid_until_unix=${validUntil} now_unix=${now}\n`
            );
            if (debug) process.stderr.write(`[taker] ignore expired quote quote_id=${quoteId}\n`);
            return;
          }

          // Pre-filtering: require explicit fee preview in QUOTE so we can reject before joining swap:<id>.
          const quotePlatformFeeBps = Number(msg.body?.platform_fee_bps);
          const quoteTradeFeeBps = Number(msg.body?.trade_fee_bps);
          if (!Number.isFinite(quotePlatformFeeBps) || quotePlatformFeeBps < 0) {
            process.stderr.write(`[taker] quote_reject reason=invalid_platform_fee quote_id=${quoteId} value=${msg.body?.platform_fee_bps ?? 'n/a'}\n`);
            return;
          }
          if (!Number.isFinite(quoteTradeFeeBps) || quoteTradeFeeBps < 0) {
            process.stderr.write(`[taker] quote_reject reason=invalid_trade_fee quote_id=${quoteId} value=${msg.body?.trade_fee_bps ?? 'n/a'}\n`);
            return;
          }
          if (quotePlatformFeeBps > maxPlatformFeeBps) {
            process.stderr.write(
              `[taker] quote_reject reason=platform_fee_cap_exceeded quote_id=${quoteId} actual=${quotePlatformFeeBps} max=${maxPlatformFeeBps}\n`
            );
            return;
          }
          if (quoteTradeFeeBps > maxTradeFeeBps) {
            process.stderr.write(
              `[taker] quote_reject reason=trade_fee_cap_exceeded quote_id=${quoteId} actual=${quoteTradeFeeBps} max=${maxTradeFeeBps}\n`
            );
            return;
          }
          if (quotePlatformFeeBps + quoteTradeFeeBps > maxTotalFeeBps) {
            process.stderr.write(
              `[taker] quote_reject reason=total_fee_cap_exceeded quote_id=${quoteId} actual=${quotePlatformFeeBps + quoteTradeFeeBps} max=${maxTotalFeeBps}\n`
            );
            return;
          }

          // Pre-filtering: require explicit refund/claim window advertised in QUOTE (seconds).
          const quotePair = normalizePair(msg.body?.pair || rfqPair);
          const quoteRefundWindowSec = Number(msg.body?.[getQuoteRefundFieldForPair(quotePair)]);
          const effectiveQuoteMinRefundWindowSec = resolveEffectiveQuoteMinRefundWindowSec({
            quotePair,
            effectiveMinSettlementRefundAfterSec,
            minSolRefundWindowSec,
            maxSolRefundWindowSec,
            settlementRefundAfterSec,
            minSec: SETTLEMENT_REFUND_MIN_SEC,
            maxSec: SETTLEMENT_REFUND_MAX_SEC,
          });
          if (!Number.isFinite(quoteRefundWindowSec) || quoteRefundWindowSec <= 0) {
            process.stderr.write(
              `[taker] quote_reject reason=invalid_refund_window quote_id=${quoteId} pair=${quotePair} ` +
                `field=${getQuoteRefundFieldForPair(quotePair)} value=${msg.body?.[getQuoteRefundFieldForPair(quotePair)] ?? 'n/a'}\n`
            );
            return;
          }
          if (effectiveQuoteMinRefundWindowSec !== null && quoteRefundWindowSec < effectiveQuoteMinRefundWindowSec) {
            process.stderr.write(
              `[taker] quote_reject reason=refund_window_too_short quote_id=${quoteId} pair=${quotePair} ` +
                `actual=${quoteRefundWindowSec} min=${effectiveQuoteMinRefundWindowSec} ` +
                `unsafe_min_provided=${unsafeMinSettlementRefundAfterSecProvided}\n`
            );
            return;
          }
          if (maxSolRefundWindowSec !== null && Number.isFinite(maxSolRefundWindowSec) && quoteRefundWindowSec > maxSolRefundWindowSec) {
            process.stderr.write(
              `[taker] quote_reject reason=refund_window_too_long quote_id=${quoteId} pair=${quotePair} actual=${quoteRefundWindowSec} max=${maxSolRefundWindowSec}\n`
            );
            return;
          }

          if (!chosen) {
            // Guardrail: only accept quotes for the exact requested size.
            if (Number(msg.body?.btc_sats) !== Number(btcSats)) {
              process.stderr.write(
                `[taker] quote_reject reason=btc_sats_mismatch quote_id=${quoteId} actual=${msg.body?.btc_sats ?? 'n/a'} expected=${btcSats}\n`
              );
              return;
            }

            const quoteAmountStr = String(getAmountForPair(msg.body, quotePair) || '').trim();
            const quoteAmount = asBigIntAmount(quoteAmountStr);
            if (quoteAmount === null) {
              process.stderr.write(
                `[taker] quote_reject reason=invalid_amount quote_id=${quoteId} pair=${quotePair} value=${quoteAmountStr || 'n/a'}\n`
              );
              return;
            }

            // Guardrail: treat RFQ usdt_amount as a minimum when set (>0).
            const rfqMin = asBigIntAmount(usdtAmount) ?? 0n;
            if (rfqMin > 0n && quoteAmount < rfqMin) {
              process.stderr.write(
                `[taker] quote_reject reason=amount_below_rfq_min quote_id=${quoteId} actual=${quoteAmount.toString()} min=${rfqMin.toString()}\n`
              );
              return;
            }

            chosen = { rfq_id: rfqId, quote_id: quoteId, quote: msg };
            process.stderr.write(
              `[taker] quote_accept quote_id=${quoteId} pair=${quotePair} actual=${quoteRefundWindowSec} ` +
                `min=${effectiveQuoteMinRefundWindowSec} unsafe_min_provided=${unsafeMinSettlementRefundAfterSecProvided}\n`
            );
            const quoteAcceptUnsigned = createUnsignedEnvelope({
              v: 1,
              kind: KIND.QUOTE_ACCEPT,
              tradeId,
              body: {
                rfq_id: rfqId,
                quote_id: quoteId,
              },
            });
            quoteAcceptSigned = signSwapEnvelope(quoteAcceptUnsigned, signing);
            ensureOk(await sc.send(rfqChannel, quoteAcceptSigned), 'send quote_accept');
            if (debug) process.stderr.write(`[taker] accepted quote trade_id=${tradeId} quote_id=${quoteId}\n`);
            process.stdout.write(`${JSON.stringify({ type: 'quote_accepted', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId })}\n`);

            persistTrade({ state: STATE.INIT }, 'quote_accepted', quoteAcceptSigned);
          }
          return;
        }

        if (msg.kind === KIND.SWAP_INVITE) {
          if (String(msg.trade_id) !== tradeId) return;
          const v = validateSwapEnvelope(msg);
          if (!v.ok) return;
          if (!chosen) return;
          if (String(msg.body?.rfq_id || '').trim().toLowerCase() !== chosen.rfq_id) return;
          if (String(msg.body?.quote_id || '').trim().toLowerCase() !== chosen.quote_id) return;

          // Guardrail: only accept swap invites from the same maker that authored the quote we accepted.
          const quoteMaker = String(chosen?.quote?.signer || '').trim().toLowerCase();
          const ownerPubkey = String(msg.body?.owner_pubkey || '').trim().toLowerCase();
          const inviterPubkey = String(msg.body?.invite?.payload?.inviterPubKey || '').trim().toLowerCase();
          const inviteMaker = ownerPubkey || inviterPubkey;
          if (quoteMaker && inviteMaker && inviteMaker !== quoteMaker) return;

          const swapChannel = String(msg.body?.swap_channel || '').trim();
          if (!swapChannel) return;

          const invite = msg.body?.invite || null;
          const welcome = msg.body?.welcome || null;

          // Best-effort: ensure the invite is for us (defense-in-depth).
          const invitee = String(invite?.payload?.inviteePubKey || '').trim().toLowerCase();
          if (invitee && invitee !== takerPubkey) return;

          // Dedupe: SWAP_INVITE can be re-broadcast. Never restart the swap state machine.
          if (joined || swapCtx || joinSwapInFlight) {
            if (debug) process.stderr.write(`[taker] ignore duplicate swap_invite trade_id=${tradeId}\n`);
            return;
          }
          joinSwapInFlight = true;
          try {
            ensureOk(await sc.join(swapChannel, { invite, welcome }), `join ${swapChannel}`);
          } finally {
            joinSwapInFlight = false;
          }
          joined = true;
          stopTimers();
          clearInterval(enforceTimeout);
          process.stdout.write(
            `${JSON.stringify({
              type: 'swap_joined',
              trade_id: tradeId,
              swap_channel: swapChannel,
              ...buildSwapLogFields({
                pair: rfqPair,
                settlementKind,
                btcSats,
                amountAtomic: usdtAmount,
              }),
            })}\n`
          );

          persistTrade(
            {
              swap_channel: swapChannel,
              maker_peer: msg.body?.owner_pubkey ? String(msg.body.owner_pubkey).trim().toLowerCase() : null,
              btc_sats: btcSats,
              usdt_amount: isTaoPair(rfqPair) ? null : usdtAmount,
              ...(isTaoPair(rfqPair) ? { tao_amount_atomic: usdtAmount } : {}),
              state: STATE.INIT,
            },
            'swap_joined',
            { swap_channel: swapChannel }
          );

          if (!runSwap) {
            if (once) await leaveSidechannel(swapChannel);
            done = true;
            maybeExit();
            return;
          }

          // Swap state machine is run asynchronously; the process stays alive.
          startSwap({ swapChannel, invite }).catch(async (err) => {
            await leaveSidechannel(swapChannel);
            die(err?.stack || err?.message || String(err));
          });
        }
      } catch (err) {
        process.stderr.write(`[taker] ERROR: ${err?.stack || err?.message || String(err)}\n`);
      }
    });

    // Keep process alive.
    await new Promise(() => {});
  };

  await runSingleTradeCycle();
}

const isDirectRun = (() => {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
  return import.meta.url === entry;
})();

if (isDirectRun) {
  main().catch((err) => die(err?.stack || err?.message || String(err)));
}
