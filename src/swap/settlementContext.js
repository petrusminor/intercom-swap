import { deriveIntercomswapAppHashForBinding } from './app.js';
import {
  buildRefundFieldsForPair,
  getDefaultPairForSettlementKind,
  normalizePair,
  normalizeRefundPolicyForPair,
} from './pairs.js';
import { normalizeSettlementTerms } from './settlementTerms.js';
import { evaluatePrePayTimelockSafety, parseUnixSecondsOrNull } from './timelockPolicy.js';
import { getSettlementBinding } from '../../settlement/providerFactory.js';

export function buildSettlementContext(opts = {}) {
  const resolvedPair = normalizePair(opts.pair || getDefaultPairForSettlementKind(opts.settlementKind));
  const out = { pair: resolvedPair };

  if (
    opts.settlementKind !== undefined ||
    opts.solanaProgramId !== undefined ||
    opts.taoHtlcAddress !== undefined ||
    opts.taoChainId !== undefined
  ) {
    out.settlementBinding = getSettlementBinding(opts.settlementKind, {
      solanaProgramId: opts.solanaProgramId,
      taoHtlcAddress: opts.taoHtlcAddress,
      taoChainId: opts.taoChainId,
    });
    out.expectedAppHash = deriveIntercomswapAppHashForBinding(out.settlementBinding);
  }

  if (opts.terms !== undefined) {
    out.normalizedTerms = normalizeSettlementTerms(opts.terms, resolvedPair);
  }

  if (opts.refundRaw !== undefined || opts.refundDefaults !== undefined) {
    out.refundPolicy = normalizeRefundPolicyForPair(resolvedPair, opts.refundRaw || {}, opts.refundDefaults || {});
    if (opts.refundNowUnix !== undefined) {
      out.refundFields = buildRefundFieldsForPair(resolvedPair, out.refundPolicy, opts.refundNowUnix);
    }
  }

  if (opts.timelock !== undefined) {
    const timelock = opts.timelock || {};
    const invoiceExpiryUnix =
      timelock.invoiceExpiryUnix ??
      parseUnixSecondsOrNull(timelock.invoiceBody?.expires_at_unix) ??
      parseUnixSecondsOrNull(timelock.decodedInvoice?.expires_at_unix);
    out.timelockSafety = evaluatePrePayTimelockSafety({
      ...timelock,
      invoiceExpiryUnix,
    });
  }

  return out;
}
