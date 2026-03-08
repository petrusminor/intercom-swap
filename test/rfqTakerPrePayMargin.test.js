import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateLocalTakerPrePayTimelockSafety,
  resolveTakerRefundAfterMarginConfig,
} from '../scripts/rfq-taker.mjs';

test('rfq taker verify-prepay default rejects when refund_after gap is below 900s', () => {
  const cfg = resolveTakerRefundAfterMarginConfig({ env: {} });
  const res = evaluateLocalTakerPrePayTimelockSafety({
    refundAfterUnix: 5000,
    invoiceExpiryUnix: 4950,
    nowUnix: 1000,
    minTimelockRemainingSec: 3600,
    invoiceExpirySafetyMarginSec: cfg.invoiceExpirySafetyMarginSec,
  });
  assert.equal(cfg.invoiceExpirySafetyMarginSec, 900);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'invoice_expiry_violation_margin');
});

test('rfq taker verify-prepay accepts when INTERCOMSWAP_MIN_REFUND_AFTER_MARGIN_SEC lowers the margin', () => {
  const cfg = resolveTakerRefundAfterMarginConfig({
    env: { INTERCOMSWAP_MIN_REFUND_AFTER_MARGIN_SEC: '30' },
  });
  const res = evaluateLocalTakerPrePayTimelockSafety({
    refundAfterUnix: 5000,
    invoiceExpiryUnix: 4950,
    nowUnix: 1000,
    minTimelockRemainingSec: 3600,
    invoiceExpirySafetyMarginSec: cfg.invoiceExpirySafetyMarginSec,
  });
  assert.equal(cfg.invoiceExpirySafetyMarginSec, 30);
  assert.equal(cfg.unsafeOverrideProvided, true);
  assert.match(
    String(cfg.warnings[0] || ''),
    /UNSAFE: lowering taker refund-after vs invoice-expiry margin to 30s for this process only/
  );
  assert.equal(res.ok, true, res.code);
});

test('rfq taker refund-after margin override is runtime-only and does not persist', () => {
  const overridden = resolveTakerRefundAfterMarginConfig({
    env: { INTERCOMSWAP_MIN_REFUND_AFTER_MARGIN_SEC: '30' },
  });
  assert.equal(overridden.invoiceExpirySafetyMarginSec, 30);
  assert.equal(overridden.unsafeOverrideProvided, true);

  const defaulted = resolveTakerRefundAfterMarginConfig({ env: {} });
  assert.equal(defaulted.invoiceExpirySafetyMarginSec, 900);
  assert.equal(defaulted.unsafeOverrideProvided, false);
});

test('rfq taker refund-after margin default behavior remains unchanged when override is omitted', () => {
  const cfg = resolveTakerRefundAfterMarginConfig({ env: {} });
  assert.equal(cfg.invoiceExpirySafetyMarginSec, 900);
  assert.equal(cfg.unsafeOverrideProvided, false);
  assert.deepEqual(cfg.warnings, []);
});
