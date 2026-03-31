import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TradeReceiptsStore } from '../src/receipts/store.js';
import {
  applyOnchainSettlementReconciliation,
  applyOnchainRefundReconciliation,
  classifyTaoOnchainReconciliation,
  isEligibleForOnchainClaimReconciliation,
  isEligibleForOnchainRefundReconciliation,
} from '../scripts/swapreconcile.mjs';

function makeDbPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `intercomswap-swapreconcile-${label}-`));
  return path.join(dir, 'receipts.sqlite');
}

test('swapreconcile: escrow taker trade with test stop is eligible for on-chain refund reconciliation', () => {
  assert.equal(
    isEligibleForOnchainRefundReconciliation({
      state: 'escrow',
      last_error: 'test_stop_before_ln_pay',
      tao_settlement_id: '0x' + '1'.repeat(64),
      tao_lock_tx_id: '0x' + '2'.repeat(64),
      ln_preimage_hex: null,
    }),
    true
  );
});

test('swapreconcile: maker escrow trade is eligible for on-chain claim reconciliation', () => {
  assert.equal(
    isEligibleForOnchainClaimReconciliation({
      role: 'maker',
      state: 'escrow',
      tao_settlement_id: '0x' + '1'.repeat(64),
      tao_lock_tx_id: '0x' + '2'.repeat(64),
    }),
    true
  );
});

test('swapreconcile: classifies missing locked TAO swap as refunded for ambiguous taker state', () => {
  const decision = classifyTaoOnchainReconciliation({
    trade: {
      state: 'escrow',
      last_error: 'test_stop_before_ln_pay',
      tao_settlement_id: '0x' + '1'.repeat(64),
      tao_lock_tx_id: '0x' + '2'.repeat(64),
      ln_preimage_hex: null,
    },
    onchain: { status: 'missing' },
  });
  assert.deepEqual(decision, {
    eligible: true,
    shouldUpdate: true,
    nextState: 'refunded',
    reason: 'swap_missing_onchain_after_lock',
  });
});

test('swapreconcile: classifies claimed TAO swap as claimed for maker escrow state', () => {
  const decision = classifyTaoOnchainReconciliation({
    trade: {
      role: 'maker',
      state: 'escrow',
      tao_settlement_id: '0x' + '1'.repeat(64),
      tao_lock_tx_id: '0x' + '2'.repeat(64),
      tao_claim_tx_id: null,
    },
    onchain: { status: 'claimed', txId: '0x' + '3'.repeat(64) },
  });
  assert.deepEqual(decision, {
    eligible: true,
    shouldUpdate: true,
    nextState: 'claimed',
    reason: 'swap_claimed_onchain',
  });
});

test('swapreconcile: manual reconciliation updates taker receipts from escrow to refunded and preserves last_error', () => {
  const dbPath = makeDbPath('update');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    const tradeId = 'swap_reconcile_taker_1';
    const nowMs = 1775001234000;
    store.upsertTrade(tradeId, {
      settlement_kind: 'tao-evm',
      role: 'taker',
      state: 'escrow',
      swap_channel: `swap:${tradeId}`,
      tao_amount_atomic: '2000000000000000',
      tao_settlement_id: '0x' + '1'.repeat(64),
      tao_lock_tx_id: '0x' + '2'.repeat(64),
      tao_refund_after_unix: 1775001000,
      ln_payment_hash_hex: 'a'.repeat(64),
      last_error: 'test_stop_before_ln_pay',
    });

    const before = store.getTrade(tradeId);
    const decision = applyOnchainRefundReconciliation({
      store,
      trade: before,
      onchain: { status: 'missing' },
      nowMs,
    });

    assert.equal(decision.updated, true);

    const after = store.getTrade(tradeId);
    assert.equal(after.state, 'refunded');
    assert.equal(after.last_error, 'test_stop_before_ln_pay');
    assert.equal(after.reconciliation_source, 'onchain');
    assert.equal(after.reconciliation_ts, nowMs);

    const eventRow = store.db
      .prepare('SELECT kind, payload_json FROM events WHERE trade_id = ? ORDER BY id DESC LIMIT 1')
      .get(tradeId);
    assert.equal(eventRow.kind, 'onchain_reconcile_refunded');
    const payload = JSON.parse(eventRow.payload_json);
    assert.equal(payload.source, 'onchain');
    assert.equal(payload.local_state_before, 'escrow');
    assert.equal(payload.local_last_error, 'test_stop_before_ln_pay');
    assert.equal(payload.onchain_status, 'missing');
  } finally {
    store.close();
  }
});

test('swapreconcile: manual reconciliation updates maker receipts from escrow to claimed and records on-chain claim tx', () => {
  const dbPath = makeDbPath('maker-claimed');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    const tradeId = 'swap_reconcile_maker_1';
    const nowMs = 1775005678000;
    const claimTxId = '0x' + '3'.repeat(64);
    const lockTxId = '0x' + '2'.repeat(64);
    store.upsertTrade(tradeId, {
      settlement_kind: 'tao-evm',
      role: 'maker',
      state: 'escrow',
      swap_channel: `swap:${tradeId}`,
      tao_amount_atomic: '2000000000000000',
      tao_settlement_id: '0x' + '1'.repeat(64),
      tao_lock_tx_id: lockTxId,
      ln_payment_hash_hex: 'a'.repeat(64),
    });

    const before = store.getTrade(tradeId);
    const decision = applyOnchainSettlementReconciliation({
      store,
      trade: before,
      onchain: { status: 'claimed', txId: claimTxId, evidence_source: 'event_log' },
      nowMs,
    });

    assert.equal(decision.updated, true);

    const after = store.getTrade(tradeId);
    assert.equal(after.state, 'claimed');
    assert.equal(after.tao_lock_tx_id, lockTxId);
    assert.equal(after.tao_claim_tx_id, claimTxId);
    assert.equal(after.reconciliation_source, 'onchain');
    assert.equal(after.reconciliation_ts, nowMs);

    const eventRow = store.db
      .prepare('SELECT kind, payload_json FROM events WHERE trade_id = ? ORDER BY id DESC LIMIT 1')
      .get(tradeId);
    assert.equal(eventRow.kind, 'onchain_reconcile_claimed');
    const payload = JSON.parse(eventRow.payload_json);
    assert.equal(payload.source, 'onchain');
    assert.equal(payload.local_state_before, 'escrow');
    assert.equal(payload.onchain_status, 'claimed');
    assert.equal(payload.tx_id, claimTxId);
  } finally {
    store.close();
  }
});

test('swapreconcile: claimed/preimage-present trades are not reclassified as refunded', () => {
  const decision = classifyTaoOnchainReconciliation({
    trade: {
      state: 'escrow',
      last_error: '',
      tao_settlement_id: '0x' + '1'.repeat(64),
      tao_lock_tx_id: '0x' + '2'.repeat(64),
      ln_preimage_hex: 'b'.repeat(64),
    },
    onchain: { status: 'missing' },
  });
  assert.deepEqual(decision, {
    eligible: false,
    shouldUpdate: false,
    reason: 'local_state_not_reconcilable',
  });
});

test('swapreconcile: refund reconciliation remains unchanged when on-chain status is missing', () => {
  const dbPath = makeDbPath('refund-unchanged');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    const tradeId = 'swap_reconcile_refund_unchanged_1';
    const nowMs = 1775008901000;
    const refundTxId = '0x' + '4'.repeat(64);
    store.upsertTrade(tradeId, {
      settlement_kind: 'tao-evm',
      role: 'taker',
      state: 'escrow',
      swap_channel: `swap:${tradeId}`,
      tao_amount_atomic: '2000000000000000',
      tao_settlement_id: '0x' + '1'.repeat(64),
      tao_lock_tx_id: '0x' + '2'.repeat(64),
      tao_refund_after_unix: 1775001000,
      ln_payment_hash_hex: 'a'.repeat(64),
      last_error: 'test_stop_before_ln_pay',
    });

    const before = store.getTrade(tradeId);
    const decision = applyOnchainSettlementReconciliation({
      store,
      trade: before,
      onchain: { status: 'refunded', txId: refundTxId, evidence_source: 'event_log' },
      nowMs,
    });

    assert.equal(decision.updated, true);
    const after = store.getTrade(tradeId);
    assert.equal(after.state, 'refunded');
    assert.equal(after.tao_refund_tx_id, refundTxId);
    assert.equal(after.reconciliation_source, 'onchain');
    assert.equal(after.reconciliation_ts, nowMs);
  } finally {
    store.close();
  }
});
