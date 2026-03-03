export function computeSettlementAmountWithFeeCeil(settlementAmountAtomic, settlementFeeBpsAppliedToSettlementAmount) {
  const settlementAmount = BigInt(String(settlementAmountAtomic || 0));
  const settlementFeeBps = Number.isFinite(settlementFeeBpsAppliedToSettlementAmount)
    ? Math.max(0, Math.min(15_000, Math.trunc(settlementFeeBpsAppliedToSettlementAmount)))
    : 0;
  if (settlementFeeBps <= 0) return settlementAmount;
  return (settlementAmount * BigInt(10_000 + settlementFeeBps) + 9_999n) / 10_000n;
}

export function normalizeSettlementFeeCapsBps(
  {
    max_platform_fee_bps: rawMaxPlatformFeeBps,
    max_trade_fee_bps: rawMaxTradeFeeBps,
    max_total_fee_bps: rawMaxTotalFeeBps,
  },
  {
    defaultPlatformFeeBps,
    defaultTradeFeeBps,
    defaultTotalFeeBps,
  }
) {
  const settlementLegMaxPlatformFeeBps = Math.max(
    0,
    Math.min(500, rawMaxPlatformFeeBps ?? defaultPlatformFeeBps)
  );
  const settlementLegMaxTradeFeeBps = Math.max(
    0,
    Math.min(1000, rawMaxTradeFeeBps ?? defaultTradeFeeBps)
  );
  const settlementLegMaxTotalFeeBps = Math.max(
    0,
    Math.min(1500, rawMaxTotalFeeBps ?? defaultTotalFeeBps)
  );
  return {
    settlementLegMaxPlatformFeeBps,
    settlementLegMaxTradeFeeBps,
    settlementLegMaxTotalFeeBps,
  };
}
