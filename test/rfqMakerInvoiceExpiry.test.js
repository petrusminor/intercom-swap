import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LN_INVOICE_EXPIRY_SEC,
  resolveLnInvoiceExpirySec,
} from '../scripts/rfq-maker.mjs';

test('rfq-maker: omitted --ln-invoice-expiry-sec defaults to 3600', () => {
  assert.equal(DEFAULT_LN_INVOICE_EXPIRY_SEC, 3600);
  assert.equal(resolveLnInvoiceExpirySec(undefined), 3600);
  assert.equal(resolveLnInvoiceExpirySec(null), 3600);
});

test('rfq-maker: explicit --ln-invoice-expiry-sec overrides default', () => {
  assert.equal(resolveLnInvoiceExpirySec('7200'), 7200);
});
