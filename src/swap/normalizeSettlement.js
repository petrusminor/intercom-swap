import { getAmountForPair, getPairSettlementKind, normalizePair } from './pairs.js';

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

export function normalizeSettlement(pair, args = {}) {
  const normalizedPair = normalizePair(pair);
  const pairAmount = getAmountForPair(args, normalizedPair, { allowLegacyTaoFallback: true });

  return {
    recipient: firstNonEmpty(args?.recipient, args?.sol_recipient, args?.tao_recipient),
    refund: firstNonEmpty(args?.refund, args?.sol_refund, args?.tao_refund),
    refund_after_unix: firstNonEmpty(args?.refund_after_unix, args?.sol_refund_after_unix, args?.tao_refund_after_unix),
    amount: firstNonEmpty(args?.amount, pairAmount),
    settlement_kind: getPairSettlementKind(normalizedPair),
    settlement_asset_id: firstNonEmpty(args?.mint, args?.sol_mint, args?.tao_htlc_address),
  };
}
