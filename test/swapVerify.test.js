import test from 'node:test';
import assert from 'node:assert/strict';

import { verifySwapPrePay } from '../src/swap/verify.js';
import {
  TaoEvmSettlementProvider,
  computeTaoSwapIdFromLockInputs,
} from '../settlement/tao-evm/TaoEvmSettlementProvider.js';

test('swap verify: payer pre-pay checks (invoice + escrow + terms)', () => {
  const bolt11 =
    'lnbcrt50u1p5ctmrmsp59rehxdv7fmge9navus48wmze3lur2fgggtxvn6l7k79hvplc67rspp58kwsh4lqgaa3urr0d05u2vqzk89r0d4h5ndtvfpjx5d63lkm92qsdq8v3jhxccxqyjw5qcqp29qxpqysgqcvu675fp6ttyrq82jnsdydgav9fp236d4ve89wkr34jwu3syefaq9nftzqjmgdma0z0020j9qdrzmmnfs3cqwmp53fhtmw7u0cck0jcpwwrwrt';
  const paymentHashHex = '3d9d0bd7e0477b1e0c6f6be9c53002b1ca37b6b7a4dab62432351ba8fedb2a81';

  const terms = {
    btc_sats: 5000,
    usdt_amount: '1000000',
    sol_mint: 'So11111111111111111111111111111111111111112',
    sol_recipient: '11111111111111111111111111111111',
    sol_refund: '11111111111111111111111111111111',
    sol_refund_after_unix: 1770989000,
  };

  const invoiceBody = {
    bolt11,
    payment_hash_hex: paymentHashHex,
    amount_msat: '5000000',
    expires_at_unix: 1770989307,
  };

  const escrowBody = {
    payment_hash_hex: paymentHashHex,
    program_id: '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF',
    escrow_pda: '11111111111111111111111111111111',
    vault_ata: '11111111111111111111111111111111',
    mint: terms.sol_mint,
    amount: terms.usdt_amount,
    refund_after_unix: 1770990000,
    recipient: terms.sol_recipient,
    refund: terms.sol_refund,
    tx_sig: 'dummy_tx_sig_1',
  };

  const ok = verifySwapPrePay({
    terms,
    invoiceBody,
    escrowBody,
    now_unix: 1770988000,
  });
  assert.equal(ok.ok, true, ok.error);

  // Safety margins: pre-pay must not happen too close to invoice expiry or escrow refund_after.
  const tooCloseToRefund = verifySwapPrePay({
    terms,
    invoiceBody,
    // Move refund_after earlier (but still >= terms.sol_refund_after_unix) so the refund margin triggers
    // while the invoice is still valid.
    escrowBody: { ...escrowBody, refund_after_unix: 1770989200 },
    // refund_after_unix=1770989200; default safety margin is 10 minutes, so 599s remaining must fail.
    now_unix: 1770989200 - 599,
  });
  assert.equal(tooCloseToRefund.ok, false);
  assert.match(tooCloseToRefund.error, /refund_after/i);
  assert.match(tooCloseToRefund.error, /margin|too soon/i);

  const tooCloseToInvExpiry = verifySwapPrePay({
    terms,
    invoiceBody,
    escrowBody,
    // expires_at_unix=1770989307; default invoice expiry margin is 60s, so 59s remaining must fail.
    now_unix: 1770989307 - 59,
  });
  assert.equal(tooCloseToInvExpiry.ok, false);
  assert.match(tooCloseToInvExpiry.error, /invoice/i);
  assert.match(tooCloseToInvExpiry.error, /margin|too soon/i);

  const badEscrow = verifySwapPrePay({
    terms,
    invoiceBody,
    escrowBody: { ...escrowBody, payment_hash_hex: '00'.repeat(32) },
    now_unix: 1770988000,
  });
  assert.equal(badEscrow.ok, false);
  assert.match(badEscrow.error, /payment_hash/i);

  const badInvoice = verifySwapPrePay({
    terms,
    invoiceBody: { ...invoiceBody, payment_hash_hex: '00'.repeat(32) },
    escrowBody,
    now_unix: 1770988000,
  });
  assert.equal(badInvoice.ok, false);
  assert.match(badInvoice.error, /invoice invalid/i);
});

test('tao provider swapId derivation matches Solidity abi.encode fixture', () => {
  const swapId = computeTaoSwapIdFromLockInputs({
    sender: '0x1111111111111111111111111111111111111111',
    receiver: '0x2222222222222222222222222222222222222222',
    value: '123456789',
    refundAfter: 1700003600,
    hashlock: `0x${'33'.repeat(32)}`,
    clientSalt: `0x${'44'.repeat(32)}`,
  });
  assert.equal(swapId, '0xc03231f0357e14ef58515752a6266673cf32932e1e712b8f02723a736534ae17');
});

test('tao provider lock: rejects malformed hash, zero amount, and unsafe refund window before chain calls', async () => {
  let chainCalls = 0;
  const lockFn = async () => {
    chainCalls += 1;
    return { hash: `0x${'ab'.repeat(32)}`, wait: async () => {} };
  };
  lockFn.staticCall = async () => {
    chainCalls += 1;
    return `0x${'cd'.repeat(32)}`;
  };
  const mock = {
    _ensureReady: async () => {},
    _requireHtlc: () => ({ lock: lockFn }),
    wallet: { getAddress: async () => '0x1111111111111111111111111111111111111111' },
    _resolveClientSalt: () => `0x${'ef'.repeat(32)}`,
    _setMetadata: () => {},
    _getMetadata: () => ({}),
    confirmations: 1,
    htlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
  };
  const lock = TaoEvmSettlementProvider.prototype.lock;
  const nowUnix = Math.floor(Date.now() / 1000);
  const common = {
    recipient: '0x2222222222222222222222222222222222222222',
    refundAddress: '0x1111111111111111111111111111111111111111',
    paymentHashHex: '11'.repeat(32),
    amountAtomic: '1000',
    refundAfterUnix: nowUnix + 7200,
    terms: {},
  };

  await assert.rejects(
    () => lock.call(mock, { ...common, paymentHashHex: `0x${'11'.repeat(32)}` }),
    /without 0x prefix/i
  );
  await assert.rejects(
    () => lock.call(mock, { ...common, amountAtomic: '0' }),
    /amountAtomic must be > 0/i
  );
  await assert.rejects(
    () => lock.call(mock, { ...common, refundAfterUnix: nowUnix + 120 }),
    /refundAfterUnix too soon/i
  );
  assert.equal(chainCalls, 0, 'validation failures should happen before any on-chain call');
});

test('tao provider lock: emits stage callbacks and preserves broadcast callback behavior when tx hash is returned', async () => {
  const stages = [];
  const broadcasts = [];
  const lockFn = async () => ({
    hash: `0x${'ab'.repeat(32)}`,
    wait: async () => {},
  });
  const mock = {
    _ensureReady: async () => {},
    _requireHtlc: () => ({ lock: lockFn }),
    wallet: { getAddress: async () => '0x1111111111111111111111111111111111111111' },
    _resolveClientSalt: () => `0x${'ef'.repeat(32)}`,
    _setMetadata: () => {},
    _getMetadata: () => ({ settlement_id: `0x${'cd'.repeat(32)}` }),
    confirmations: 1,
    htlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
  };
  const lock = TaoEvmSettlementProvider.prototype.lock;

  const res = await lock.call(mock, {
    recipient: '0x2222222222222222222222222222222222222222',
    refundAddress: '0x1111111111111111111111111111111111111111',
    paymentHashHex: '11'.repeat(32),
    amountAtomic: '1000',
    refundAfterUnix: Math.floor(Date.now() / 1000) + 7200,
    terms: {},
    onStage: async (evt) => stages.push(evt),
    onBroadcast: async (evt) => broadcasts.push(evt),
  });

  assert.equal(res.txId, `0x${'ab'.repeat(32)}`);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].txId, `0x${'ab'.repeat(32)}`);
  assert.deepEqual(
    stages.map((s) => s.stage),
    ['rpc_send', 'tx_hash', 'wait_confirm', 'confirmed']
  );
});

test('tao provider verifySwapPrePayOnchain: refund_after must be strictly greater than invoice expiry + min timelock', async () => {
  const prevMin = process.env.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC;
  process.env.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC = '3600';

  try {
    const provider = Object.create(TaoEvmSettlementProvider.prototype);
    provider.htlcAddress = '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653';
    provider.verifyPrePay = async () => ({
      ok: true,
      metadata: {
        sender: '0x3333333333333333333333333333333333333333',
        receiver: '0x1111111111111111111111111111111111111111',
        amount_atomic: '5000000',
        refund_after_unix: 1770992907,
        hashlock: `0x${'44'.repeat(32)}`,
        claimed: false,
        refunded: false,
        contract_address: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
      },
    });

    const input = {
      terms: {
        pair: 'BTC_LN/TAO_EVM',
        tao_amount_atomic: '5000000',
        sol_recipient: '0x1111111111111111111111111111111111111111',
        sol_refund: '0x3333333333333333333333333333333333333333',
        sol_refund_after_unix: 1770992907,
      },
      invoiceBody: {
        payment_hash_hex: '44'.repeat(32),
        expires_at_unix: 1770989307,
      },
      escrowBody: {
        payment_hash_hex: '44'.repeat(32),
        settlement_id: `0x${'55'.repeat(32)}`,
        htlc_address: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
        amount_atomic: '5000000',
        refund_after_unix: 1770992907,
        recipient: '0x1111111111111111111111111111111111111111',
        refund: '0x3333333333333333333333333333333333333333',
      },
    };

    const equalBoundary = await provider.verifySwapPrePayOnchain(input);
    assert.equal(equalBoundary.ok, false);
    assert.match(equalBoundary.error, /> invoice_expiry_unix \+ INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC/i);

    provider.verifyPrePay = async () => ({
      ok: true,
      metadata: {
        sender: '0x3333333333333333333333333333333333333333',
        receiver: '0x1111111111111111111111111111111111111111',
        amount_atomic: '5000000',
        refund_after_unix: 1770992908,
        hashlock: `0x${'44'.repeat(32)}`,
        claimed: false,
        refunded: false,
        contract_address: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
      },
    });

    const aboveBoundary = await provider.verifySwapPrePayOnchain({
      ...input,
      escrowBody: { ...input.escrowBody, refund_after_unix: 1770992908 },
      terms: { ...input.terms, sol_refund_after_unix: 1770992908 },
    });
    assert.equal(aboveBoundary.ok, true, aboveBoundary.error);
  } finally {
    if (prevMin === undefined) delete process.env.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC;
    else process.env.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC = prevMin;
  }
});

test('tao provider verifySwapPrePayOnchain: refund_after must leave enough time relative to now', async () => {
  const prevMin = process.env.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC;
  process.env.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC = '3600';

  try {
    const provider = Object.create(TaoEvmSettlementProvider.prototype);
    provider.htlcAddress = '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653';
    provider.verifyPrePay = async () => ({
      ok: true,
      metadata: {
        sender: '0x3333333333333333333333333333333333333333',
        receiver: '0x1111111111111111111111111111111111111111',
        amount_atomic: '5000000',
        refund_after_unix: 1770990000,
        hashlock: `0x${'44'.repeat(32)}`,
        claimed: false,
        refunded: false,
        contract_address: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
      },
    });

    const res = await provider.verifySwapPrePayOnchain({
      nowUnix: 1770986401,
      terms: {
        pair: 'BTC_LN/TAO_EVM',
        tao_amount_atomic: '5000000',
        sol_recipient: '0x1111111111111111111111111111111111111111',
        sol_refund: '0x3333333333333333333333333333333333333333',
        sol_refund_after_unix: 1770990000,
      },
      invoiceBody: {
        payment_hash_hex: '44'.repeat(32),
      },
      escrowBody: {
        payment_hash_hex: '44'.repeat(32),
        settlement_id: `0x${'66'.repeat(32)}`,
        htlc_address: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
        amount_atomic: '5000000',
        refund_after_unix: 1770990000,
        recipient: '0x1111111111111111111111111111111111111111',
        refund: '0x3333333333333333333333333333333333333333',
      },
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /refund_after_unix too soon for safe pay/i);
  } finally {
    if (prevMin === undefined) delete process.env.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC;
    else process.env.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC = prevMin;
  }
});
