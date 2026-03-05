import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openTradeReceiptsStore } from '../src/receipts/store.js';
import { persistTradeReceipt, resolveReceiptsDbPath } from '../scripts/rfq-maker.mjs';

test('rfq-maker receipts path defaults beside peer keypair', () => {
  const peerKeypairPath = path.join('stores', 'swap-maker', 'db', 'keypair.json');
  const resolved = resolveReceiptsDbPath({ receiptsDbPathRaw: '', peerKeypairPath });
  assert.equal(resolved, path.join(path.resolve('stores', 'swap-maker', 'db'), 'receipts.db'));
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
        tao_amount_atomic: '4200000000',
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
