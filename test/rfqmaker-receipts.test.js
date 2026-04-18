import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openTradeReceiptsStore } from '../src/receipts/store.js';
import {
  buildTaoLockCheckpoint,
  handleMakerTaoLockStage,
  persistTradeReceipt,
  resolveMakerCleanupPersistence,
  resolveReceiptsDbPath,
} from '../scripts/rfq-maker.mjs';
import { resolveReceiptsDbPath as resolveTakerReceiptsDbPath } from '../scripts/rfq-taker.mjs';

test('rfq-maker receipts path defaults beside peer keypair', () => {
  const peerKeypairPath = path.join('stores', 'swap-maker', 'db', 'keypair.json');
  const resolved = resolveReceiptsDbPath({ receiptsDbPathRaw: '', peerKeypairPath });
  assert.equal(resolved, path.join(path.resolve('stores', 'swap-maker', 'db'), 'receipts.db'));
});

test('receipts path precedence: CLI > env > default for maker+taker helpers', () => {
  const peerKeypairPath = path.join('stores', 'swap-taker', 'db', 'keypair.json');
  const env = { INTERCOMSWAP_RECEIPTS_DB: '/tmp/receipts-from-env.sqlite' };
  const fromFlagMaker = resolveReceiptsDbPath({
    receiptsDbPathRaw: '/tmp/receipts-from-flag-maker.sqlite',
    peerKeypairPath,
    env,
  });
  assert.equal(fromFlagMaker, '/tmp/receipts-from-flag-maker.sqlite');
  const fromEnvMaker = resolveReceiptsDbPath({
    receiptsDbPathRaw: '',
    peerKeypairPath,
    env,
  });
  assert.equal(fromEnvMaker, '/tmp/receipts-from-env.sqlite');
  const fromDefaultMaker = resolveReceiptsDbPath({
    receiptsDbPathRaw: '',
    peerKeypairPath,
    env: {},
  });
  assert.equal(fromDefaultMaker, path.join(path.resolve('stores', 'swap-taker', 'db'), 'receipts.db'));

  const fromFlagTaker = resolveTakerReceiptsDbPath({
    receiptsDbPathRaw: '/tmp/receipts-from-flag-taker.sqlite',
    peerKeypairPath,
    env,
  });
  assert.equal(fromFlagTaker, '/tmp/receipts-from-flag-taker.sqlite');
  const fromEnvTaker = resolveTakerReceiptsDbPath({
    receiptsDbPathRaw: '',
    peerKeypairPath,
    env,
  });
  assert.equal(fromEnvTaker, '/tmp/receipts-from-env.sqlite');
});

test('rfq-maker persistTradeReceipt writes one trade row early', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-rfqmaker-receipts-'));
  const peerKeypairPath = path.join(root, 'db', 'keypair.json');
  fs.mkdirSync(path.dirname(peerKeypairPath), { recursive: true });
  fs.writeFileSync(peerKeypairPath, '[]');
  const dbPath = resolveReceiptsDbPath({ receiptsDbPathRaw: '', peerKeypairPath });
  const receipts = openTradeReceiptsStore({ dbPath });
  try {
    const ok = persistTradeReceipt({
      receipts,
      tradeId: 'trade_receipt_1',
      settlementKind: 'tao-evm',
      patch: {
        role: 'maker',
        rfq_channel: '0000intercomswapbtctao',
        btc_sats: 50000,
        tao_amount_atomic: '4200000000000000000',
        state: 'init',
      },
      eventKind: 'rfq_received',
      eventPayload: { trade_id: 'trade_receipt_1' },
    });
    assert.equal(ok, true);

    const countRow = receipts.db.prepare('SELECT COUNT(*) AS n FROM trades').get();
    assert.equal(Number(countRow.n), 1);
    const tradeRow = receipts.db.prepare('SELECT trade_id, settlement_kind, state FROM trades LIMIT 1').get();
    assert.equal(tradeRow.trade_id, 'trade_receipt_1');
    assert.equal(tradeRow.settlement_kind, 'tao-evm');
    assert.equal(tradeRow.state, 'init');
  } finally {
    receipts.close();
  }
});

test('rfq-maker tao lock checkpoints persist deterministic settlement metadata before pay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-rfqmaker-taolock-'));
  const peerKeypairPath = path.join(root, 'db', 'keypair.json');
  fs.mkdirSync(path.dirname(peerKeypairPath), { recursive: true });
  fs.writeFileSync(peerKeypairPath, '[]');
  const dbPath = resolveReceiptsDbPath({ receiptsDbPathRaw: '', peerKeypairPath });
  const receipts = openTradeReceiptsStore({ dbPath });
  try {
    const tradeId = 'swap_tao_lock_checkpoint_1';
    const checkpoint = buildTaoLockCheckpoint({
      tradeId,
      rfqId: 'rfq_abc123',
      quoteId: 'quote_def456',
      sender: '0x1111111111111111111111111111111111111111',
      receiver: '0x2222222222222222222222222222222222222222',
      amountAtomic: '4200000000000000000',
      refundAfterUnix: 1771000000,
      paymentHashHex: '44'.repeat(32),
      htlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
    });

    const preLockOk = persistTradeReceipt({
      receipts,
      tradeId,
      settlementKind: 'tao-evm',
      patch: {
        role: 'maker',
        state: 'locking',
        ln_payment_hash_hex: '44'.repeat(32),
        tao_settlement_id: checkpoint.settlementId,
        tao_htlc_address: checkpoint.htlcAddress,
        tao_amount_atomic: checkpoint.amountAtomic,
        tao_recipient: checkpoint.recipient,
        tao_refund: checkpoint.refundAddress,
        tao_refund_after_unix: checkpoint.refundAfterUnix,
      },
      eventKind: 'tao_locking',
      eventPayload: {
        client_salt: checkpoint.clientSalt,
        settlement_id: checkpoint.settlementId,
      },
    });
    assert.equal(preLockOk, true);

    const midRow = receipts.getTrade(tradeId);
    assert.equal(midRow.settlement_kind, 'tao-evm');
    assert.equal(midRow.state, 'locking');
    assert.equal(midRow.tao_settlement_id, checkpoint.settlementId);
    assert.equal(midRow.tao_lock_tx_id, null);
    assert.equal(midRow.sol_recipient, null);
    assert.equal(midRow.last_error, null);

    const evRow = receipts.db
      .prepare('SELECT payload_json FROM events WHERE trade_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(tradeId, 'tao_locking');
    const evPayload = JSON.parse(String(evRow?.payload_json || '{}'));
    assert.equal(evPayload.client_salt, checkpoint.clientSalt);

    const postBroadcastOk = persistTradeReceipt({
      receipts,
      tradeId,
      settlementKind: 'tao-evm',
      patch: {
        state: 'escrow',
        tao_settlement_id: checkpoint.settlementId,
        tao_lock_tx_id: `0x${'ab'.repeat(32)}`,
      },
      eventKind: 'tao_lock_broadcast',
      eventPayload: {
        client_salt: checkpoint.clientSalt,
        settlement_id: checkpoint.settlementId,
        tx_id: `0x${'ab'.repeat(32)}`,
      },
    });
    assert.equal(postBroadcastOk, true);

    const endRow = receipts.getTrade(tradeId);
    assert.equal(endRow.state, 'escrow');
    assert.equal(endRow.tao_settlement_id, checkpoint.settlementId);
    assert.equal(endRow.tao_lock_tx_id, `0x${'ab'.repeat(32)}`);
    assert.equal(endRow.sol_recipient, null);
    assert.equal(endRow.last_error, null);
  } finally {
    receipts.close();
  }
});

test('rfq-maker timeout cleanup does not regress locking state back to invoice before tx hash', () => {
  const patch = resolveMakerCleanupPersistence(
    {
      pair: 'BTC_LN/TAO_EVM',
      trade: { state: 'invoice' },
      taoLockPhase: 'locking',
      taoLockTxId: null,
      lastLockError: '',
    },
    { reason: 'swap timeout (swap-timeout-sec=5)' }
  );
  assert.equal(patch.state, 'locking');
  assert.equal(patch.last_error, 'swap timeout (swap-timeout-sec=5)');
});

test('rfq-maker cleanup preserves terminal claimed state for tao trades with lock tx', () => {
  const patch = resolveMakerCleanupPersistence(
    {
      pair: 'BTC_LN/TAO_EVM',
      trade: { state: 'claimed' },
      taoLockPhase: 'escrow',
      taoLockTxId: `0x${'a'.repeat(64)}`,
      lastLockError: '',
    },
    { reason: 'swap_done' }
  );
  assert.equal(patch.state, 'claimed');
});

test('rfq-maker receipts stay claimed after cleanup and preserve tao_claim_tx_id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-rfqmaker-claimed-cleanup-'));
  const peerKeypairPath = path.join(root, 'db', 'keypair.json');
  fs.mkdirSync(path.dirname(peerKeypairPath), { recursive: true });
  fs.writeFileSync(peerKeypairPath, '[]');
  const dbPath = resolveReceiptsDbPath({ receiptsDbPathRaw: '', peerKeypairPath });
  const receipts = openTradeReceiptsStore({ dbPath });
  try {
    const tradeId = 'swap_claim_cleanup_1';
    const settlementId = `0x${'1'.repeat(64)}`;
    const lockTxId = `0x${'2'.repeat(64)}`;
    const claimTxId = `0x${'3'.repeat(64)}`;

    persistTradeReceipt({
      receipts,
      tradeId,
      settlementKind: 'tao-evm',
      patch: {
        role: 'maker',
        state: 'escrow',
        tao_settlement_id: settlementId,
        tao_lock_tx_id: lockTxId,
      },
      eventKind: 'tao_htlc_locked_sent',
      eventPayload: { trade_id: tradeId, settlement_id: settlementId, tx_id: lockTxId },
    });

    persistTradeReceipt({
      receipts,
      tradeId,
      settlementKind: 'tao-evm',
      patch: {
        state: 'claimed',
        tao_settlement_id: settlementId,
        tao_claim_tx_id: claimTxId,
      },
      eventKind: 'swap_done',
      eventPayload: { trade_id: tradeId, state: 'claimed' },
    });

    const cleanupPatch = resolveMakerCleanupPersistence(
      {
        pair: 'BTC_LN/TAO_EVM',
        trade: { state: 'claimed' },
        taoLockPhase: 'escrow',
        taoLockTxId: lockTxId,
        lastLockError: '',
      },
      { reason: 'swap_done' }
    );

    persistTradeReceipt({
      receipts,
      tradeId,
      settlementKind: 'tao-evm',
      patch: cleanupPatch,
      eventKind: 'swap_cleanup',
      eventPayload: { trade_id: tradeId, reason: 'swap_done' },
    });

    const row = receipts.getTrade(tradeId);
    assert.equal(row.state, 'claimed');
    assert.equal(row.tao_claim_tx_id, claimTxId);
    assert.equal(row.tao_lock_tx_id, lockTxId);
  } finally {
    receipts.close();
  }
});

test('rfq-maker receipts stay refunded after cleanup and preserve tao_refund_tx_id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-rfqmaker-refunded-cleanup-'));
  const peerKeypairPath = path.join(root, 'db', 'keypair.json');
  fs.mkdirSync(path.dirname(peerKeypairPath), { recursive: true });
  fs.writeFileSync(peerKeypairPath, '[]');
  const dbPath = resolveReceiptsDbPath({ receiptsDbPathRaw: '', peerKeypairPath });
  const receipts = openTradeReceiptsStore({ dbPath });
  try {
    const tradeId = 'swap_refund_cleanup_1';
    const settlementId = `0x${'4'.repeat(64)}`;
    const lockTxId = `0x${'5'.repeat(64)}`;
    const refundTxId = `0x${'6'.repeat(64)}`;

    persistTradeReceipt({
      receipts,
      tradeId,
      settlementKind: 'tao-evm',
      patch: {
        role: 'maker',
        state: 'escrow',
        tao_settlement_id: settlementId,
        tao_lock_tx_id: lockTxId,
      },
      eventKind: 'tao_htlc_locked_sent',
      eventPayload: { trade_id: tradeId, settlement_id: settlementId, tx_id: lockTxId },
    });

    persistTradeReceipt({
      receipts,
      tradeId,
      settlementKind: 'tao-evm',
      patch: {
        state: 'refunded',
        tao_settlement_id: settlementId,
        tao_refund_tx_id: refundTxId,
      },
      eventKind: 'swap_refunded',
      eventPayload: { trade_id: tradeId, state: 'refunded' },
    });

    const cleanupPatch = resolveMakerCleanupPersistence(
      {
        pair: 'BTC_LN/TAO_EVM',
        trade: { state: 'refunded' },
        taoLockPhase: 'escrow',
        taoLockTxId: lockTxId,
        lastLockError: '',
      },
      { reason: 'refunded' }
    );

    persistTradeReceipt({
      receipts,
      tradeId,
      settlementKind: 'tao-evm',
      patch: cleanupPatch,
      eventKind: 'swap_cleanup',
      eventPayload: { trade_id: tradeId, reason: 'refunded' },
    });

    const row = receipts.getTrade(tradeId);
    assert.equal(row.state, 'refunded');
    assert.equal(row.tao_refund_tx_id, refundTxId);
    assert.equal(row.tao_lock_tx_id, lockTxId);
  } finally {
    receipts.close();
  }
});

test('rfq-maker tao lock error stage persists last_error clearly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-rfqmaker-taoerror-'));
  const peerKeypairPath = path.join(root, 'db', 'keypair.json');
  fs.mkdirSync(path.dirname(peerKeypairPath), { recursive: true });
  fs.writeFileSync(peerKeypairPath, '[]');
  const dbPath = resolveReceiptsDbPath({ receiptsDbPathRaw: '', peerKeypairPath });
  const receipts = openTradeReceiptsStore({ dbPath });
  try {
    const ctx = {
      tradeId: 'swap_tao_lock_error_1',
      pair: 'BTC_LN/TAO_EVM',
      trade: { state: 'invoice' },
      taoLockPhase: 'locking',
      taoSettlementId: `0x${'1'.repeat(64)}`,
      taoLockTxId: null,
      lastLockError: null,
    };
    handleMakerTaoLockStage({
      ctx,
      stage: 'error',
      details: { error: 'rpc send failed: connection reset by peer' },
      persistTrade: (tradeId, patch, eventKind, eventPayload) =>
        persistTradeReceipt({
          receipts,
          tradeId,
          settlementKind: 'tao-evm',
          patch,
          eventKind,
          eventPayload,
        }),
    });

    const row = receipts.getTrade(ctx.tradeId);
    assert.equal(row.state, 'locking');
    assert.equal(row.last_error, 'rpc send failed: connection reset by peer');
    const evRow = receipts.db
      .prepare('SELECT payload_json FROM events WHERE trade_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(ctx.tradeId, 'tao_lock_error');
    const evPayload = JSON.parse(String(evRow?.payload_json || '{}'));
    assert.equal(evPayload.error, 'rpc send failed: connection reset by peer');
  } finally {
    receipts.close();
  }
});
