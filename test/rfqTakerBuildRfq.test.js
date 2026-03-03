import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRfqUnsignedEnvelope } from '../src/rfq/buildRfq.js';
import { resolveSettlementRefundAfterSec } from '../src/rfq/cliFlags.js';
import { deriveIntercomswapAppHash } from '../src/swap/app.js';
import { PAIR, KIND } from '../src/swap/constants.js';
import {
  buildRefundFieldsForPair,
  getDefaultPairForSettlementKind,
  normalizeRefundPolicyForPair,
} from '../src/swap/pairs.js';

test('rfq taker build: tao RFQ uses --settlement-refund-after-sec value verbatim', () => {
  const { settlementRefundAfterSec } = resolveSettlementRefundAfterSec({
    settlementRefundAfterSecRaw: '3700',
    legacySolanaRefundAfterSecRaw: null,
    fallbackSec: 259200,
    minSec: 3600,
    maxSec: 7 * 24 * 3600,
  });

  const unsigned = buildRfqUnsignedEnvelope({
    tradeId: 'rfq_test_3700',
    pair: PAIR.BTC_LN__TAO_EVM,
    expectedAppHash: deriveIntercomswapAppHash({ solanaProgramId: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653' }),
    btcSats: 50_000,
    amountAtomic: '4200000000',
    maxPlatformFeeBps: 10,
    maxTradeFeeBps: 10,
    maxTotalFeeBps: 20,
    settlementRefundAfterSec,
    minSolRefundWindowSec: 72 * 3600,
    maxSolRefundWindowSec: 7 * 24 * 3600,
    validUntilUnix: Math.floor(Date.now() / 1000) + 60,
  });

  assert.equal(unsigned.kind, KIND.RFQ);
  assert.equal(unsigned.body.settlement_refund_after_sec, 3700);
  assert.equal(unsigned.body.min_sol_refund_window_sec, undefined);
  assert.equal(unsigned.body.max_sol_refund_window_sec, undefined);
});

test('pairs helpers: default pair selection preserves solana default and tao mapping', () => {
  assert.equal(getDefaultPairForSettlementKind(undefined), PAIR.BTC_LN__USDT_SOL);
  assert.equal(getDefaultPairForSettlementKind('solana'), PAIR.BTC_LN__USDT_SOL);
  assert.equal(getDefaultPairForSettlementKind('tao-evm'), PAIR.BTC_LN__TAO_EVM);
});

test('pairs helpers: buildRefundFieldsForPair computes identical refund_after_unix', () => {
  const policy = normalizeRefundPolicyForPair(
    PAIR.BTC_LN__TAO_EVM,
    { settlement_refund_after_sec: 3700 },
    {
      minSec: 3600,
      maxSec: 7 * 24 * 3600,
      defaultQuoteRefundSec: 72 * 3600,
      defaultMinRefundSec: 3600,
      defaultMaxRefundSec: 7 * 24 * 3600,
    }
  );
  assert.deepEqual(buildRefundFieldsForPair(PAIR.BTC_LN__TAO_EVM, policy, 1_700_000_000), {
    sol_refund_after_unix: 1_700_003_700,
  });
});
