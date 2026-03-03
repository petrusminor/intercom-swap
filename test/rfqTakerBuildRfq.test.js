import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRfqUnsignedEnvelope } from '../src/rfq/buildRfq.js';
import { resolveSettlementRefundAfterSec } from '../src/rfq/cliFlags.js';
import { deriveIntercomswapAppHash } from '../src/swap/app.js';
import { PAIR, KIND } from '../src/swap/constants.js';

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
