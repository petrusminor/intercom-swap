import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSolanaProgramId,
  resolveTaoEvmHtlcAddress,
  SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID,
} from '../settlement/defaults.js';
import { getSettlementBinding } from '../settlement/providerFactory.js';
import { getDefaultTaoEvmHtlcAddress } from '../settlement/tao-evm/TaoEvmSettlementProvider.js';

const EXPLICIT_SOLANA_PROGRAM_ID = '11111111111111111111111111111111';
const EXPLICIT_TAO_HTLC_ADDRESS = '0x1111111111111111111111111111111111111111';
const ENV_TAO_HTLC_ADDRESS = '0x2222222222222222222222222222222222222222';

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test('settlement defaults: solana explicit override wins', () => {
  assert.equal(resolveSolanaProgramId(EXPLICIT_SOLANA_PROGRAM_ID), EXPLICIT_SOLANA_PROGRAM_ID);
  assert.equal(getSettlementBinding('solana', { solanaProgramId: EXPLICIT_SOLANA_PROGRAM_ID }).binding_id, EXPLICIT_SOLANA_PROGRAM_ID);
});

test('settlement defaults: solana canonical default works', () => {
  assert.equal(resolveSolanaProgramId(), SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID);
  assert.equal(getSettlementBinding('solana', {}).binding_id, SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID);
});

test('settlement defaults: tao explicit override wins over env and canonical default', () => {
  withEnv('TAO_EVM_HTLC_ADDRESS', ENV_TAO_HTLC_ADDRESS, () => {
    assert.equal(resolveTaoEvmHtlcAddress(EXPLICIT_TAO_HTLC_ADDRESS), EXPLICIT_TAO_HTLC_ADDRESS);
    assert.equal(getSettlementBinding('tao-evm', { taoHtlcAddress: EXPLICIT_TAO_HTLC_ADDRESS }).binding_id, EXPLICIT_TAO_HTLC_ADDRESS);
  });
});

test('settlement defaults: tao env fallback works', () => {
  withEnv('TAO_EVM_HTLC_ADDRESS', ENV_TAO_HTLC_ADDRESS, () => {
    assert.equal(resolveTaoEvmHtlcAddress(), ENV_TAO_HTLC_ADDRESS);
    assert.equal(getSettlementBinding('tao-evm', {}).binding_id, ENV_TAO_HTLC_ADDRESS);
  });
});

test('settlement defaults: tao canonical default works', () => {
  withEnv('TAO_EVM_HTLC_ADDRESS', undefined, () => {
    const canonicalDefault = getDefaultTaoEvmHtlcAddress();
    assert.equal(resolveTaoEvmHtlcAddress(), canonicalDefault);
    assert.equal(getSettlementBinding('tao-evm', {}).binding_id, canonicalDefault);
  });
});
