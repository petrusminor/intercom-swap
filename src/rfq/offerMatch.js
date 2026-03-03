import { getSettlementBinding } from '../../settlement/providerFactory.js';
import { deriveIntercomswapAppHashForBinding } from '../swap/app.js';
import { KIND, ASSET } from '../swap/constants.js';
import { normalizeSettlementFeeCapsBps } from '../swap/fees.js';
import { validateSwapEnvelope } from '../swap/schema.js';
import {
  DEFAULT_PAIR,
  getAmountFieldForPair,
  getAmountForPair,
  getDirectionForPair,
  getHaveAssetForPair,
  getPairSettlementKind,
  isTaoPair,
  normalizePair,
} from '../swap/pairs.js';

export const OFFER_REFUND_MIN_SEC = 3600;
export const OFFER_REFUND_MAX_SEC = 7 * 24 * 3600;

function includesChannel(list, channel) {
  if (!Array.isArray(list) || list.length < 1) return true;
  const wanted = String(channel || '').trim();
  if (!wanted) return false;
  return list.some((value) => String(value || '').trim() === wanted);
}

function getExpectedOfferAppHash(pair, { expectedProgramId, taoHtlcAddress }) {
  const settlementKind = getPairSettlementKind(pair);
  const binding = getSettlementBinding(settlementKind, {
    solanaProgramId: expectedProgramId,
    taoHtlcAddress,
  });
  return deriveIntercomswapAppHashForBinding(binding);
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function validateOfferFieldsForPair(offer, pair) {
  if (isTaoPair(pair)) {
    if (hasValue(offer.usdt_amount)) return { ok: false, error: 'TAO offer cannot include usdt_amount' };
    if (hasValue(offer.min_sol_refund_window_sec) || hasValue(offer.max_sol_refund_window_sec)) {
      return { ok: false, error: 'TAO offer cannot include Solana refund window fields' };
    }
    return { ok: true, error: null };
  }
  if (hasValue(offer.tao_amount_atomic)) return { ok: false, error: 'USDT offer cannot include tao_amount_atomic' };
  if (hasValue(offer.settlement_refund_after_sec)) {
    return { ok: false, error: 'USDT offer cannot include settlement_refund_after_sec' };
  }
  return { ok: true, error: null };
}

function normalizeMatchedOffer(offer, {
  channel,
  body,
  pair,
  validUntilUnix,
  refundMinSec,
  refundMaxSec,
}) {
  const amountField = getAmountFieldForPair(pair);
  const amount = String(getAmountForPair(offer, pair) || '').trim();
  const settlementKind = getPairSettlementKind(pair);
  return {
    pair,
    direction: getDirectionForPair(pair),
    settlement_kind: settlementKind,
    have: getHaveAssetForPair(pair),
    want: ASSET.BTC_LN,
    offer_channel: channel,
    offer_name: String(body.name || ''),
    offer_signer: String(offer.__signer || '').trim().toLowerCase() || null,
    offer_valid_until_unix: validUntilUnix,
    amount_field: amountField,
    amount_atomic: amount,
    btc_sats: Number(offer.btc_sats),
    [amountField]: amount,
    max_platform_fee_bps: Number(offer.max_platform_fee_bps),
    max_trade_fee_bps: Number(offer.max_trade_fee_bps),
    max_total_fee_bps: Number(offer.max_total_fee_bps),
    ...(isTaoPair(pair)
      ? { settlement_refund_after_sec: refundMinSec }
      : {
          min_sol_refund_window_sec: refundMinSec,
          max_sol_refund_window_sec: refundMaxSec,
        }),
  };
}

export function matchOfferAnnouncementEvent(evt, opts = {}) {
  const offerChannels = Array.isArray(opts.offerChannels) ? opts.offerChannels : [];
  const rfqChannel = String(opts.rfqChannel || '').trim();
  const fallbackPair = normalizePair(opts.fallbackPair || DEFAULT_PAIR);
  const expectedProgramId = String(opts.expectedProgramId || '').trim();
  const taoHtlcAddress = String(opts.taoHtlcAddress || '').trim();
  const {
    settlementLegMaxPlatformFeeBps: maxPlatformFeeBps,
    settlementLegMaxTradeFeeBps: maxTradeFeeBps,
    settlementLegMaxTotalFeeBps: maxTotalFeeBps,
  } = normalizeSettlementFeeCapsBps(
    {
      max_platform_fee_bps: Number(opts.maxPlatformFeeBps ?? 500),
      max_trade_fee_bps: Number(opts.maxTradeFeeBps ?? 1000),
      max_total_fee_bps: Number(opts.maxTotalFeeBps ?? 1500),
    },
    {
      defaultPlatformFeeBps: 500,
      defaultTradeFeeBps: 1000,
      defaultTotalFeeBps: 1500,
    }
  );
  const minRefundSec = Number(opts.minRefundSec ?? 72 * 3600);
  const minSettlementRefundSec = Number(opts.minSettlementRefundSec ?? minRefundSec);
  const maxRefundSec = Number(opts.maxRefundSec ?? OFFER_REFUND_MAX_SEC);
  const nowUnix = Number.isFinite(Number(opts.nowUnix)) ? Number(opts.nowUnix) : Math.floor(Date.now() / 1000);

  if (!evt || evt.type !== 'sidechannel_message') return null;
  if (offerChannels.length > 0 && !includesChannel(offerChannels, evt.channel)) return null;
  const msg = evt.message;
  if (!msg || typeof msg !== 'object' || msg.kind !== KIND.SVC_ANNOUNCE) return null;
  const envelope = validateSwapEnvelope(msg);
  if (!envelope.ok) return null;
  const body = msg.body;
  if (!body || typeof body !== 'object') return null;

  const validUntilUnix = Number(body.valid_until_unix);
  if (Number.isFinite(validUntilUnix) && validUntilUnix <= nowUnix) return null;
  if (!includesChannel(body.rfq_channels, rfqChannel)) return null;

  const offers = Array.isArray(body.offers) ? body.offers : [];
  for (const rawOffer of offers) {
    if (!rawOffer || typeof rawOffer !== 'object') continue;
    const pair = normalizePair(rawOffer.pair || fallbackPair);
    const offer = { ...rawOffer, __signer: msg.signer };
    if (String(offer.have || '') !== getHaveAssetForPair(pair)) continue;
    if (String(offer.want || '') !== ASSET.BTC_LN) continue;
    const fieldCheck = validateOfferFieldsForPair(offer, pair);
    if (!fieldCheck.ok) continue;

    const settlementKind = getPairSettlementKind(pair);
    if (hasValue(offer.settlement_kind) && String(offer.settlement_kind).trim().toLowerCase() !== settlementKind) {
      continue;
    }

    const expectedAppHash = getExpectedOfferAppHash(pair, { expectedProgramId, taoHtlcAddress }).toLowerCase();
    const appHash = String(offer.app_hash || body.app_hash || '').trim().toLowerCase();
    if (!appHash || appHash !== expectedAppHash) continue;

    const btc = Number(offer.btc_sats);
    if (!Number.isInteger(btc) || btc < 1) continue;

    const amount = String(getAmountForPair(offer, pair) || '').trim();
    if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) continue;

    const {
      settlementLegMaxPlatformFeeBps: maxPlat,
      settlementLegMaxTradeFeeBps: maxTrade,
      settlementLegMaxTotalFeeBps: maxTotal,
    } = normalizeSettlementFeeCapsBps(
      {
        max_platform_fee_bps: Number(offer.max_platform_fee_bps),
        max_trade_fee_bps: Number(offer.max_trade_fee_bps),
        max_total_fee_bps: Number(offer.max_total_fee_bps),
      },
      {
        defaultPlatformFeeBps: 0,
        defaultTradeFeeBps: 0,
        defaultTotalFeeBps: 0,
      }
    );
    if (!Number.isInteger(maxPlat) || maxPlat < 0 || maxPlat > 500 || maxPlat > maxPlatformFeeBps) continue;
    if (!Number.isInteger(maxTrade) || maxTrade < 0 || maxTrade > 1000 || maxTrade > maxTradeFeeBps) continue;
    if (!Number.isInteger(maxTotal) || maxTotal < 0 || maxTotal > 1500 || maxTotal > maxTotalFeeBps) continue;

    if (isTaoPair(pair)) {
      const refundAfterSec = Number(offer.settlement_refund_after_sec);
      if (!Number.isInteger(refundAfterSec)) continue;
      if (refundAfterSec < OFFER_REFUND_MIN_SEC || refundAfterSec > OFFER_REFUND_MAX_SEC) continue;
      if (refundAfterSec < minSettlementRefundSec || refundAfterSec > maxRefundSec) continue;
      return normalizeMatchedOffer(offer, {
        channel: String(evt.channel || ''),
        body,
        pair,
        validUntilUnix: Number.isFinite(validUntilUnix) ? validUntilUnix : null,
        refundMinSec: refundAfterSec,
        refundMaxSec: refundAfterSec,
      });
    }

    const offerMinSec = Number(offer.min_sol_refund_window_sec);
    const offerMaxSec = Number(offer.max_sol_refund_window_sec);
    if (!Number.isInteger(offerMinSec) || !Number.isInteger(offerMaxSec)) continue;
    if (offerMinSec < OFFER_REFUND_MIN_SEC || offerMinSec > OFFER_REFUND_MAX_SEC) continue;
    if (offerMaxSec < OFFER_REFUND_MIN_SEC || offerMaxSec > OFFER_REFUND_MAX_SEC) continue;
    if (offerMinSec > offerMaxSec) continue;
    if (offerMinSec < minRefundSec || offerMaxSec > maxRefundSec) continue;
    return normalizeMatchedOffer(offer, {
      channel: String(evt.channel || ''),
      body,
      pair,
      validUntilUnix: Number.isFinite(validUntilUnix) ? validUntilUnix : null,
      refundMinSec: offerMinSec,
      refundMaxSec: offerMaxSec,
    });
  }

  return null;
}
