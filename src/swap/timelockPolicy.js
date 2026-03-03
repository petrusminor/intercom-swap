export function parseUnixSecondsOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function evaluatePrePayTimelockSafety({
  refundAfterUnix,
  invoiceExpiryUnix = null,
  nowUnix = null,
  minTimelockRemainingSec,
  invoiceExpirySafetyMarginSec = null,
  requireRefundAfterGreaterThanInvoiceExpiryPlusMin = false,
} = {}) {
  const refundAfter = parseUnixSecondsOrNull(refundAfterUnix);
  if (refundAfter === null) {
    return { ok: false, code: 'refund_after_invalid' };
  }

  const now = parseUnixSecondsOrNull(nowUnix);
  if (now !== null) {
    const remainingSec = refundAfter - now;
    if (remainingSec < Number(minTimelockRemainingSec)) {
      return {
        ok: false,
        code: 'timelock_too_short',
        refundAfterUnix: refundAfter,
        remainingSec,
        minTimelockRemainingSec: Number(minTimelockRemainingSec),
      };
    }
  }

  const invoiceExpiry = parseUnixSecondsOrNull(invoiceExpiryUnix);
  if (invoiceExpiry !== null) {
    if (requireRefundAfterGreaterThanInvoiceExpiryPlusMin) {
      const minSafeRefundAfterUnix = invoiceExpiry + Number(minTimelockRemainingSec);
      if (refundAfter <= minSafeRefundAfterUnix) {
        return {
          ok: false,
          code: 'invoice_expiry_violation_strict',
          refundAfterUnix: refundAfter,
          invoiceExpiryUnix: invoiceExpiry,
          minTimelockRemainingSec: Number(minTimelockRemainingSec),
          minSafeRefundAfterUnix,
        };
      }
    } else {
      const minRefundAfter = invoiceExpiry + Number(invoiceExpirySafetyMarginSec);
      if (refundAfter < minRefundAfter) {
        return {
          ok: false,
          code: 'invoice_expiry_violation_margin',
          refundAfterUnix: refundAfter,
          invoiceExpiryUnix: invoiceExpiry,
          invoiceExpirySafetyMarginSec: Number(invoiceExpirySafetyMarginSec),
          minRefundAfterUnix: minRefundAfter,
        };
      }
    }
  }

  return { ok: true, code: null, refundAfterUnix: refundAfter };
}
