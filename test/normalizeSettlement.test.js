import test from 'node:test';
import assert from 'node:assert/strict';

import { PAIR } from '../src/swap/constants.js';
import { normalizeSettlement } from '../src/swap/normalizeSettlement.js';

test('normalizeSettlement maps USDT_SOL legacy settlement fields', () => {
  const out = normalizeSettlement(PAIR.BTC_LN__USDT_SOL, {
    usdt_amount: '1000000',
    sol_recipient: 'RecipientBase58',
    sol_refund: 'RefundBase58',
    sol_refund_after_unix: 1770000000,
    sol_mint: 'MintBase58',
  });

  assert.deepEqual(out, {
    recipient: 'RecipientBase58',
    refund: 'RefundBase58',
    refund_after_unix: 1770000000,
    amount: '1000000',
    settlement_kind: 'solana',
    settlement_asset_id: 'MintBase58',
  });
});

test('normalizeSettlement maps TAO_EVM legacy settlement fields', () => {
  const out = normalizeSettlement(PAIR.BTC_LN__TAO_EVM, {
    tao_amount_atomic: '2000000000000000000',
    sol_recipient: '0x1111111111111111111111111111111111111111',
    sol_refund: '0x2222222222222222222222222222222222222222',
    sol_refund_after_unix: 1770001234,
    sol_mint: '0x3333333333333333333333333333333333333333',
  });

  assert.deepEqual(out, {
    recipient: '0x1111111111111111111111111111111111111111',
    refund: '0x2222222222222222222222222222222222222222',
    refund_after_unix: 1770001234,
    amount: '2000000000000000000',
    settlement_kind: 'tao-evm',
    settlement_asset_id: '0x3333333333333333333333333333333333333333',
  });
});

test('normalizeSettlement prefers generic settlement tool fields when present', () => {
  const out = normalizeSettlement(PAIR.BTC_LN__TAO_EVM, {
    amount: '300',
    recipient: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    refund: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    refund_after_unix: 1770009999,
    mint: '0xcccccccccccccccccccccccccccccccccccccccc',
    tao_amount_atomic: '200',
    sol_recipient: '0xdddddddddddddddddddddddddddddddddddddddd',
  });

  assert.deepEqual(out, {
    recipient: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    refund: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    refund_after_unix: 1770009999,
    amount: '300',
    settlement_kind: 'tao-evm',
    settlement_asset_id: '0xcccccccccccccccccccccccccccccccccccccccc',
  });
});
