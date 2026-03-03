import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePrePayTimelockSafety } from '../src/swap/timelockPolicy.js';

test('timelock policy: non-strict invoice safety matches executor/taker semantics', () => {
  const res = evaluatePrePayTimelockSafety({
    refundAfterUnix: 1770992907,
    invoiceExpiryUnix: 1770992008,
    nowUnix: 1770989300,
    minTimelockRemainingSec: 3600,
    invoiceExpirySafetyMarginSec: 900,
    requireRefundAfterGreaterThanInvoiceExpiryPlusMin: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'invoice_expiry_violation_margin');
});

test('timelock policy: strict invoice safety preserves TAO strict inequality', () => {
  const res = evaluatePrePayTimelockSafety({
    refundAfterUnix: 1770992907,
    invoiceExpiryUnix: 1770989307,
    nowUnix: 1770989000,
    minTimelockRemainingSec: 3600,
    requireRefundAfterGreaterThanInvoiceExpiryPlusMin: true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'invoice_expiry_violation_strict');
});
