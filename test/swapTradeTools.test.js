import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ToolExecutor } from '../src/prompt/executor.js';
import { TradeReceiptsStore } from '../src/receipts/store.js';

function makeReceiptsDbPath(name) {
  const dir = path.join(process.cwd(), 'onchain', 'receipts', 'test-tools');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sqlite`);
}

function newExecutor({ dbPath, settlementKind = 'solana' }) {
  return new ToolExecutor({
    scBridge: { url: 'ws://127.0.0.1:1', token: 'x' },
    peer: { keypairPath: '' },
    ln: {},
    solana: {
      rpcUrls: 'http://127.0.0.1:8899',
      commitment: 'confirmed',
      programId: '11111111111111111111111111111111',
      usdtMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
    receipts: { dbPath: path.relative(process.cwd(), dbPath) },
    settlementKind,
    taoEvm: {
      htlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
    },
  });
}

test('get_trades returns both TAO and USDT trades with normalized settlement amounts', async () => {
  const dbPath = makeReceiptsDbPath('get-trades');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('trade-sol', {
      settlement_kind: 'solana',
      role: 'maker',
      state: 'escrow',
      btc_sats: 1500,
      usdt_amount: '330000',
      sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      sol_recipient: 'RecipientBase58',
      sol_refund: 'RefundBase58',
      sol_refund_after_unix: Math.floor(Date.now() / 1000) + 3600,
      updated_at: 100,
    });
    store.upsertTrade('trade-tao', {
      settlement_kind: 'tao-evm',
      role: 'taker',
      state: 'ln_paid',
      btc_sats: 2500,
      usdt_amount: '999999999',
      tao_amount_atomic: '2000000000000000000',
      tao_htlc_address: '0x3333333333333333333333333333333333333333',
      tao_recipient: '0x1111111111111111111111111111111111111111',
      tao_refund: '0x2222222222222222222222222222222222222222',
      tao_refund_after_unix: Math.floor(Date.now() / 1000) + 7200,
      ln_preimage_hex: 'a'.repeat(64),
      updated_at: 200,
    });
  } finally {
    store.close();
  }

  const ex = newExecutor({ dbPath, settlementKind: 'tao-evm' });
  const out = await ex.execute('intercomswap_get_trades', { limit: 10 }, { autoApprove: false });

  assert.equal(out.type, 'trades');
  assert.deepEqual(
    out.trades.map((t) => ({
      trade_id: t.trade_id,
      pair: t.pair,
      settlement_kind: t.settlement_kind,
      settlement_amount: t.settlement_amount,
      actionable: t.actionable,
    })),
    [
      {
        trade_id: 'trade-tao',
        pair: 'BTC_LN/TAO_EVM',
        settlement_kind: 'tao-evm',
        settlement_amount: '2000000000000000000',
        actionable: true,
      },
      {
        trade_id: 'trade-sol',
        pair: 'BTC_LN/USDT_SOL',
        settlement_kind: 'solana',
        settlement_amount: '330000',
        actionable: false,
      },
    ]
  );
});

test('get_trade_status settlement_amount always comes from normalizedSettlement.amount', async () => {
  const dbPath = makeReceiptsDbPath('normalized-amount');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('trade-tao-amount-source', {
      settlement_kind: 'tao-evm',
      state: 'ln_paid',
      swap_channel: 'swap:trade-tao-amount-source',
      btc_sats: 1111,
      usdt_amount: '123',
      tao_amount_atomic: '456000000000000000',
      tao_htlc_address: '0x3333333333333333333333333333333333333333',
      tao_recipient: '0x1111111111111111111111111111111111111111',
      tao_refund: '0x2222222222222222222222222222222222222222',
      tao_refund_after_unix: Math.floor(Date.now() / 1000) + 1000,
      ln_preimage_hex: 'e'.repeat(64),
    });
  } finally {
    store.close();
  }

  const ex = newExecutor({ dbPath, settlementKind: 'tao-evm' });
  const out = await ex.execute('intercomswap_get_trade_status', { trade_id: 'trade-tao-amount-source' }, { autoApprove: false });

  assert.equal(out.settlement_amount, '456000000000000000');
  assert.notEqual(out.settlement_amount, '123');
});

test('get_trade_status returns normalized settlement fields', async () => {
  const dbPath = makeReceiptsDbPath('get-trade-status');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('trade-tao-status', {
      settlement_kind: 'tao-evm',
      role: 'maker',
      swap_channel: 'swap:trade-tao-status',
      state: 'escrow',
      btc_sats: 1900,
      tao_amount_atomic: '123000000000000000',
      tao_htlc_address: '0x3333333333333333333333333333333333333333',
      tao_recipient: '0x1111111111111111111111111111111111111111',
      tao_refund: '0x2222222222222222222222222222222222222222',
      tao_refund_after_unix: Math.floor(Date.now() / 1000) + 5000,
      tao_lock_tx_id: '0x' + '4'.repeat(64),
    });
    store.appendEvent('trade-tao-status', 'tao_htlc_locked', { channel: 'swap:trade-tao-status' });
  } finally {
    store.close();
  }

  const ex = newExecutor({ dbPath, settlementKind: 'tao-evm' });
  const out = await ex.execute('intercomswap_get_trade_status', { trade_id: 'trade-tao-status' }, { autoApprove: false });

  assert.equal(out.type, 'trade_status');
  assert.equal(out.pair, 'BTC_LN/TAO_EVM');
  assert.equal(out.settlement_kind, 'tao-evm');
  assert.equal(out.settlement_amount, '123000000000000000');
  assert.deepEqual(out.settlement, {
    recipient: '0x1111111111111111111111111111111111111111',
    refund: '0x2222222222222222222222222222222222222222',
    refund_after_unix: out.settlement.refund_after_unix,
  });
  assert.equal(out.onchain.lock_tx_id, '0x' + '4'.repeat(64));
  assert.equal(out.actions_available.can_claim, false);
});

test('claim rejects invalid states', async () => {
  const dbPath = makeReceiptsDbPath('claim-invalid');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('trade-claim-invalid', {
      settlement_kind: 'tao-evm',
      state: 'escrow',
      swap_channel: 'swap:trade-claim-invalid',
      tao_amount_atomic: '1',
      tao_htlc_address: '0x3333333333333333333333333333333333333333',
    });
  } finally {
    store.close();
  }

  const ex = newExecutor({ dbPath, settlementKind: 'tao-evm' });
  await assert.rejects(
    () => ex.execute('intercomswap_claim', { trade_id: 'trade-claim-invalid' }, { autoApprove: true }),
    /claim not allowed in state=escrow/i
  );
});

test('refund rejects invalid states', async () => {
  const dbPath = makeReceiptsDbPath('refund-invalid');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('trade-refund-invalid', {
      settlement_kind: 'solana',
      state: 'ln_paid',
      swap_channel: 'swap:trade-refund-invalid',
      usdt_amount: '1',
      sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      sol_refund_after_unix: Math.floor(Date.now() / 1000) - 10,
      ln_preimage_hex: 'b'.repeat(64),
    });
  } finally {
    store.close();
  }

  const ex = newExecutor({ dbPath, settlementKind: 'solana' });
  await assert.rejects(
    () => ex.execute('intercomswap_refund', { trade_id: 'trade-refund-invalid' }, { autoApprove: true }),
    /refund not allowed in state=ln_paid/i
  );
});

test('claim and refund delegate to existing control paths for both pairs', async () => {
  const nowUnix = Math.floor(Date.now() / 1000);

  const claimDbPath = makeReceiptsDbPath('claim-ok');
  const claimStore = TradeReceiptsStore.open({ dbPath: claimDbPath });
  try {
    claimStore.upsertTrade('trade-claim-sol', {
      settlement_kind: 'solana',
      state: 'ln_paid',
      swap_channel: 'swap:trade-claim-sol',
      btc_sats: 1000,
      usdt_amount: '5000',
      sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      sol_recipient: 'RecipientBase58',
      sol_refund: 'RefundBase58',
      sol_refund_after_unix: nowUnix + 3600,
      ln_preimage_hex: 'c'.repeat(64),
    });
  } finally {
    claimStore.close();
  }

  const refundDbPath = makeReceiptsDbPath('refund-ok');
  const refundStore = TradeReceiptsStore.open({ dbPath: refundDbPath });
  try {
    refundStore.upsertTrade('trade-refund-tao', {
      settlement_kind: 'tao-evm',
      state: 'escrow',
      swap_channel: 'swap:trade-refund-tao',
      btc_sats: 1000,
      tao_amount_atomic: '700000000000000000',
      tao_htlc_address: '0x3333333333333333333333333333333333333333',
      tao_recipient: '0x1111111111111111111111111111111111111111',
      tao_refund: '0x2222222222222222222222222222222222222222',
      tao_refund_after_unix: nowUnix - 5,
      ln_payment_hash_hex: 'd'.repeat(64),
    });
  } finally {
    refundStore.close();
  }

  const claimEx = newExecutor({ dbPath: claimDbPath, settlementKind: 'solana' });
  const claimBase = claimEx.execute.bind(claimEx);
  claimEx.execute = async function wrapped(toolName, args, opts) {
    if (toolName === 'intercomswap_swap_sol_claim_and_post') {
      assert.equal(args.channel, 'swap:trade-claim-sol');
      assert.equal(args.trade_id, 'trade-claim-sol');
      assert.equal(args.preimage_hex, 'c'.repeat(64));
      assert.equal(args.mint, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
      return { type: 'sol_claimed_posted', tx_sig: 'sol-claim-tx' };
    }
    return claimBase(toolName, args, opts);
  };

  const refundEx = newExecutor({ dbPath: refundDbPath, settlementKind: 'tao-evm' });
  const refundBase = refundEx.execute.bind(refundEx);
  refundEx.execute = async function wrapped(toolName, args, opts) {
    if (toolName === 'intercomswap_swap_sol_refund_and_post') {
      assert.equal(args.channel, 'swap:trade-refund-tao');
      assert.equal(args.trade_id, 'trade-refund-tao');
      assert.equal(args.payment_hash_hex, 'd'.repeat(64));
      assert.equal(args.mint, '0x3333333333333333333333333333333333333333');
      return { type: 'tao_refunded_posted', tx_id: '0x' + '5'.repeat(64) };
    }
    return refundBase(toolName, args, opts);
  };

  const claimOut = await claimEx.execute('intercomswap_claim', { trade_id: 'trade-claim-sol' }, { autoApprove: true });
  assert.deepEqual(claimOut, {
    type: 'claim_result',
    trade_id: 'trade-claim-sol',
    status: 'claimed',
    tx_id: 'sol-claim-tx',
    settlement_kind: 'solana',
  });

  const refundOut = await refundEx.execute('intercomswap_refund', { trade_id: 'trade-refund-tao' }, { autoApprove: true });
  assert.deepEqual(refundOut, {
    type: 'refund_result',
    trade_id: 'trade-refund-tao',
    status: 'refunded',
    tx_id: '0x' + '5'.repeat(64),
    settlement_kind: 'tao-evm',
  });
});

test('refund actionability normalizes refund_after_unix from seconds and milliseconds', async () => {
  const dbPath = makeReceiptsDbPath('refund-timing-normalization');
  const nowSec = 1_700_000_000;
  const originalNow = Date.now;
  Date.now = () => nowSec * 1000;

  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('refund-seconds', {
      settlement_kind: 'tao-evm',
      state: 'escrow',
      swap_channel: 'swap:refund-seconds',
      tao_amount_atomic: '1',
      tao_htlc_address: '0x3333333333333333333333333333333333333333',
      tao_refund_after_unix: nowSec - 5,
    });
    store.upsertTrade('refund-millis', {
      settlement_kind: 'tao-evm',
      state: 'escrow',
      swap_channel: 'swap:refund-millis',
      tao_amount_atomic: '1',
      tao_htlc_address: '0x3333333333333333333333333333333333333333',
      tao_refund_after_unix: (nowSec - 5) * 1000,
    });
  } finally {
    store.close();
  }

  try {
    const ex = newExecutor({ dbPath, settlementKind: 'tao-evm' });
    const out = await ex.execute('intercomswap_get_trades', { limit: 10 }, { autoApprove: false });
    const byId = new Map(out.trades.map((t) => [t.trade_id, t]));
    assert.equal(byId.get('refund-seconds')?.actionable, true);
    assert.equal(byId.get('refund-millis')?.actionable, true);
  } finally {
    Date.now = originalNow;
  }
});

test('refund actionability boundary uses seconds and requires now > refund_after_unix', async () => {
  const dbPath = makeReceiptsDbPath('refund-boundary');
  const nowSec = 1_800_000_000;
  const originalNow = Date.now;
  Date.now = () => nowSec * 1000;

  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('refund-equal-boundary', {
      settlement_kind: 'solana',
      state: 'escrow',
      swap_channel: 'swap:refund-equal-boundary',
      usdt_amount: '1',
      sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      sol_refund_after_unix: nowSec,
    });
    store.upsertTrade('refund-past-boundary', {
      settlement_kind: 'solana',
      state: 'escrow',
      swap_channel: 'swap:refund-past-boundary',
      usdt_amount: '1',
      sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      sol_refund_after_unix: nowSec - 1,
    });
  } finally {
    store.close();
  }

  try {
    const ex = newExecutor({ dbPath, settlementKind: 'solana' });
    const out = await ex.execute('intercomswap_get_trades', { limit: 10 }, { autoApprove: false });
    const byId = new Map(out.trades.map((t) => [t.trade_id, t]));
    assert.equal(byId.get('refund-equal-boundary')?.actionable, false);
    assert.equal(byId.get('refund-past-boundary')?.actionable, true);
  } finally {
    Date.now = originalNow;
  }
});
