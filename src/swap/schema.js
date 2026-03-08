import { KIND, STATE, SWAP_PROTOCOL_VERSION } from './constants.js';
import {
  getAmountFieldForPair,
  getAmountForPair,
  getDirectionForPair,
  getPairConfig,
  getQuoteRefundFieldForPair,
  getRfqRefundRangeFieldsForPair,
  isSupportedPair,
  isTaoPair,
  normalizePair,
} from './pairs.js';

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const isHex = (value, bytes) => {
  if (typeof value !== 'string') return false;
  const hex = value.trim().toLowerCase();
  const re = bytes ? new RegExp(`^[0-9a-f]{${bytes * 2}}$`) : /^[0-9a-f]+$/;
  return re.test(hex);
};

const isBase58 = (value) => {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  // Conservative: just ensure it's plausible base58 without 0/O/I/l.
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
};

const isHexAddress = (value) => {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s);
};

const isSettlementAddress = (value) => isBase58(value) || isHexAddress(value);

const isUint = (value) =>
  Number.isInteger(value) && Number.isFinite(value) && value >= 0;

const isPosInt = (value) =>
  Number.isInteger(value) && Number.isFinite(value) && value > 0;

const isAmountString = (value) => {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  // integer amount in smallest units, encoded as decimal string
  return /^[0-9]+$/.test(s) && s.length > 0;
};

function validatePairAndDirection(body, label) {
  const pair = normalizePair(body?.pair);
  if (!isSupportedPair(pair)) return { ok: false, error: `${label}.pair unsupported`, pair: null };
  if (body.pair !== pair) return { ok: false, error: `${label}.pair unsupported`, pair: null };
  if (body.direction !== getDirectionForPair(pair)) {
    return { ok: false, error: `${label}.direction unsupported`, pair: null };
  }
  return { ok: true, error: null, pair };
}

function validatePairAmount(body, label, pair) {
  const amountField = getAmountFieldForPair(pair);
  if (isTaoPair(pair) && body.usdt_amount !== undefined && body.usdt_amount !== null) {
    return { ok: false, error: `${label}.usdt_amount not allowed for ${pair}` };
  }
  if (!isTaoPair(pair) && body.tao_amount_atomic !== undefined && body.tao_amount_atomic !== null) {
    return { ok: false, error: `${label}.tao_amount_atomic not allowed for ${pair}` };
  }
  const amount = getAmountForPair(body, pair);
  if (!isAmountString(amount)) return { ok: false, error: `${label}.${amountField} must be a decimal string` };
  return { ok: true, error: null };
}

function validateRefundConstraints(body, label, pair, opts = {}) {
  const minSettlementRefundSec = Number.isFinite(opts?.minSettlementRefundSec)
    ? Number(opts.minSettlementRefundSec)
    : 3600;
  const maxSettlementRefundSec = Number.isFinite(opts?.maxSettlementRefundSec)
    ? Number(opts.maxSettlementRefundSec)
    : 7 * 24 * 3600;
  if (isTaoPair(pair)) {
    const refundField = getQuoteRefundFieldForPair(pair);
    if (body.min_sol_refund_window_sec !== undefined || body.max_sol_refund_window_sec !== undefined) {
      return { ok: false, error: `${label}.min_sol_refund_window_sec/max_sol_refund_window_sec not allowed for ${pair}` };
    }
    if (body.sol_refund_window_sec !== undefined && label === 'quote') {
      return { ok: false, error: `${label}.sol_refund_window_sec not allowed for ${pair}` };
    }
    if (body[refundField] !== undefined && body[refundField] !== null) {
      if (!isUint(body[refundField])) {
        return { ok: false, error: `${label}.${refundField} must be an integer >= 0` };
      }
      if (Number(body[refundField]) < minSettlementRefundSec) {
        return { ok: false, error: `${label}.${refundField} must be >= ${minSettlementRefundSec}` };
      }
      if (Number(body[refundField]) > maxSettlementRefundSec) {
        return { ok: false, error: `${label}.${refundField} must be <= ${maxSettlementRefundSec}` };
      }
    }
    return { ok: true, error: null };
  }

  const { minField, maxField } = getRfqRefundRangeFieldsForPair(pair);
  if (body.settlement_refund_after_sec !== undefined && body.settlement_refund_after_sec !== null) {
    return { ok: false, error: `${label}.settlement_refund_after_sec not allowed for ${pair}` };
  }
  if (label === 'rfq') {
    if (body[minField] !== undefined && body[minField] !== null) {
      if (!isUint(body[minField])) {
        return { ok: false, error: `${label}.${minField} must be an integer >= 0` };
      }
      if (Number(body[minField]) < 3600) {
        return { ok: false, error: `${label}.${minField} must be >= 3600` };
      }
      if (Number(body[minField]) > 7 * 24 * 3600) {
        return { ok: false, error: `${label}.${minField} must be <= 604800` };
      }
    }
    if (body[maxField] !== undefined && body[maxField] !== null) {
      if (!isUint(body[maxField])) {
        return { ok: false, error: `${label}.${maxField} must be an integer >= 0` };
      }
      if (Number(body[maxField]) < 3600) {
        return { ok: false, error: `${label}.${maxField} must be >= 3600` };
      }
      if (Number(body[maxField]) > 7 * 24 * 3600) {
        return { ok: false, error: `${label}.${maxField} must be <= 604800` };
      }
    }
    if (
      body[minField] !== undefined &&
      body[minField] !== null &&
      body[maxField] !== undefined &&
      body[maxField] !== null &&
      Number(body[minField]) > Number(body[maxField])
    ) {
      return { ok: false, error: `${label}.${minField} must be <= ${label}.${maxField}` };
    }
    return { ok: true, error: null };
  }

  if (label === 'quote') {
    const quoteRefundField = getQuoteRefundFieldForPair(pair);
    if (body[quoteRefundField] !== undefined && body[quoteRefundField] !== null) {
      if (!isUint(body[quoteRefundField])) {
        return { ok: false, error: `${label}.${quoteRefundField} must be an integer >= 0` };
      }
      if (Number(body[quoteRefundField]) < minSettlementRefundSec) {
        return { ok: false, error: `${label}.${quoteRefundField} must be >= ${minSettlementRefundSec}` };
      }
      if (Number(body[quoteRefundField]) > maxSettlementRefundSec) {
        return { ok: false, error: `${label}.${quoteRefundField} must be <= ${maxSettlementRefundSec}` };
      }
    }
  }
  return { ok: true, error: null };
}

export function validateSwapEnvelopeShape(envelope) {
  if (!isObject(envelope)) return { ok: false, error: 'Envelope must be an object' };
  if (!isUint(envelope.v)) return { ok: false, error: 'Envelope.v must be an integer >= 0' };
  if (envelope.v !== SWAP_PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported swap envelope version v=${envelope.v}` };
  }
  if (typeof envelope.kind !== 'string' || envelope.kind.length === 0) {
    return { ok: false, error: 'Envelope.kind is required' };
  }
  if (typeof envelope.trade_id !== 'string' || envelope.trade_id.length === 0) {
    return { ok: false, error: 'Envelope.trade_id is required' };
  }
  if (!isUint(envelope.ts)) return { ok: false, error: 'Envelope.ts must be an integer unix ms timestamp' };
  if (typeof envelope.nonce !== 'string' || envelope.nonce.length === 0) {
    return { ok: false, error: 'Envelope.nonce is required' };
  }
  if (!('body' in envelope)) return { ok: false, error: 'Envelope.body is required' };
  return { ok: true, error: null };
}

export function validateSwapBody(kind, body, opts = {}) {
  if (!isObject(body)) return { ok: false, error: 'Body must be an object' };

  switch (kind) {
    case KIND.SVC_ANNOUNCE: {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return { ok: false, error: 'svc_announce.name is required' };
      }
      if (body.pairs !== undefined) {
        if (!Array.isArray(body.pairs) || body.pairs.some((p) => typeof p !== 'string')) {
          return { ok: false, error: 'svc_announce.pairs must be an array of strings' };
        }
      }
      if (body.rfq_channels !== undefined) {
        if (!Array.isArray(body.rfq_channels) || body.rfq_channels.some((c) => typeof c !== 'string')) {
          return { ok: false, error: 'svc_announce.rfq_channels must be an array of strings' };
        }
      }
      if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string') return { ok: false, error: 'svc_announce.note must be a string' };
      }
      if (body.offers !== undefined && body.offers !== null) {
        if (!Array.isArray(body.offers)) return { ok: false, error: 'svc_announce.offers must be an array' };
        // Keep validation minimal; offers are informational and may evolve.
        for (const offer of body.offers) {
          if (!isObject(offer)) return { ok: false, error: 'svc_announce.offers entries must be objects' };
          if (offer.have !== undefined && offer.have !== null && typeof offer.have !== 'string') {
            return { ok: false, error: 'svc_announce.offers.have must be a string' };
          }
          if (offer.want !== undefined && offer.want !== null && typeof offer.want !== 'string') {
            return { ok: false, error: 'svc_announce.offers.want must be a string' };
          }
          if (offer.pair !== undefined && offer.pair !== null && typeof offer.pair !== 'string') {
            return { ok: false, error: 'svc_announce.offers.pair must be a string' };
          }
        }
      }
      if (body.valid_until_unix !== undefined && body.valid_until_unix !== null) {
        if (!isPosInt(body.valid_until_unix)) {
          return { ok: false, error: 'svc_announce.valid_until_unix must be a unix seconds integer' };
        }
      }
      return { ok: true, error: null };
    }

    case KIND.RFQ: {
      const pd = validatePairAndDirection(body, 'rfq');
      if (!pd.ok) return pd;
      const pair = pd.pair;
      if (!isHex(body.app_hash, 32)) return { ok: false, error: 'rfq.app_hash must be 32-byte hex' };
      if (!isPosInt(body.btc_sats)) return { ok: false, error: 'rfq.btc_sats must be a positive integer' };
      const amountCheck = validatePairAmount(body, 'rfq', pair);
      if (!amountCheck.ok) return amountCheck;
      // Optional fee ceilings (pre-filtering only; binding fees are in TERMS).
      if (body.max_platform_fee_bps !== undefined && body.max_platform_fee_bps !== null) {
        if (!isUint(body.max_platform_fee_bps)) {
          return { ok: false, error: 'rfq.max_platform_fee_bps must be an integer >= 0' };
        }
        if (Number(body.max_platform_fee_bps) > 500) {
          return { ok: false, error: 'rfq.max_platform_fee_bps exceeds 500 bps cap' };
        }
      }
      if (body.max_trade_fee_bps !== undefined && body.max_trade_fee_bps !== null) {
        if (!isUint(body.max_trade_fee_bps)) {
          return { ok: false, error: 'rfq.max_trade_fee_bps must be an integer >= 0' };
        }
        if (Number(body.max_trade_fee_bps) > 1000) {
          return { ok: false, error: 'rfq.max_trade_fee_bps exceeds 1000 bps cap' };
        }
      }
      if (body.max_total_fee_bps !== undefined && body.max_total_fee_bps !== null) {
        if (!isUint(body.max_total_fee_bps)) {
          return { ok: false, error: 'rfq.max_total_fee_bps must be an integer >= 0' };
        }
        if (Number(body.max_total_fee_bps) > 1500) {
          return { ok: false, error: 'rfq.max_total_fee_bps exceeds 1500 bps cap' };
        }
      }
      const refundCheck = validateRefundConstraints(body, 'rfq', pair, opts);
      if (!refundCheck.ok) return refundCheck;
      if (body.sol_mint !== undefined && body.sol_mint !== null) {
        if (!isSettlementAddress(body.sol_mint)) return { ok: false, error: 'rfq.sol_mint must be base58 or 0x address' };
      }
      if (body.sol_recipient !== undefined && body.sol_recipient !== null) {
        if (!isSettlementAddress(body.sol_recipient)) return { ok: false, error: 'rfq.sol_recipient must be base58 or 0x address' };
      }
      if (body.valid_until_unix !== undefined && !isPosInt(body.valid_until_unix)) {
        return { ok: false, error: 'rfq.valid_until_unix must be a unix seconds integer' };
      }
      return { ok: true, error: null };
    }

    case KIND.QUOTE: {
      if (!isHex(body.rfq_id, 32)) return { ok: false, error: 'quote.rfq_id must be 32-byte hex' };
      const pd = validatePairAndDirection(body, 'quote');
      if (!pd.ok) return pd;
      const pair = pd.pair;
      if (!isHex(body.app_hash, 32)) return { ok: false, error: 'quote.app_hash must be 32-byte hex' };
      const amountCheck = validatePairAmount(body, 'quote', pair);
      if (!amountCheck.ok) return amountCheck;
      if (!isPosInt(body.btc_sats)) return { ok: false, error: 'quote.btc_sats must be a positive integer' };
      const hasOfferId = body.offer_id !== undefined && body.offer_id !== null;
      const hasOfferLineIndex = body.offer_line_index !== undefined && body.offer_line_index !== null;
      if (hasOfferId && !isHex(body.offer_id, 32)) {
        return { ok: false, error: 'quote.offer_id must be 32-byte hex' };
      }
      if (hasOfferLineIndex && !isUint(body.offer_line_index)) {
        return { ok: false, error: 'quote.offer_line_index must be an integer >= 0' };
      }
      if (hasOfferId !== hasOfferLineIndex) {
        return { ok: false, error: 'quote.offer_id and quote.offer_line_index must be provided together' };
      }
      // Optional fee preview (pre-filtering only; binding fees are in TERMS).
      if (body.platform_fee_bps !== undefined && body.platform_fee_bps !== null) {
        if (!isUint(body.platform_fee_bps)) {
          return { ok: false, error: 'quote.platform_fee_bps must be an integer >= 0' };
        }
        if (Number(body.platform_fee_bps) > 500) {
          return { ok: false, error: 'quote.platform_fee_bps exceeds 500 bps cap' };
        }
      }
      if (body.trade_fee_bps !== undefined && body.trade_fee_bps !== null) {
        if (!isUint(body.trade_fee_bps)) {
          return { ok: false, error: 'quote.trade_fee_bps must be an integer >= 0' };
        }
        if (Number(body.trade_fee_bps) > 1000) {
          return { ok: false, error: 'quote.trade_fee_bps exceeds 1000 bps cap' };
        }
      }
      if (
        body.platform_fee_bps !== undefined &&
        body.platform_fee_bps !== null &&
        body.trade_fee_bps !== undefined &&
        body.trade_fee_bps !== null &&
        Number(body.platform_fee_bps) + Number(body.trade_fee_bps) > 1500
      ) {
        return { ok: false, error: 'quote total fee bps exceeds 1500 bps cap' };
      }
      if (body.platform_fee_collector !== undefined && body.platform_fee_collector !== null) {
        if (!isSettlementAddress(body.platform_fee_collector)) {
          return { ok: false, error: 'quote.platform_fee_collector must be base58 or 0x address' };
        }
      }
      if (body.trade_fee_collector !== undefined && body.trade_fee_collector !== null) {
        if (!isSettlementAddress(body.trade_fee_collector)) {
          return { ok: false, error: 'quote.trade_fee_collector must be base58 or 0x address' };
        }
      }
      const refundCheck = validateRefundConstraints(body, 'quote', pair, opts);
      if (!refundCheck.ok) return refundCheck;
      if (body.sol_mint !== undefined && body.sol_mint !== null) {
        if (!isSettlementAddress(body.sol_mint)) return { ok: false, error: 'quote.sol_mint must be base58 or 0x address' };
      }
      if (body.sol_recipient !== undefined && body.sol_recipient !== null) {
        if (!isSettlementAddress(body.sol_recipient)) return { ok: false, error: 'quote.sol_recipient must be base58 or 0x address' };
      }
      if (!isPosInt(body.valid_until_unix)) {
        return { ok: false, error: 'quote.valid_until_unix must be a unix seconds integer' };
      }
      return { ok: true, error: null };
    }

    case KIND.QUOTE_ACCEPT: {
      if (!isHex(body.rfq_id, 32)) return { ok: false, error: 'quote_accept.rfq_id must be 32-byte hex' };
      if (!isHex(body.quote_id, 32)) return { ok: false, error: 'quote_accept.quote_id must be 32-byte hex' };
      if (body.note !== undefined && typeof body.note !== 'string') {
        return { ok: false, error: 'quote_accept.note must be a string' };
      }
      return { ok: true, error: null };
    }

    case KIND.SWAP_INVITE: {
      if (!isHex(body.rfq_id, 32)) return { ok: false, error: 'swap_invite.rfq_id must be 32-byte hex' };
      if (!isHex(body.quote_id, 32)) return { ok: false, error: 'swap_invite.quote_id must be 32-byte hex' };
      if (typeof body.swap_channel !== 'string' || body.swap_channel.trim().length === 0) {
        return { ok: false, error: 'swap_invite.swap_channel is required' };
      }
      if (body.owner_pubkey !== undefined && body.owner_pubkey !== null) {
        if (!isHex(body.owner_pubkey, 32)) return { ok: false, error: 'swap_invite.owner_pubkey must be 32-byte hex' };
      }

      // Sidechannel invite payload can be included inline (preferred) or as base64 JSON.
      const hasInviteObject = isObject(body.invite);
      const hasInviteB64 = typeof body.invite_b64 === 'string' && body.invite_b64.trim().length > 0;
      if (!hasInviteObject && !hasInviteB64) {
        return { ok: false, error: 'swap_invite.invite (object) or invite_b64 (string) is required' };
      }
      if (hasInviteObject) {
        if (!isObject(body.invite.payload) || typeof body.invite.sig !== 'string' || body.invite.sig.trim().length === 0) {
          return { ok: false, error: 'swap_invite.invite must include { payload, sig }' };
        }
        if (String(body.invite.payload.channel || '') !== String(body.swap_channel)) {
          return { ok: false, error: 'swap_invite.invite.payload.channel must match swap_channel' };
        }
      }
      if (body.welcome !== undefined && body.welcome !== null) {
        if (!isObject(body.welcome)) return { ok: false, error: 'swap_invite.welcome must be an object' };
      }
      if (body.welcome_b64 !== undefined && body.welcome_b64 !== null) {
        if (typeof body.welcome_b64 !== 'string' || body.welcome_b64.trim().length === 0) {
          return { ok: false, error: 'swap_invite.welcome_b64 must be a string' };
        }
      }
      return { ok: true, error: null };
    }

    case KIND.TERMS: {
      const pd = validatePairAndDirection(body, 'terms');
      if (!pd.ok) return pd;
      const pair = pd.pair;
      if (!isHex(body.app_hash, 32)) return { ok: false, error: 'terms.app_hash must be 32-byte hex' };
      if (!isPosInt(body.btc_sats)) return { ok: false, error: 'terms.btc_sats must be a positive integer' };
      const amountCheck = validatePairAmount(body, 'terms', pair);
      if (!amountCheck.ok) return amountCheck;
      if (!isTaoPair(pair) && body.usdt_decimals !== undefined && !isUint(body.usdt_decimals)) {
        return { ok: false, error: 'terms.usdt_decimals must be an integer >= 0' };
      }
      if (!isSettlementAddress(body.sol_mint)) return { ok: false, error: 'terms.sol_mint must be base58 or 0x address' };
      if (!isSettlementAddress(body.sol_recipient)) return { ok: false, error: 'terms.sol_recipient must be base58 or 0x address' };
      if (!isSettlementAddress(body.sol_refund)) return { ok: false, error: 'terms.sol_refund must be base58 or 0x address' };
      if (!isPosInt(body.sol_refund_after_unix)) {
        return { ok: false, error: 'terms.sol_refund_after_unix must be a unix seconds integer' };
      }
      if (!isHex(body.ln_receiver_peer, 32)) {
        return { ok: false, error: 'terms.ln_receiver_peer must be 32-byte hex' };
      }
      if (!isHex(body.ln_payer_peer, 32)) {
        return { ok: false, error: 'terms.ln_payer_peer must be 32-byte hex' };
      }

      // Fee policy is part of the binding terms. Values are bps integers.
      if (!isUint(body.platform_fee_bps)) {
        return { ok: false, error: 'terms.platform_fee_bps must be an integer >= 0' };
      }
      if (!isUint(body.trade_fee_bps)) {
        return { ok: false, error: 'terms.trade_fee_bps must be an integer >= 0' };
      }
      if (Number(body.platform_fee_bps) > 500) {
        return { ok: false, error: 'terms.platform_fee_bps exceeds 500 bps cap' };
      }
      if (Number(body.trade_fee_bps) > 1000) {
        return { ok: false, error: 'terms.trade_fee_bps exceeds 1000 bps cap' };
      }
      if (Number(body.platform_fee_bps) + Number(body.trade_fee_bps) > 1500) {
        return { ok: false, error: 'terms total fee bps exceeds 1500 bps cap' };
      }
      if (body.platform_fee_collector !== undefined && body.platform_fee_collector !== null) {
        if (!isSettlementAddress(body.platform_fee_collector)) {
          return { ok: false, error: 'terms.platform_fee_collector must be base58 or 0x address' };
        }
      }
      if (!isSettlementAddress(body.trade_fee_collector)) {
        return { ok: false, error: 'terms.trade_fee_collector must be base58 or 0x address' };
      }

      if (body.terms_valid_until_unix !== undefined && !isPosInt(body.terms_valid_until_unix)) {
        return { ok: false, error: 'terms.terms_valid_until_unix must be unix seconds integer' };
      }
      return { ok: true, error: null };
    }

    case KIND.ACCEPT: {
      if (typeof body.terms_hash !== 'string' || !isHex(body.terms_hash)) {
        return { ok: false, error: 'accept.terms_hash must be hex' };
      }
      return { ok: true, error: null };
    }

    case KIND.LN_INVOICE: {
      if (typeof body.bolt11 !== 'string' || body.bolt11.trim().length === 0) {
        return { ok: false, error: 'ln_invoice.bolt11 is required' };
      }
      if (!isHex(body.payment_hash_hex, 32)) {
        return { ok: false, error: 'ln_invoice.payment_hash_hex must be 32-byte hex' };
      }
      if (body.amount_msat !== undefined && !isAmountString(body.amount_msat)) {
        return { ok: false, error: 'ln_invoice.amount_msat must be a decimal string' };
      }
      if (body.expires_at_unix !== undefined && !isPosInt(body.expires_at_unix)) {
        return { ok: false, error: 'ln_invoice.expires_at_unix must be unix seconds integer' };
      }
      return { ok: true, error: null };
    }

    case KIND.SOL_ESCROW_CREATED: {
      if (!isHex(body.payment_hash_hex, 32)) return { ok: false, error: 'sol_escrow_created.payment_hash_hex invalid' };
      if (!isBase58(body.program_id)) return { ok: false, error: 'sol_escrow_created.program_id invalid' };
      if (!isBase58(body.escrow_pda)) return { ok: false, error: 'sol_escrow_created.escrow_pda invalid' };
      if (!isBase58(body.vault_ata)) return { ok: false, error: 'sol_escrow_created.vault_ata invalid' };
      if (!isBase58(body.mint)) return { ok: false, error: 'sol_escrow_created.mint invalid' };
      if (!isAmountString(body.amount)) return { ok: false, error: 'sol_escrow_created.amount must be a decimal string' };
      if (!isPosInt(body.refund_after_unix)) return { ok: false, error: 'sol_escrow_created.refund_after_unix invalid' };
      if (!isBase58(body.recipient)) return { ok: false, error: 'sol_escrow_created.recipient invalid' };
      if (!isBase58(body.refund)) return { ok: false, error: 'sol_escrow_created.refund invalid' };
      if (typeof body.tx_sig !== 'string' || body.tx_sig.trim().length === 0) {
        return { ok: false, error: 'sol_escrow_created.tx_sig is required' };
      }
      return { ok: true, error: null };
    }

    case KIND.TAO_HTLC_LOCKED: {
      if (!isHex(body.payment_hash_hex, 32)) return { ok: false, error: 'tao_htlc_locked.payment_hash_hex invalid' };
      if (typeof body.settlement_id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.settlement_id.trim())) {
        return { ok: false, error: 'tao_htlc_locked.settlement_id invalid' };
      }
      if (!isHexAddress(body.htlc_address)) return { ok: false, error: 'tao_htlc_locked.htlc_address invalid' };
      if (!isAmountString(body.amount_atomic)) return { ok: false, error: 'tao_htlc_locked.amount_atomic must be a decimal string' };
      const refundAfter = body.refund_after_unix;
      if (!(isPosInt(refundAfter) || isAmountString(refundAfter))) {
        return { ok: false, error: 'tao_htlc_locked.refund_after_unix invalid' };
      }
      if (!isHexAddress(body.recipient)) return { ok: false, error: 'tao_htlc_locked.recipient invalid' };
      if (!isHexAddress(body.refund)) return { ok: false, error: 'tao_htlc_locked.refund invalid' };
      if (typeof body.tx_id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.tx_id.trim())) {
        return { ok: false, error: 'tao_htlc_locked.tx_id invalid' };
      }
      if (body.fee_snapshot !== undefined && body.fee_snapshot !== null && !isObject(body.fee_snapshot)) {
        return { ok: false, error: 'tao_htlc_locked.fee_snapshot must be an object' };
      }
      return { ok: true, error: null };
    }

    case KIND.LN_PAID: {
      if (!isHex(body.payment_hash_hex, 32)) return { ok: false, error: 'ln_paid.payment_hash_hex invalid' };
      if (body.preimage_hex !== undefined && !isHex(body.preimage_hex, 32)) {
        return { ok: false, error: 'ln_paid.preimage_hex must be 32-byte hex' };
      }
      return { ok: true, error: null };
    }

    case KIND.SOL_CLAIMED:
    case KIND.SOL_REFUNDED: {
      const label = kind === KIND.SOL_CLAIMED ? 'sol_claimed' : 'sol_refunded';
      if (!isHex(body.payment_hash_hex, 32)) return { ok: false, error: `${label}.payment_hash_hex invalid` };
      if (!isBase58(body.escrow_pda)) return { ok: false, error: `${label}.escrow_pda invalid` };
      if (typeof body.tx_sig !== 'string' || body.tx_sig.trim().length === 0) {
        return { ok: false, error: `${label}.tx_sig is required` };
      }
      return { ok: true, error: null };
    }

    case KIND.TAO_CLAIMED:
    case KIND.TAO_REFUNDED: {
      const label = kind === KIND.TAO_CLAIMED ? 'tao_claimed' : 'tao_refunded';
      if (!isHex(body.payment_hash_hex, 32)) return { ok: false, error: `${label}.payment_hash_hex invalid` };
      if (typeof body.settlement_id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.settlement_id.trim())) {
        return { ok: false, error: `${label}.settlement_id invalid` };
      }
      if (typeof body.tx_id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.tx_id.trim())) {
        return { ok: false, error: `${label}.tx_id invalid` };
      }
      return { ok: true, error: null };
    }

    case KIND.CANCEL: {
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        return { ok: false, error: 'cancel.reason must be a string' };
      }
      return { ok: true, error: null };
    }

    case KIND.STATUS: {
      if (typeof body.state !== 'string' || !Object.values(STATE).includes(body.state)) {
        return { ok: false, error: 'status.state must be a valid state' };
      }
      if (body.note !== undefined && typeof body.note !== 'string') {
        return { ok: false, error: 'status.note must be a string' };
      }
      return { ok: true, error: null };
    }

    default:
      return { ok: false, error: `Unknown swap kind: ${kind}` };
  }
}

export function validateSwapEnvelope(envelope, opts = {}) {
  const base = validateSwapEnvelopeShape(envelope);
  if (!base.ok) return base;
  return validateSwapBody(envelope.kind, envelope.body, opts);
}
