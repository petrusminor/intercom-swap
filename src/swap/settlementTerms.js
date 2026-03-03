export function getTermsSettlementRecipient(terms) {
  return terms?.sol_recipient;
}

export function getTermsSettlementRefundAddress(terms) {
  return terms?.sol_refund;
}

export function getTermsSettlementRefundAfterUnix(terms) {
  return terms?.sol_refund_after_unix;
}

export function getTermsSettlementAssetId(terms, pair) {
  return terms?.sol_mint;
}

export function normalizeSettlementTerms(terms, pair) {
  return {
    settlement_recipient: getTermsSettlementRecipient(terms),
    refund_address: getTermsSettlementRefundAddress(terms),
    refund_after_unix: getTermsSettlementRefundAfterUnix(terms),
    settlement_asset_id: getTermsSettlementAssetId(terms, pair),
  };
}
