import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolExecutor } from '../src/prompt/executor.js';
import { KIND, PAIR } from '../src/swap/constants.js';

function newExecutor({ settlementKind = 'solana' } = {}) {
  const ex = new ToolExecutor({
    scBridge: { url: 'ws://127.0.0.1:1', token: 'x' },
    peer: { keypairPath: '' },
    ln: {},
    solana: {
      rpcUrls: 'http://127.0.0.1:8899',
      commitment: 'confirmed',
      programId: '11111111111111111111111111111111',
      usdtMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
    receipts: { dbPath: '' },
    settlementKind,
    taoEvm: {
      htlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
    },
  });
  ex._inspectListingState = async () => ({
    trade_id: null,
    rfq_id: null,
    quote_id: null,
    state: null,
    terminal: false,
    active: false,
    swap_channel: null,
    joined_swap: false,
    has_quote_accept: false,
    has_swap_invite: false,
  });
  return ex;
}

test('run_swap accepts BTC_LN/USDT_SOL and returns normalized settlement amount', async () => {
  const ex = newExecutor({ settlementKind: 'solana' });
  const seen = [];
  const baseExecute = ex.execute.bind(ex);
  const quoteEnvelope = {
    v: 1,
    kind: KIND.QUOTE,
    trade_id: 'trade-sol-1',
    body: {
      rfq_id: 'a'.repeat(64),
      pair: PAIR.BTC_LN__USDT_SOL,
      btc_sats: 1500,
      usdt_amount: '330000',
      app_hash: 'abc',
      valid_until_unix: Math.floor(Date.now() / 1000) + 600,
    },
  };
  ex._scWaitFor = async () => ({ channel: '0000intercomswapbtcusdt', message: quoteEnvelope });
  ex.execute = async function wrapped(toolName, args, opts) {
    if (toolName === 'intercomswap_sc_subscribe') return { type: 'subscribed', channels: args.channels };
    if (toolName === 'intercomswap_rfq_post') {
      seen.push({ toolName, args });
      assert.equal(args.pair, PAIR.BTC_LN__USDT_SOL);
      assert.equal(args.btc_sats, 1500);
      assert.equal(args.usdt_amount, '330000');
      return { type: 'rfq_posted', channel: args.channel, rfq_id: 'a'.repeat(64) };
    }
    if (toolName === 'intercomswap_quote_accept') {
      seen.push({ toolName, args });
      assert.equal(args.channel, '0000intercomswapbtcusdt');
      assert.equal(args.ln_liquidity_mode, 'aggregate');
      assert.equal(args.quote_envelope, quoteEnvelope);
      return { type: 'quote_accept_posted', channel: args.channel, rfq_id: 'a'.repeat(64), quote_id: 'b'.repeat(64) };
    }
    if (toolName === 'intercomswap_tradeauto_status') return { type: 'tradeauto_status', running: false, options: null };
    if (toolName === 'intercomswap_tradeauto_start') {
      seen.push({ toolName, args });
      assert.deepEqual(args.channels, ['0000intercomswapbtcusdt']);
      assert.equal(args.settlement, 'solana');
      assert.equal(args.enable_join_invites, true);
      assert.equal(args.enable_settlement, true);
      assert.equal(args.enable_accept_quotes, false);
      return { type: 'tradeauto_started', options: { channels: args.channels } };
    }
    return baseExecute(toolName, args, opts);
  };

  const out = await ex.execute(
    'intercomswap_run_swap',
    {
      channel: '0000intercomswapbtcusdt',
      pair: PAIR.BTC_LN__USDT_SOL,
      trade_id: 'trade-sol-1',
      btc_sats: '1500',
      usdt_amount: 330000,
      auto_execute: true,
      ln_liquidity_mode: 'aggregate',
    },
    { autoApprove: true }
  );

  assert.equal(out.type, 'swap_run_started');
  assert.equal(out.trade_id, 'trade-sol-1');
  assert.equal(out.rfq_id, 'a'.repeat(64));
  assert.equal(out.quote_id, 'b'.repeat(64));
  assert.equal(out.pair, PAIR.BTC_LN__USDT_SOL);
  assert.equal(out.btc_sats, 1500);
  assert.equal(out.settlement_amount, '330000');
  assert.equal(out.settlement_kind, 'solana');
  assert.equal(out.status, 'quote_accepted_tradeauto_started');
  assert.equal(seen.length, 3);
});

test('run_swap accepts BTC_LN/TAO_EVM and preserves tao_amount_atomic', async () => {
  const ex = newExecutor({ settlementKind: 'tao-evm' });
  const baseExecute = ex.execute.bind(ex);
  const quoteEnvelope = {
    v: 1,
    kind: KIND.QUOTE,
    trade_id: 'trade-tao-1',
    body: {
      rfq_id: 'c'.repeat(64),
      pair: PAIR.BTC_LN__TAO_EVM,
      btc_sats: 2400,
      tao_amount_atomic: '2000000000000000000',
      app_hash: 'def',
      valid_until_unix: Math.floor(Date.now() / 1000) + 600,
    },
  };
  ex._scWaitFor = async () => ({ channel: '0000intercomswapbtctao', message: quoteEnvelope });
  ex.execute = async function wrapped(toolName, args, opts) {
    if (toolName === 'intercomswap_sc_subscribe') return { type: 'subscribed', channels: args.channels };
    if (toolName === 'intercomswap_rfq_post') {
      assert.equal(args.pair, PAIR.BTC_LN__TAO_EVM);
      assert.equal(args.tao_amount_atomic, '2000000000000000000');
      return { type: 'rfq_posted', channel: args.channel, rfq_id: 'c'.repeat(64) };
    }
    if (toolName === 'intercomswap_quote_accept') {
      assert.equal(args.quote_envelope, quoteEnvelope);
      return { type: 'quote_accept_posted', channel: args.channel, rfq_id: 'c'.repeat(64), quote_id: 'd'.repeat(64) };
    }
    return baseExecute(toolName, args, opts);
  };

  const out = await ex.execute(
    'intercomswap_run_swap',
    {
      channel: '0000intercomswapbtctao',
      pair: PAIR.BTC_LN__TAO_EVM,
      trade_id: 'trade-tao-1',
      btc_sats: 2400,
      tao_amount_atomic: '2000000000000000000',
      auto_execute: false,
    },
    { autoApprove: true }
  );

  assert.equal(out.type, 'swap_run_started');
  assert.equal(out.trade_id, 'trade-tao-1');
  assert.equal(out.quote_id, 'd'.repeat(64));
  assert.equal(out.pair, PAIR.BTC_LN__TAO_EVM);
  assert.equal(out.settlement_amount, '2000000000000000000');
  assert.equal(out.settlement_kind, 'tao-evm');
  assert.equal(out.status, 'quote_accepted');
});

test('run_swap rejects missing pair-specific amount field', async () => {
  const ex = newExecutor({ settlementKind: 'tao-evm' });

  await assert.rejects(
    () =>
      ex.execute(
        'intercomswap_run_swap',
        {
          channel: '0000intercomswapbtctao',
          pair: PAIR.BTC_LN__TAO_EVM,
          btc_sats: 2400,
        },
        { autoApprove: true }
      ),
    /tao_amount_atomic is required for BTC_LN\/TAO_EVM/i
  );
});
