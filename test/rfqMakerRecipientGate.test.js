import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldSkipMissingSolRecipient } from '../scripts/rfq-maker.mjs';
import { buildRfqUnsignedEnvelope } from '../src/rfq/buildRfq.js';
import { deriveIntercomswapAppHash } from '../src/swap/app.js';
import { PAIR } from '../src/swap/constants.js';
import { SETTLEMENT_KIND } from '../settlement/providerFactory.js';

function buildRfqForPair(pair, { solRecipient = null } = {}) {
  return buildRfqUnsignedEnvelope({
    tradeId: `trade_${pair.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    pair,
    expectedAppHash: deriveIntercomswapAppHash({
      solanaProgramId:
        pair === PAIR.BTC_LN__TAO_EVM
          ? '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653'
          : '4jL7jyN9B6Yv8qYQF7JQ4x6k7T6R2r8xA4x8V2n4uN4U',
    }),
    btcSats: 50_000,
    amountAtomic: '100000000',
    maxPlatformFeeBps: 10,
    maxTradeFeeBps: 10,
    maxTotalFeeBps: 20,
    settlementRefundAfterSec: 72 * 3600,
    minSolRefundWindowSec: 72 * 3600,
    maxSolRefundWindowSec: 7 * 24 * 3600,
    solRecipient,
    validUntilUnix: Math.floor(Date.now() / 1000) + 60,
  });
}

test('rfq-maker recipient gate: TAO RFQ without sol_recipient is not skipped for missing_sol_recipient', () => {
  const rfq = buildRfqForPair(PAIR.BTC_LN__TAO_EVM, { solRecipient: null });
  const skip = shouldSkipMissingSolRecipient({
    runSwap: true,
    makerSettlementKind: SETTLEMENT_KIND.TAO_EVM,
    pair: rfq.body.pair,
    solRecipient: rfq.body.sol_recipient,
  });
  assert.equal(skip, false);
});

test('rfq-maker recipient gate: SOL RFQ without sol_recipient is skipped with missing_sol_recipient', () => {
  const rfq = buildRfqForPair(PAIR.BTC_LN__USDT_SOL, { solRecipient: null });
  const skip = shouldSkipMissingSolRecipient({
    runSwap: true,
    makerSettlementKind: SETTLEMENT_KIND.SOLANA,
    pair: rfq.body.pair,
    solRecipient: rfq.body.sol_recipient,
  });
  assert.equal(skip, true);
});
