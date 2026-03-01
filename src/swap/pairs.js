import { ASSET, DIR, PAIR } from './constants.js';

export const DEFAULT_PAIR = PAIR.BTC_LN__USDT_SOL;
export const SETTLEMENT_KIND_SOLANA = 'solana';
export const SETTLEMENT_KIND_TAO_EVM = 'tao-evm';

const PAIR_CONFIG = Object.freeze({
  [PAIR.BTC_LN__USDT_SOL]: Object.freeze({
    pair: PAIR.BTC_LN__USDT_SOL,
    direction: DIR.BTC_LN__TO__USDT_SOL,
    have: ASSET.USDT_SOL,
    want: ASSET.BTC_LN,
    settlementKind: SETTLEMENT_KIND_SOLANA,
    amountField: 'usdt_amount',
    quoteRefundField: 'sol_refund_window_sec',
    rfqMinRefundField: 'min_sol_refund_window_sec',
    rfqMaxRefundField: 'max_sol_refund_window_sec',
    offerExactRefundField: null,
  }),
  [PAIR.BTC_LN__TAO_EVM]: Object.freeze({
    pair: PAIR.BTC_LN__TAO_EVM,
    direction: DIR.BTC_LN__TO__TAO_EVM,
    have: ASSET.TAO_EVM,
    want: ASSET.BTC_LN,
    settlementKind: SETTLEMENT_KIND_TAO_EVM,
    amountField: 'tao_amount_atomic',
    quoteRefundField: 'settlement_refund_after_sec',
    rfqMinRefundField: null,
    rfqMaxRefundField: null,
    offerExactRefundField: 'settlement_refund_after_sec',
  }),
});

export function getPairConfig(pair) {
  const key = String(pair || '').trim();
  return PAIR_CONFIG[key] || PAIR_CONFIG[DEFAULT_PAIR];
}

export function normalizePair(pair) {
  return getPairConfig(pair).pair;
}

export function isSupportedPair(pair) {
  const key = String(pair || '').trim();
  return Object.prototype.hasOwnProperty.call(PAIR_CONFIG, key);
}

export function getDirectionForPair(pair) {
  return getPairConfig(pair).direction;
}

export function getHaveAssetForPair(pair) {
  return getPairConfig(pair).have;
}

export function getWantAssetForPair(pair) {
  return getPairConfig(pair).want;
}

export function getSettlementKindForPair(pair) {
  return getPairConfig(pair).settlementKind;
}

export const getPairSettlementKind = getSettlementKindForPair;

export function getAmountFieldForPair(pair) {
  return getPairConfig(pair).amountField;
}

export function getQuoteRefundFieldForPair(pair) {
  return getPairConfig(pair).quoteRefundField;
}

export function getOfferExactRefundFieldForPair(pair) {
  return getPairConfig(pair).offerExactRefundField;
}

export function getRfqRefundRangeFieldsForPair(pair) {
  const cfg = getPairConfig(pair);
  return {
    minField: cfg.rfqMinRefundField,
    maxField: cfg.rfqMaxRefundField,
  };
}

export function getAmountForPair(body, pair, { allowLegacyTaoFallback = false } = {}) {
  const cfg = getPairConfig(pair);
  if (!body || typeof body !== 'object') return '';
  const direct = String(body[cfg.amountField] || '').trim();
  if (direct) return direct;
  if (allowLegacyTaoFallback && cfg.pair === PAIR.BTC_LN__TAO_EVM) {
    return String(body.usdt_amount || '').trim();
  }
  return '';
}

export function setAmountForPair(target, pair, amount) {
  const cfg = getPairConfig(pair);
  target[cfg.amountField] = amount;
  return target;
}

export function isTaoPair(pair) {
  return normalizePair(pair) === PAIR.BTC_LN__TAO_EVM;
}
