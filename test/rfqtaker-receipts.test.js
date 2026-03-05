import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TradeReceiptsStore } from '../src/receipts/store.js';
import { deriveInvoiceReceiptFields } from '../scripts/rfq-taker.mjs';

const SAMPLE_BOLT11 =
  'lnbcrt12340p1p5ct6ensp525myu22mhh03a2zr636tn59eahjhkprajmd2ppnl586qz27wvjxqpp5xkvweakdjc9m0rlxm3hhmfvz9hd6acjexfkuz06aeax0n2c7u0zqdq8v3jhxccxqyjw5qcqp29qxpqysgqtrheftp4lndgsjz80xx64sf3vfmtn7qzrtdha9mwxqg0mnqqz8hncgk9k3dzh48ftud92w4j4eskck044tdzpkl9ymrjf3hzsf6cjtgpupxvn0';

test('rfq-taker receipts: crash-before-pay checkpoint persists invoice hash for tao trade', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-rfqtaker-receipts-'));
  const dbPath = path.join(dir, 'receipts.sqlite');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    const tradeId = 'swap_taker_crash_before_pay';

    // Simulate checkpoint at swap_joined/accepted.
    store.upsertTrade(tradeId, {
      settlement_kind: 'tao-evm',
      role: 'taker',
      swap_channel: `swap:${tradeId}`,
      btc_sats: 50000,
      tao_amount_atomic: '4200000000',
      state: 'accepted',
    });

    // Simulate receiving LN_INVOICE and crashing before lnPay.
    const invoiceFields = deriveInvoiceReceiptFields({ bolt11: SAMPLE_BOLT11 });
    store.upsertTrade(tradeId, {
      ...invoiceFields,
      state: 'accepted',
    });

    const row = store.getTrade(tradeId);
    assert.equal(row.trade_id, tradeId);
    assert.equal(row.settlement_kind, 'tao-evm');
    assert.equal(row.ln_invoice_bolt11, SAMPLE_BOLT11);
    assert.match(String(row.ln_payment_hash_hex || ''), /^[0-9a-f]{64}$/);
  } finally {
    store.close();
  }
});
