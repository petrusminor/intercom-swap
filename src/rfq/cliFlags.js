import { SETTLEMENT_KIND } from '../../settlement/providerFactory.js';

export const DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC = 72 * 3600;

function parseOptionalIntFlag(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (value === true) throw new Error(`Invalid --${label}`);
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid --${label}`);
  return n;
}

function parseRequiredPositiveAmount(value, label) {
  const s = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(s) || BigInt(s) <= 0n) {
    throw new Error(`Invalid --${label} (must be a positive base-unit integer; open RFQ amount=0 is not supported)`);
  }
  return s;
}

export function resolveSettlementRefundAfterSec({
  settlementRefundAfterSecRaw,
  legacySolanaRefundAfterSecRaw,
  fallbackSec,
  minSec,
  maxSec,
}) {
  const warnings = [];
  const canonical = parseOptionalIntFlag(settlementRefundAfterSecRaw, 'settlement-refund-after-sec');
  const legacy = parseOptionalIntFlag(legacySolanaRefundAfterSecRaw, 'solana-refund-after-sec');
  const settlementRefundAfterSec = canonical ?? legacy ?? fallbackSec;

  if (canonical === null && legacy !== null) {
    warnings.push('Warning: --solana-refund-after-sec is deprecated; use --settlement-refund-after-sec');
  }
  if (!Number.isFinite(settlementRefundAfterSec) || settlementRefundAfterSec < minSec) {
    throw new Error(`Invalid --settlement-refund-after-sec (must be >= ${minSec})`);
  }
  if (settlementRefundAfterSec > maxSec) {
    throw new Error(`Invalid --settlement-refund-after-sec (must be <= ${maxSec})`);
  }
  return { settlementRefundAfterSec, warnings };
}

export function resolveUnsafeMinSettlementRefundAfterSec({
  unsafeMinSettlementRefundAfterSecRaw,
  fallbackSec = DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC,
  maxSec,
}) {
  const unsafeMin = parseOptionalIntFlag(
    unsafeMinSettlementRefundAfterSecRaw,
    'unsafe-min-settlement-refund-after-sec'
  );
  if (unsafeMin === null) {
    return {
      effectiveMinSettlementRefundAfterSec: fallbackSec,
      unsafeMinProvided: false,
      warnings: [],
    };
  }
  if (!Number.isFinite(unsafeMin) || unsafeMin < 1) {
    throw new Error('Invalid --unsafe-min-settlement-refund-after-sec (must be >= 1)');
  }
  if (Number.isFinite(maxSec) && unsafeMin > maxSec) {
    throw new Error(`Invalid --unsafe-min-settlement-refund-after-sec (must be <= ${maxSec})`);
  }
  return {
    effectiveMinSettlementRefundAfterSec: unsafeMin,
    unsafeMinProvided: true,
    warnings: [
      `UNSAFE: lowering taker minimum settlement refund window to ${unsafeMin}s for this process only`,
    ],
  };
}

export function resolveRfqSettlementAmountAtomic({
  settlementKind,
  usdtAmountRaw,
  taoAmountAtomicRaw,
  fallbackUsdtAmount,
}) {
  const warnings = [];
  const hasUsdt = usdtAmountRaw !== undefined && usdtAmountRaw !== null && usdtAmountRaw !== '';
  const hasTao = taoAmountAtomicRaw !== undefined && taoAmountAtomicRaw !== null && taoAmountAtomicRaw !== '';

  if (settlementKind === SETTLEMENT_KIND.SOLANA) {
    if (hasTao) {
      throw new Error('Invalid --tao-amount-atomic (only valid when --settlement tao-evm)');
    }
    return {
      amountAtomic: parseRequiredPositiveAmount(hasUsdt ? usdtAmountRaw : fallbackUsdtAmount, 'usdt-amount'),
      warnings,
    };
  }

  // TAO mode: canonical flag is --tao-amount-atomic, but keep --usdt-amount as a compatibility alias.
  if (hasTao) {
    return {
      amountAtomic: parseRequiredPositiveAmount(taoAmountAtomicRaw, 'tao-amount-atomic'),
      warnings,
    };
  }

  if (hasUsdt) {
    warnings.push('--usdt-amount is deprecated in tao-evm mode; use --tao-amount-atomic');
    return {
      amountAtomic: parseRequiredPositiveAmount(usdtAmountRaw, 'usdt-amount'),
      warnings,
    };
  }

  return {
    amountAtomic: parseRequiredPositiveAmount(fallbackUsdtAmount, 'tao-amount-atomic'),
    warnings,
  };
}
