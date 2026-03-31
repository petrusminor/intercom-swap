import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TradeReceiptsStore } from '../src/receipts/store.js';
import {
  buildTestStopAfterLnPayBeforeClaimPatch,
  buildTestStopAfterLnPayBeforeClaimPayload,
  buildTestStopBeforeLnPayPayload,
  maybeHandleTestStopAfterLnPayBeforeClaim,
  resolveTestStopAfterLnPayBeforeClaimConfig,
  resolveTestStopBeforeLnPayConfig,
} from '../scripts/rfq-taker.mjs';

test('rfq taker test-stop-before-ln-pay: normal mode leaves the stop disabled', () => {
  const cfg = resolveTestStopBeforeLnPayConfig({ enabledRaw: undefined, lnNetwork: 'regtest' });
  assert.deepEqual(cfg, {
    enabled: false,
    warnings: [],
  });
});

test('rfq taker test-stop-before-ln-pay: test mode enables a loud warning on regtest', () => {
  const cfg = resolveTestStopBeforeLnPayConfig({ enabledRaw: '1', lnNetwork: 'regtest' });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.warnings.length, 1);
  assert.match(
    cfg.warnings[0],
    /TEST MODE: stopping taker immediately before lnPay\(\) for deterministic refund-path testing/
  );
});

test('rfq taker test-stop-before-ln-pay: rejected outside regtest', () => {
  assert.throws(
    () => resolveTestStopBeforeLnPayConfig({ enabledRaw: '1', lnNetwork: 'mainnet' }),
    /only supported when --ln-network regtest/i
  );
});

test('rfq taker test-stop-before-ln-pay: payload includes the explicit stop reason and pre-pay artifacts', () => {
  const payload = buildTestStopBeforeLnPayPayload({
    tradeId: 'swap_test_stop',
    swapChannel: 'swap:swap_test_stop',
    invoice: {
      bolt11: 'lnbcrt1testinvoice',
      payment_hash_hex: 'A'.repeat(64),
    },
    escrow: {
      settlement_id: '0x' + '1'.repeat(64),
      refund_after_unix: 1775000000,
    },
  });

  assert.deepEqual(payload, {
    stop_reason: 'test_stop_before_ln_pay',
    trade_id: 'swap_test_stop',
    swap_channel: 'swap:swap_test_stop',
    ln_invoice_bolt11: 'lnbcrt1testinvoice',
    ln_payment_hash_hex: 'a'.repeat(64),
    settlement_id: '0x' + '1'.repeat(64),
    refund_after_unix: 1775000000,
  });
});

test('rfq taker test-stop-before-ln-pay: stop reason can be recorded distinctly in receipts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-rfqtaker-teststop-'));
  const dbPath = path.join(dir, 'receipts.sqlite');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    const tradeId = 'swap_test_stop_receipts';
    const payload = buildTestStopBeforeLnPayPayload({
      tradeId,
      swapChannel: `swap:${tradeId}`,
      invoice: {
        bolt11: 'lnbcrt1testinvoice',
        payment_hash_hex: 'b'.repeat(64),
      },
      escrow: {
        settlement_id: '0x' + '2'.repeat(64),
        refund_after_unix: 1775000100,
      },
    });

    store.upsertTrade(tradeId, {
      settlement_kind: 'tao-evm',
      role: 'taker',
      swap_channel: `swap:${tradeId}`,
      state: 'escrow',
      tao_amount_atomic: '2000000000000000',
      ln_invoice_bolt11: payload.ln_invoice_bolt11,
      ln_payment_hash_hex: payload.ln_payment_hash_hex,
      last_error: payload.stop_reason,
    });
    store.appendEvent(tradeId, 'test_stop_before_ln_pay', payload);

    const row = store.getTrade(tradeId);
    assert.equal(row.last_error, 'test_stop_before_ln_pay');
    assert.equal(row.ln_invoice_bolt11, 'lnbcrt1testinvoice');
    assert.equal(row.ln_payment_hash_hex, 'b'.repeat(64));

    const eventRow = store.db
      .prepare('SELECT kind, payload_json FROM events WHERE trade_id = ? ORDER BY id DESC LIMIT 1')
      .get(tradeId);
    assert.equal(eventRow.kind, 'test_stop_before_ln_pay');
    assert.deepEqual(JSON.parse(eventRow.payload_json), payload);
  } finally {
    store.close();
  }
});

test('rfq taker test-stop-after-ln-pay-before-claim: normal mode leaves claim path untouched', async () => {
  const warnings = [];
  const events = [];
  const persisted = [];
  let cleanedUp = false;
  const handled = await maybeHandleTestStopAfterLnPayBeforeClaim({
    enabled: false,
    tradeId: 'swap_claim_normal',
    swapChannel: 'swap:swap_claim_normal',
    settlementKind: 'tao-evm',
    tradeState: 'ln_paid',
    paymentHashHex: 'c'.repeat(64),
    preimageHex: 'd'.repeat(64),
    escrow: {
      settlement_id: '0x' + '1'.repeat(64),
      refund_after_unix: 1775000200,
    },
    persistTrade: (...args) => persisted.push(args),
    writeWarning: (line) => warnings.push(line),
    writeEvent: (payload) => events.push(payload),
    cleanupAndExit: async () => {
      cleanedUp = true;
    },
  });

  assert.equal(handled, false);
  assert.deepEqual(warnings, []);
  assert.deepEqual(events, []);
  assert.deepEqual(persisted, []);
  assert.equal(cleanedUp, false);
});

test('rfq taker test-stop-after-ln-pay-before-claim: test mode enables a loud warning on regtest', () => {
  const cfg = resolveTestStopAfterLnPayBeforeClaimConfig({ enabledRaw: '1', lnNetwork: 'regtest' });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.warnings.length, 1);
  assert.match(
    cfg.warnings[0],
    /TEST MODE: stopping taker immediately after successful lnPay\(\) and before settlement claim/
  );
});

test('rfq taker test-stop-after-ln-pay-before-claim: rejected outside regtest', () => {
  assert.throws(
    () => resolveTestStopAfterLnPayBeforeClaimConfig({ enabledRaw: '1', lnNetwork: 'mainnet' }),
    /only supported when --ln-network regtest/i
  );
});

test('rfq taker test-stop-after-ln-pay-before-claim: payload and patch preserve recovery artifacts distinctly', () => {
  const stopPayload = buildTestStopAfterLnPayBeforeClaimPayload({
    tradeId: 'swap_claim_stop',
    swapChannel: 'swap:swap_claim_stop',
    paymentHashHex: 'E'.repeat(64),
    preimageHex: 'F'.repeat(64),
    escrow: {
      settlement_id: '0x' + '3'.repeat(64),
      refund_after_unix: 1775000300,
    },
  });

  assert.deepEqual(stopPayload, {
    stop_reason: 'test_stop_after_ln_pay_before_claim',
    trade_id: 'swap_claim_stop',
    swap_channel: 'swap:swap_claim_stop',
    ln_payment_hash_hex: 'e'.repeat(64),
    ln_preimage_hex: 'f'.repeat(64),
    settlement_id: '0x' + '3'.repeat(64),
    refund_after_unix: 1775000300,
  });

  const patch = buildTestStopAfterLnPayBeforeClaimPatch({
    settlementKind: 'tao-evm',
    tradeState: 'ln_paid',
    stopPayload,
  });
  assert.deepEqual(patch, {
    ln_payment_hash_hex: 'e'.repeat(64),
    ln_preimage_hex: 'f'.repeat(64),
    state: 'ln_paid',
    last_error: 'test_stop_after_ln_pay_before_claim',
    tao_settlement_id: '0x' + '3'.repeat(64),
    tao_refund_after_unix: 1775000300,
  });
});

test('rfq taker test-stop-after-ln-pay-before-claim: stop reason is recorded distinctly in receipts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-rfqtaker-claimstop-'));
  const dbPath = path.join(dir, 'receipts.sqlite');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    const tradeId = 'swap_claim_stop_receipts';
    const warnings = [];
    const events = [];
    let cleanedUp = false;

    await maybeHandleTestStopAfterLnPayBeforeClaim({
      enabled: true,
      tradeId,
      swapChannel: `swap:${tradeId}`,
      settlementKind: 'tao-evm',
      tradeState: 'ln_paid',
      paymentHashHex: '9'.repeat(64),
      preimageHex: '8'.repeat(64),
      escrow: {
        settlement_id: '0x' + '7'.repeat(64),
        refund_after_unix: 1775000400,
      },
      persistTrade: (patch, eventKind, eventPayload) => {
        store.upsertTrade(tradeId, {
          settlement_kind: 'tao-evm',
          role: 'taker',
          swap_channel: `swap:${tradeId}`,
          ...patch,
        });
        store.appendEvent(tradeId, eventKind, eventPayload);
      },
      writeWarning: (line) => warnings.push(line),
      writeEvent: (payload) => events.push(payload),
      cleanupAndExit: async () => {
        cleanedUp = true;
      },
    });

    const row = store.getTrade(tradeId);
    assert.equal(row.state, 'ln_paid');
    assert.equal(row.last_error, 'test_stop_after_ln_pay_before_claim');
    assert.equal(row.ln_payment_hash_hex, '9'.repeat(64));
    assert.equal(row.ln_preimage_hex, '8'.repeat(64));
    assert.equal(row.tao_settlement_id, '0x' + '7'.repeat(64));
    assert.equal(row.tao_refund_after_unix, 1775000400);
    assert.equal(cleanedUp, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'test_stop_after_ln_pay_before_claim');
    assert.equal(warnings.length, 2);

    const eventRow = store.db
      .prepare('SELECT kind, payload_json FROM events WHERE trade_id = ? ORDER BY id DESC LIMIT 1')
      .get(tradeId);
    assert.equal(eventRow.kind, 'test_stop_after_ln_pay_before_claim');
    const payload = JSON.parse(eventRow.payload_json);
    assert.equal(payload.stop_reason, 'test_stop_after_ln_pay_before_claim');
    assert.equal(payload.ln_preimage_hex, '8'.repeat(64));
  } finally {
    store.close();
  }
});
