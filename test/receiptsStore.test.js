import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { TradeReceiptsStore } from '../src/receipts/store.js';

function tmpDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-receipts-'));
  return path.join(dir, `${name}.sqlite`);
}

test('receipts store: listTradesPaged supports offset', () => {
  const dbPath = tmpDbPath('paged');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('t1', { state: 'init', created_at: 1, updated_at: 100 });
    store.upsertTrade('t2', { state: 'init', created_at: 2, updated_at: 300 });
    store.upsertTrade('t3', { state: 'init', created_at: 3, updated_at: 200 });

    const all = store.listTradesPaged({ limit: 10, offset: 0 });
    assert.deepEqual(all.map((t) => t.trade_id), ['t2', 't3', 't1']);

    const page = store.listTradesPaged({ limit: 1, offset: 1 });
    assert.deepEqual(page.map((t) => t.trade_id), ['t3']);
  } finally {
    store.close();
  }
});

test('receipts store: listOpenClaims filters ln_paid with preimage', () => {
  const dbPath = tmpDbPath('claims');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('t1', { state: 'ln_paid', ln_preimage_hex: 'a'.repeat(64), updated_at: 100 });
    store.upsertTrade('t2', { state: 'ln_paid', ln_preimage_hex: null, updated_at: 200 });
    store.upsertTrade('t3', { state: 'escrow', ln_preimage_hex: 'b'.repeat(64), updated_at: 300 });

    const claims = store.listOpenClaims({ limit: 10, offset: 0, state: 'ln_paid' });
    assert.deepEqual(claims.map((t) => t.trade_id), ['t1']);
  } finally {
    store.close();
  }
});

test('receipts store: listOpenRefunds filters escrow by refund_after', () => {
  const dbPath = tmpDbPath('refunds');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('t1', { state: 'escrow', sol_refund_after_unix: 1000, updated_at: 100 });
    store.upsertTrade('t2', { state: 'escrow', sol_refund_after_unix: 2000, updated_at: 200 });
    store.upsertTrade('t3', { state: 'ln_paid', sol_refund_after_unix: 500, updated_at: 300 });

    const refunds = store.listOpenRefunds({ nowUnix: 1500, limit: 10, offset: 0, state: 'escrow' });
    assert.deepEqual(refunds.map((t) => t.trade_id), ['t1']);
  } finally {
    store.close();
  }
});

test('receipts store: solana + tao settlement fields roundtrip and refund selection', () => {
  const dbPath = tmpDbPath('settlement-parity');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    const solHash = 'c'.repeat(64);
    const taoHash = 'd'.repeat(64);
    store.upsertTrade('sol1', {
      settlement_kind: 'solana',
      state: 'escrow',
      ln_payment_hash_hex: solHash,
      sol_refund_after_unix: 1000,
      sol_escrow_pda: 'sol-escrow-1',
      updated_at: 100,
    });
    store.upsertTrade('tao1', {
      settlement_kind: 'tao-evm',
      state: 'escrow',
      ln_payment_hash_hex: taoHash,
      tao_settlement_id: '0x' + '1'.repeat(64),
      tao_htlc_address: '0x' + '2'.repeat(40),
      tao_amount_atomic: '1000000000000000',
      tao_recipient: '0x' + '3'.repeat(40),
      tao_refund: '0x' + '4'.repeat(40),
      tao_refund_after_unix: 1200,
      tao_lock_tx_id: '0x' + '5'.repeat(64),
      updated_at: 200,
    });
    store.upsertTrade('tao-future', {
      settlement_kind: 'tao-evm',
      state: 'escrow',
      ln_payment_hash_hex: 'e'.repeat(64),
      tao_settlement_id: '0x' + '6'.repeat(64),
      tao_refund_after_unix: 2200,
      updated_at: 300,
    });

    const tao = store.getTrade('tao1');
    assert.equal(tao.settlement_kind, 'tao-evm');
    assert.equal(tao.tao_settlement_id, '0x' + '1'.repeat(64));
    assert.equal(tao.tao_htlc_address, '0x' + '2'.repeat(40));
    assert.equal(tao.tao_lock_tx_id, '0x' + '5'.repeat(64));
    assert.equal(tao.ln_payment_hash_hex, taoHash);

    const refunds = store.listOpenRefunds({ nowUnix: 1500, limit: 10, offset: 0, state: 'escrow' });
    assert.deepEqual(
      refunds.map((t) => t.trade_id),
      ['tao1', 'sol1']
    );
  } finally {
    store.close();
  }
});

test('receipts store: listing lock lifecycle supports in_flight -> filled and delete', () => {
  const dbPath = tmpDbPath('listing-locks');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    const key = 'offer:abcd:0';
    const lock1 = store.upsertListingLock(key, {
      listing_type: 'offer_line',
      listing_id: 'abcd:0',
      trade_id: 't1',
      state: 'in_flight',
      note: 'invite_posted',
      meta_json: { quote_id: 'q1' },
    });
    assert.equal(lock1.listing_key, key);
    assert.equal(lock1.state, 'in_flight');
    assert.equal(lock1.trade_id, 't1');

    const byTrade = store.listListingLocksByTrade('t1');
    assert.equal(byTrade.length, 1);
    assert.equal(byTrade[0].listing_key, key);

    const lock2 = store.upsertListingLock(key, {
      listing_type: 'offer_line',
      listing_id: 'abcd:0',
      trade_id: 't1',
      state: 'filled',
      note: 'sol_claimed',
    });
    assert.equal(lock2.state, 'filled');
    assert.equal(lock2.trade_id, 't1');

    store.deleteListingLock(key);
    assert.equal(store.getListingLock(key), null);
  } finally {
    store.close();
  }
});

test('receipts store: settlement kind mismatch protection blocks cross-settlement writes', () => {
  const dbPath = tmpDbPath('settlement-mismatch-guard');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('tao-guard', {
      settlement_kind: 'tao-evm',
      state: 'escrow',
      ln_payment_hash_hex: 'a'.repeat(64),
      tao_settlement_id: '0x' + '1'.repeat(64),
    });
    assert.throws(
      () => store.upsertTrade('tao-guard', { sol_escrow_pda: 'EscrowPdaShouldReject11111111111111111111111' }),
      /settlement_kind=tao-evm cannot update sol_escrow_pda/i
    );
    assert.throws(
      () => store.upsertTrade('tao-guard', { settlement_kind: 'solana' }),
      /settlement_kind mismatch/i
    );

    store.upsertTrade('sol-guard', {
      settlement_kind: 'solana',
      state: 'escrow',
      ln_payment_hash_hex: 'b'.repeat(64),
      sol_escrow_pda: 'EscrowPdaExample111111111111111111111111111111',
    });
    assert.throws(
      () => store.upsertTrade('sol-guard', { tao_settlement_id: '0x' + '2'.repeat(64) }),
      /settlement_kind=solana cannot update tao_settlement_id/i
    );
  } finally {
    store.close();
  }
});
