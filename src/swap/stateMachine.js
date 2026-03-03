import { KIND, STATE } from './constants.js';
import { getAmountForPair, normalizePair } from './pairs.js';
import {
  getTermsSettlementAssetId,
  getTermsSettlementRecipient,
  getTermsSettlementRefundAddress,
  getTermsSettlementRefundAfterUnix,
} from './settlementTerms.js';
import { hashUnsignedEnvelope } from './hash.js';
import { validateSwapEnvelope } from './schema.js';
import { verifySignedEnvelope } from '../protocol/signedMessage.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

const normalizeHex = (value) => String(value || '').trim().toLowerCase();

const unixSecToMs = (unixSec) => {
  const n = Number(unixSec);
  if (!Number.isFinite(n)) return NaN;
  return Math.trunc(n * 1000);
};

function stripSignature(envelope) {
  const { sig: _sig, signer: _signer, ...unsigned } = envelope;
  return unsigned;
}

export function createInitialTrade(tradeId) {
  if (!tradeId || typeof tradeId !== 'string') throw new Error('tradeId is required');
  return {
    trade_id: tradeId,
    state: STATE.INIT,
    terms: null,
    terms_hash: null,
    invoice: null,
    escrow: null,
    ln_paid: null,
    claimed: null,
    refunded: null,
    last: null,
    accepted_at: null,
    canceled_reason: null,
  };
}

function requireSigner(envelope, expectedSignerHex, label) {
  const signer = String(envelope?.signer || '').trim().toLowerCase();
  const exp = String(expectedSignerHex || '').trim().toLowerCase();
  if (!signer || !exp || signer !== exp) {
    return { ok: false, error: `${label}: wrong signer` };
  }
  return { ok: true, error: null };
}

export function applySwapEnvelope(trade, envelope) {
  if (!trade || typeof trade !== 'object') return { ok: false, error: 'Trade state missing', trade: null };

  // Validate schema first (fast fail) before signature checks.
  const v = validateSwapEnvelope(envelope);
  if (!v.ok) return { ok: false, error: v.error, trade: null };

  if (envelope.trade_id !== trade.trade_id) {
    return { ok: false, error: 'trade_id mismatch', trade: null };
  }

  const sig = verifySignedEnvelope(envelope);
  if (!sig.ok) return { ok: false, error: `bad signature: ${sig.error}`, trade: null };

  const next = clone(trade);
  next.last = { kind: envelope.kind, ts: envelope.ts, signer: envelope.signer };

  switch (envelope.kind) {
    case KIND.TERMS: {
      // Terms must be authored by the LN receiver (the USDT depositor side in this swap orientation).
      const rs = requireSigner(envelope, envelope.body.ln_receiver_peer, 'terms');
      if (!rs.ok) return { ok: false, error: rs.error, trade: null };

      const incomingTermsHash = hashUnsignedEnvelope(stripSignature(envelope));

      // Allow terms updates only before ACCEPT, and only from the same receiver peer.
      if (next.terms) {
        const lock = requireSigner(envelope, next.terms.ln_receiver_peer, 'terms');
        if (!lock.ok) return { ok: false, error: lock.error, trade: null };
      }

      if (![STATE.INIT, STATE.TERMS].includes(next.state)) {
        // After ACCEPT, we only allow an idempotent replay of the exact same terms.
        if (normalizeHex(next.terms_hash) !== normalizeHex(incomingTermsHash)) {
          return { ok: false, error: `TERMS not allowed in state=${next.state}`, trade: null };
        }
        return { ok: true, error: null, trade: next };
      }

      next.terms = envelope.body;
      next.terms_hash = incomingTermsHash;
      next.state = STATE.TERMS;
      next.accepted_at = null;
      // Reset downstream evidence on terms replacement.
      next.invoice = null;
      next.escrow = null;
      next.ln_paid = null;
      next.claimed = null;
      next.refunded = null;
      return { ok: true, error: null, trade: next };
    }

    case KIND.ACCEPT: {
      if (!next.terms || !next.terms_hash) {
        return { ok: false, error: 'ACCEPT requires active terms', trade: null };
      }

      // Idempotent replay: accept can arrive multiple times; if we already moved past TERMS,
      // treat it as informational as long as it still matches the accepted terms.
      if (next.state !== STATE.TERMS) {
        if (next.state === STATE.CANCELED) {
          return { ok: false, error: `ACCEPT not allowed in state=${next.state}`, trade: null };
        }
        const rs = requireSigner(envelope, next.terms.ln_payer_peer, 'accept');
        if (!rs.ok) return { ok: false, error: rs.error, trade: null };
        if (normalizeHex(envelope.body.terms_hash) !== normalizeHex(next.terms_hash)) {
          return { ok: false, error: 'ACCEPT terms_hash mismatch', trade: null };
        }
        return { ok: true, error: null, trade: next };
      }

      // Enforce terms validity window.
      if (next.terms.terms_valid_until_unix !== undefined && next.terms.terms_valid_until_unix !== null) {
        const expMs = unixSecToMs(next.terms.terms_valid_until_unix);
        if (!Number.isFinite(expMs)) {
          return { ok: false, error: 'ACCEPT invalid terms_valid_until_unix', trade: null };
        }
        if (envelope.ts > expMs) {
          return { ok: false, error: 'ACCEPT arrived after terms expiry', trade: null };
        }
      }

      const rs = requireSigner(envelope, next.terms.ln_payer_peer, 'accept');
      if (!rs.ok) return { ok: false, error: rs.error, trade: null };
      if (normalizeHex(envelope.body.terms_hash) !== normalizeHex(next.terms_hash)) {
        return { ok: false, error: 'ACCEPT terms_hash mismatch', trade: null };
      }
      next.state = STATE.ACCEPTED;
      next.accepted_at = envelope.ts;
      return { ok: true, error: null, trade: next };
    }

    case KIND.LN_INVOICE: {
      if (![STATE.ACCEPTED, STATE.INVOICE, STATE.ESCROW].includes(next.state)) {
        return { ok: false, error: `LN_INVOICE not allowed in state=${next.state}`, trade: null };
      }
      if (!next.terms) return { ok: false, error: 'LN_INVOICE requires terms', trade: null };
      const rs = requireSigner(envelope, next.terms.ln_receiver_peer, 'ln_invoice');
      if (!rs.ok) return { ok: false, error: rs.error, trade: null };

      if (envelope.body.amount_msat !== undefined && envelope.body.amount_msat !== null) {
        const want = BigInt(next.terms.btc_sats) * 1000n;
        const got = BigInt(String(envelope.body.amount_msat));
        if (got !== want) {
          return { ok: false, error: 'LN invoice amount_msat mismatch vs terms', trade: null };
        }
      }
      if (envelope.body.expires_at_unix !== undefined && envelope.body.expires_at_unix !== null) {
        const expMs = unixSecToMs(envelope.body.expires_at_unix);
        if (!Number.isFinite(expMs)) return { ok: false, error: 'LN invoice invalid expires_at_unix', trade: null };
        if (envelope.ts > expMs) {
          return { ok: false, error: 'LN invoice already expired', trade: null };
        }
      }

      if (next.invoice) {
        // Idempotent replay: invoice details must remain stable for a trade.
        if (normalizeHex(next.invoice.payment_hash_hex) !== normalizeHex(envelope.body.payment_hash_hex)) {
          return { ok: false, error: 'LN invoice payment_hash mismatch vs prior invoice', trade: null };
        }
        if (String(next.invoice.bolt11) !== String(envelope.body.bolt11)) {
          return { ok: false, error: 'LN invoice bolt11 mismatch vs prior invoice', trade: null };
        }
        if (next.invoice.amount_msat !== undefined && envelope.body.amount_msat !== undefined) {
          if (String(next.invoice.amount_msat) !== String(envelope.body.amount_msat)) {
            return { ok: false, error: 'LN invoice amount_msat mismatch vs prior invoice', trade: null };
          }
        }
        if (next.invoice.expires_at_unix !== undefined && envelope.body.expires_at_unix !== undefined) {
          if (Number(next.invoice.expires_at_unix) !== Number(envelope.body.expires_at_unix)) {
            return { ok: false, error: 'LN invoice expires_at_unix mismatch vs prior invoice', trade: null };
          }
        }
      } else {
        next.invoice = envelope.body;
      }

      // Only move forward if we weren't already past invoice.
      if (next.state === STATE.ACCEPTED) next.state = STATE.INVOICE;
      return { ok: true, error: null, trade: next };
    }

    case KIND.SOL_ESCROW_CREATED:
    case KIND.TAO_HTLC_LOCKED: {
      const isTao = envelope.kind === KIND.TAO_HTLC_LOCKED;
      const label = isTao ? 'TAO_HTLC_LOCKED' : 'SOL_ESCROW_CREATED';
      const termsPair = normalizePair(next.terms?.pair);
      const termsAmount = getAmountForPair(next.terms, termsPair, { allowLegacyTaoFallback: true });
      const termsRecipient = getTermsSettlementRecipient(next.terms);
      const termsRefund = getTermsSettlementRefundAddress(next.terms);
      const termsRefundAfterUnix = getTermsSettlementRefundAfterUnix(next.terms);
      const termsAssetId = getTermsSettlementAssetId(next.terms, termsPair);
      if (![STATE.INVOICE, STATE.ESCROW].includes(next.state)) {
        return { ok: false, error: `${label} not allowed in state=${next.state}`, trade: null };
      }
      if (!next.terms) return { ok: false, error: `${label} requires terms`, trade: null };
      if (!next.invoice) return { ok: false, error: `${label} requires invoice`, trade: null };
      const rs = requireSigner(envelope, next.terms.ln_receiver_peer, isTao ? 'tao_htlc_locked' : 'sol_escrow_created');
      if (!rs.ok) return { ok: false, error: rs.error, trade: null };
      if (normalizeHex(envelope.body.payment_hash_hex) !== normalizeHex(next.invoice.payment_hash_hex)) {
        return { ok: false, error: `${isTao ? 'TAO HTLC' : 'SOL escrow'} payment_hash mismatch vs invoice`, trade: null };
      }

      // Cross-checks with terms.
      if (String(envelope.body.recipient) !== String(termsRecipient)) {
        return { ok: false, error: `${isTao ? 'TAO HTLC' : 'SOL escrow'} recipient mismatch vs terms`, trade: null };
      }
      if (String(envelope.body.refund) !== String(termsRefund)) {
        return { ok: false, error: `${isTao ? 'TAO HTLC' : 'SOL escrow'} refund mismatch vs terms`, trade: null };
      }
      if (String(envelope.body.refund_after_unix) && Number(envelope.body.refund_after_unix) < Number(termsRefundAfterUnix)) {
        return { ok: false, error: `${isTao ? 'TAO HTLC' : 'SOL escrow'} refund_after_unix earlier than terms`, trade: null };
      }

      if (isTao) {
        if (String(envelope.body.amount_atomic) !== String(termsAmount)) {
          return { ok: false, error: 'TAO HTLC amount_atomic mismatch vs terms', trade: null };
        }
        if (next.escrow) {
          if (String(next.escrow.settlement_id) !== String(envelope.body.settlement_id)) {
            return { ok: false, error: 'TAO HTLC settlement_id mismatch vs prior lock', trade: null };
          }
          if (String(next.escrow.tx_id) !== String(envelope.body.tx_id)) {
            return { ok: false, error: 'TAO HTLC tx_id mismatch vs prior lock', trade: null };
          }
        } else {
          next.escrow = envelope.body;
        }
      } else {
        if (envelope.body.mint !== termsAssetId) {
          return { ok: false, error: 'SOL escrow mint mismatch vs terms', trade: null };
        }
        if (String(envelope.body.amount) !== String(termsAmount)) {
          return { ok: false, error: 'SOL escrow amount mismatch vs terms', trade: null };
        }
        if (next.escrow) {
          // Idempotent replay: escrow details must remain stable for a trade.
          if (String(next.escrow.escrow_pda) !== String(envelope.body.escrow_pda)) {
            return { ok: false, error: 'SOL escrow escrow_pda mismatch vs prior escrow', trade: null };
          }
          if (String(next.escrow.vault_ata) !== String(envelope.body.vault_ata)) {
            return { ok: false, error: 'SOL escrow vault_ata mismatch vs prior escrow', trade: null };
          }
          if (String(next.escrow.tx_sig) !== String(envelope.body.tx_sig)) {
            return { ok: false, error: 'SOL escrow tx_sig mismatch vs prior escrow', trade: null };
          }
        } else {
          next.escrow = envelope.body;
        }
      }

      next.state = STATE.ESCROW;
      return { ok: true, error: null, trade: next };
    }

    case KIND.LN_PAID: {
      if (![STATE.ESCROW, STATE.LN_PAID].includes(next.state)) {
        return { ok: false, error: `LN_PAID not allowed in state=${next.state}`, trade: null };
      }
      if (!next.terms) return { ok: false, error: 'LN_PAID requires terms', trade: null };
      if (!next.invoice) return { ok: false, error: 'LN_PAID requires invoice', trade: null };
      if (!next.escrow) return { ok: false, error: 'LN_PAID requires escrow', trade: null };
      const rs = requireSigner(envelope, next.terms.ln_payer_peer, 'ln_paid');
      if (!rs.ok) return { ok: false, error: rs.error, trade: null };
      if (normalizeHex(envelope.body.payment_hash_hex) !== normalizeHex(next.invoice.payment_hash_hex)) {
        return { ok: false, error: 'LN_PAID payment_hash mismatch vs invoice', trade: null };
      }
      if (normalizeHex(envelope.body.payment_hash_hex) !== normalizeHex(next.escrow.payment_hash_hex)) {
        return { ok: false, error: 'LN_PAID payment_hash mismatch vs escrow', trade: null };
      }
      if (next.invoice.expires_at_unix !== undefined && next.invoice.expires_at_unix !== null) {
        const expMs = unixSecToMs(next.invoice.expires_at_unix);
        if (!Number.isFinite(expMs)) return { ok: false, error: 'LN_PAID invalid invoice expires_at_unix', trade: null };
        if (envelope.ts > expMs) return { ok: false, error: 'LN_PAID after invoice expiry', trade: null };
      }
      if (next.ln_paid) {
        if (normalizeHex(next.ln_paid.payment_hash_hex) !== normalizeHex(envelope.body.payment_hash_hex)) {
          return { ok: false, error: 'LN_PAID payment_hash mismatch vs prior ln_paid', trade: null };
        }
      } else {
        next.ln_paid = envelope.body;
      }
      next.state = STATE.LN_PAID;
      return { ok: true, error: null, trade: next };
    }

    case KIND.SOL_CLAIMED:
    case KIND.TAO_CLAIMED: {
      const isTao = envelope.kind === KIND.TAO_CLAIMED;
      const label = isTao ? 'TAO_CLAIMED' : 'SOL_CLAIMED';
      if (![STATE.ESCROW, STATE.LN_PAID, STATE.CLAIMED].includes(next.state)) {
        return { ok: false, error: `${label} not allowed in state=${next.state}`, trade: null };
      }
      if (!next.terms) return { ok: false, error: `${label} requires terms`, trade: null };
      if (!next.escrow) return { ok: false, error: `${label} requires escrow`, trade: null };
      const rs = requireSigner(envelope, next.terms.ln_payer_peer, isTao ? 'tao_claimed' : 'sol_claimed');
      if (!rs.ok) return { ok: false, error: rs.error, trade: null };
      if (normalizeHex(envelope.body.payment_hash_hex) !== normalizeHex(next.escrow.payment_hash_hex)) {
        return { ok: false, error: `${label} payment_hash mismatch vs escrow`, trade: null };
      }
      if (isTao) {
        if (String(envelope.body.settlement_id) !== String(next.escrow.settlement_id)) {
          return { ok: false, error: 'TAO_CLAIMED settlement_id mismatch vs escrow', trade: null };
        }
        if (next.claimed) {
          if (String(next.claimed.tx_id) !== String(envelope.body.tx_id)) {
            return { ok: false, error: 'TAO_CLAIMED tx_id mismatch vs prior claim', trade: null };
          }
        } else {
          next.claimed = envelope.body;
        }
      } else {
        if (String(envelope.body.escrow_pda) !== String(next.escrow.escrow_pda)) {
          return { ok: false, error: 'SOL_CLAIMED escrow_pda mismatch vs escrow', trade: null };
        }
        if (next.claimed) {
          if (String(next.claimed.tx_sig) !== String(envelope.body.tx_sig)) {
            return { ok: false, error: 'SOL_CLAIMED tx_sig mismatch vs prior claim', trade: null };
          }
        } else {
          next.claimed = envelope.body;
        }
      }
      next.state = STATE.CLAIMED;
      return { ok: true, error: null, trade: next };
    }

    case KIND.SOL_REFUNDED:
    case KIND.TAO_REFUNDED: {
      const isTao = envelope.kind === KIND.TAO_REFUNDED;
      const label = isTao ? 'TAO_REFUNDED' : 'SOL_REFUNDED';
      if (![STATE.ESCROW, STATE.REFUNDED].includes(next.state)) {
        return { ok: false, error: `${label} not allowed in state=${next.state}`, trade: null };
      }
      if (!next.terms) return { ok: false, error: `${label} requires terms`, trade: null };
      if (!next.escrow) return { ok: false, error: `${label} requires escrow`, trade: null };
      const rs = requireSigner(envelope, next.terms.ln_receiver_peer, isTao ? 'tao_refunded' : 'sol_refunded');
      if (!rs.ok) return { ok: false, error: rs.error, trade: null };
      if (normalizeHex(envelope.body.payment_hash_hex) !== normalizeHex(next.escrow.payment_hash_hex)) {
        return { ok: false, error: `${label} payment_hash mismatch vs escrow`, trade: null };
      }
      if (isTao) {
        if (String(envelope.body.settlement_id) !== String(next.escrow.settlement_id)) {
          return { ok: false, error: 'TAO_REFUNDED settlement_id mismatch vs escrow', trade: null };
        }
      } else if (String(envelope.body.escrow_pda) !== String(next.escrow.escrow_pda)) {
        return { ok: false, error: 'SOL_REFUNDED escrow_pda mismatch vs escrow', trade: null };
      }
      if (next.escrow.refund_after_unix !== undefined && next.escrow.refund_after_unix !== null) {
        const refundMs = unixSecToMs(next.escrow.refund_after_unix);
        if (!Number.isFinite(refundMs)) {
          return { ok: false, error: `${label} invalid refund_after_unix`, trade: null };
        }
        if (envelope.ts < refundMs) {
          return { ok: false, error: `${label} too early`, trade: null };
        }
      }
      if (next.refunded) {
        const priorTx = isTao ? String(next.refunded.tx_id) : String(next.refunded.tx_sig);
        const gotTx = isTao ? String(envelope.body.tx_id) : String(envelope.body.tx_sig);
        if (priorTx !== gotTx) {
          return { ok: false, error: `${label} tx mismatch vs prior refund`, trade: null };
        }
      } else {
        next.refunded = envelope.body;
      }
      next.state = STATE.REFUNDED;
      return { ok: true, error: null, trade: next };
    }

    case KIND.CANCEL: {
      if (next.state === STATE.CANCELED) return { ok: true, error: null, trade: next };
      if ([STATE.CLAIMED, STATE.REFUNDED].includes(next.state)) {
        return { ok: false, error: `CANCEL not allowed in terminal state=${next.state}`, trade: null };
      }
      // Either side may cancel before escrow is created.
      if ([STATE.ESCROW, STATE.LN_PAID].includes(next.state)) {
        return { ok: false, error: `CANCEL not allowed after escrow creation (state=${next.state})`, trade: null };
      }
      next.state = STATE.CANCELED;
      next.canceled_reason = envelope.body.reason || null;
      return { ok: true, error: null, trade: next };
    }

    case KIND.STATUS: {
      // Status is informational; do not mutate state except maybe keep last.
      return { ok: true, error: null, trade: next };
    }

    default:
      return { ok: false, error: `Unhandled kind: ${envelope.kind}`, trade: null };
  }
}
