import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettlementTerms } from '../src/swap/settlementTerms.js';
import { PAIR } from '../src/swap/constants.js';

test('normalizeSettlementTerms exposes settlement-generic fields for TAO without requiring asset id semantics', () => {
  const wireTerms = {
    pair: PAIR.BTC_LN__TAO_EVM,
    sol_mint: undefined,
    sol_recipient: '0x1111111111111111111111111111111111111111',
    sol_refund: '0x2222222222222222222222222222222222222222',
    sol_refund_after_unix: 1770990000,
  };

  assert.deepEqual(normalizeSettlementTerms(wireTerms, PAIR.BTC_LN__TAO_EVM), {
    settlement_recipient: wireTerms.sol_recipient,
    refund_address: wireTerms.sol_refund,
    refund_after_unix: wireTerms.sol_refund_after_unix,
    settlement_asset_id: undefined,
  });
});
