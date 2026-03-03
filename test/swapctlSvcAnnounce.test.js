import test from 'node:test';
import assert from 'node:assert/strict';

import { injectMissingOfferAppHashes } from '../scripts/swapctl.mjs';
import { deriveIntercomswapAppHashForBinding } from '../src/swap/app.js';
import { getSettlementBinding, SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID } from '../settlement/providerFactory.js';

test('swapctl svc-announce autofills missing offer app_hash from settlement binding', () => {
  const taoHtlcAddress = '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653';
  const out = injectMissingOfferAppHashes(
    [
      {
        pair: 'BTC_LN/TAO_EVM',
        have: 'TAO_EVM',
        want: 'BTC_LN',
        btc_sats: 10000,
        tao_amount_atomic: '4200000000',
        settlement_refund_after_sec: 259200,
      },
      {
        pair: 'BTC_LN/USDT_SOL',
        have: 'USDT_SOL',
        want: 'BTC_LN',
        btc_sats: 10000,
        usdt_amount: '1000000',
        min_sol_refund_window_sec: 259200,
        max_sol_refund_window_sec: 259200,
      },
    ],
    { taoHtlcAddress }
  );

  assert.equal(
    out[0].app_hash,
    deriveIntercomswapAppHashForBinding(getSettlementBinding('tao-evm', { taoHtlcAddress }))
  );
  assert.equal(
    out[1].app_hash,
    deriveIntercomswapAppHashForBinding(
      getSettlementBinding('solana', { solanaProgramId: SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID })
    )
  );
});
