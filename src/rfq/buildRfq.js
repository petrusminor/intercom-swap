import { createUnsignedEnvelope } from '../protocol/signedMessage.js';
import { KIND } from '../swap/constants.js';
import { getAmountFieldForPair, getDirectionForPair, getPairSettlementKind, isTaoPair } from '../swap/pairs.js';

export function buildRfqUnsignedEnvelope({
  tradeId,
  pair,
  expectedAppHash,
  btcSats,
  amountAtomic,
  maxPlatformFeeBps,
  maxTradeFeeBps,
  maxTotalFeeBps,
  settlementRefundAfterSec,
  minSolRefundWindowSec,
  maxSolRefundWindowSec,
  solRecipient = null,
  solMint = null,
  validUntilUnix,
}) {
  return createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId,
    body: {
      pair,
      direction: getDirectionForPair(pair),
      app_hash: expectedAppHash,
      btc_sats: btcSats,
      [getAmountFieldForPair(pair)]: amountAtomic,
      settlement_kind: getPairSettlementKind(pair),
      max_platform_fee_bps: maxPlatformFeeBps,
      max_trade_fee_bps: maxTradeFeeBps,
      max_total_fee_bps: maxTotalFeeBps,
      ...(isTaoPair(pair)
        ? {
            settlement_refund_after_sec: settlementRefundAfterSec,
          }
        : {
            min_sol_refund_window_sec: minSolRefundWindowSec,
            max_sol_refund_window_sec: maxSolRefundWindowSec,
          }),
      ...(solRecipient ? { sol_recipient: solRecipient } : {}),
      ...(solMint ? { sol_mint: solMint } : {}),
      valid_until_unix: validUntilUnix,
    },
  });
}
