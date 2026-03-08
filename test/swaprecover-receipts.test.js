import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TradeReceiptsStore } from '../src/receipts/store.js';
import { persistRefundRecovery } from '../scripts/swaprecover.mjs';
import { SETTLEMENT_KIND } from '../settlement/providerFactory.js';

test('swaprecover refund persistence clears last_error and records tao_refund_tx_id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-swaprecover-receipts-'));
  const dbPath = path.join(dir, 'receipts.sqlite');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    const tradeId = 'swaprecover_refund_tao_1';
    const hash = 'a'.repeat(64);
    const settlementId = '0x' + '1'.repeat(64);
    const txId = '0x' + '2'.repeat(64);

    store.upsertTrade(tradeId, {
      settlement_kind: SETTLEMENT_KIND.TAO_EVM,
      ln_payment_hash_hex: hash,
      tao_settlement_id: settlementId,
      state: 'escrow',
      last_error: 'swap not found on chain',
    });

    persistRefundRecovery({
      store,
      trade: { trade_id: tradeId },
      settlementKind: SETTLEMENT_KIND.TAO_EVM,
      hash,
      settlementId,
      txId,
    });

    const row = store.getTrade(tradeId);
    assert.equal(row.state, 'refunded');
    assert.equal(row.tao_refund_tx_id, txId);
    assert.equal(row.last_error, null);
  } finally {
    store.close();
  }
});
