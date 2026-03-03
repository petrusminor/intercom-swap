import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ToolExecutor } from '../src/prompt/executor.js';
import { matchOfferAnnouncementEvent } from '../src/rfq/offerMatch.js';
import { deriveIntercomswapAppHashForBinding } from '../src/swap/app.js';
import { normalizeSettlementFeeCapsBps, computeSettlementAmountWithFeeCeil } from '../src/swap/fees.js';
import { getSettlementBinding } from '../settlement/providerFactory.js';

function writeFakeLnCli(filePath) {
  const src = `#!/usr/bin/env bash
set -euo pipefail
cmd=""
for a in "$@"; do
  case "$a" in
    --*) ;;
    *) cmd="$a"; break ;;
  esac
done
if [ "$cmd" = "listfunds" ]; then
  echo '{"outputs":[],"channels":[]}'
  exit 0
fi
if [ "$cmd" = "listpeerchannels" ]; then
  echo '{"channels":[{"state":"CHANNELD_NORMAL","peer_id":"02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","channel_id":"123x1x0","spendable_msat":"900000000msat","receivable_msat":"900000000msat","amount_msat":"1800000000msat"}]}'
  exit 0
fi
echo '{}'
`;
  fs.writeFileSync(filePath, src, { mode: 0o755 });
}

function newExecutor({ settlementKind, taoHtlcAddress }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-fees-'));
  const lnCli = path.join(tmp, 'fake-ln-cli.sh');
  writeFakeLnCli(lnCli);
  const ex = new ToolExecutor({
    scBridge: { url: 'ws://127.0.0.1:1', token: 'x' },
    peer: { keypairPath: '' },
    ln: { impl: 'cln', backend: 'cli', network: 'regtest', cliBin: lnCli },
    solana: {
      rpcUrls: 'http://127.0.0.1:8899',
      commitment: 'confirmed',
      programId: '11111111111111111111111111111111',
      usdtMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
    settlementKind,
    taoEvm: {
      htlcAddress: taoHtlcAddress,
    },
  });
  ex._getSettlementProvider = () => ({
    feeSnapshot: async ({ tradeFeeCollector }) => ({
      platformFeeBps: 10,
      platformFeeCollector:
        settlementKind === 'tao-evm'
          ? '0x1111111111111111111111111111111111111111'
          : '11111111111111111111111111111111',
      tradeFeeBps: 10,
      tradeFeeCollector,
    }),
  });
  ex._inspectListingState = async () => ({
    terminal: false,
    active: false,
    has_quote_accept: false,
    has_swap_invite: false,
    swap_channel: null,
    state: null,
  });
  ex._openReceiptsStore = async () => null;
  ex._findRfqEnvelopeById = () => null;
  return ex;
}

function makeOfferEvent({ pair, amountField, amountAtomic, appHash, maxPlatform = 10, maxTrade = 10, maxTotal = 20 }) {
  return {
    type: 'sidechannel_message',
    channel: '0000intercomswap',
    message: {
      v: 1,
      kind: 'swap.svc_announce',
      trade_id: 'svc:test',
      ts: Date.now(),
      nonce: 'nonce-1',
      signer: 'a'.repeat(64),
      sig: 'b'.repeat(128),
      body: {
        name: 'maker:test',
        rfq_channels: ['0000intercomswap'],
        app_hash: appHash,
        valid_until_unix: Math.floor(Date.now() / 1000) + 3600,
        offers: [
          {
            pair,
            have: pair === 'BTC_LN/TAO_EVM' ? 'TAO_EVM' : 'USDT_SOL',
            want: 'BTC_LN',
            btc_sats: 10000,
            [amountField]: amountAtomic,
            max_platform_fee_bps: maxPlatform,
            max_trade_fee_bps: maxTrade,
            max_total_fee_bps: maxTotal,
            ...(pair === 'BTC_LN/TAO_EVM'
              ? { settlement_refund_after_sec: 259200, settlement_kind: 'tao-evm' }
              : { min_sol_refund_window_sec: 259200, max_sol_refund_window_sec: 259200, settlement_kind: 'solana' }),
          },
        ],
      },
    },
  };
}

test('fee semantics: settlement amount fee ceil preserves current atomic rounding behavior', () => {
  assert.equal(computeSettlementAmountWithFeeCeil('1000000', 20).toString(), '1002000');
  assert.equal(computeSettlementAmountWithFeeCeil('1', 1).toString(), '2');
});

test('fee semantics: normalized settlement fee caps preserve existing bps values', () => {
  assert.deepEqual(
    normalizeSettlementFeeCapsBps(
      {
        max_platform_fee_bps: 10,
        max_trade_fee_bps: 10,
        max_total_fee_bps: 20,
      },
      {
        defaultPlatformFeeBps: 10,
        defaultTradeFeeBps: 10,
        defaultTotalFeeBps: 20,
      }
    ),
    {
      settlementLegMaxPlatformFeeBps: 10,
      settlementLegMaxTradeFeeBps: 10,
      settlementLegMaxTotalFeeBps: 20,
    }
  );
});

test('quote_post dry-run: SOL and TAO emit identical settlement fee bps for identical fee snapshots', async () => {
  const sol = newExecutor({
    settlementKind: 'solana',
    taoHtlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
  });
  const tao = newExecutor({
    settlementKind: 'tao-evm',
    taoHtlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
  });

  const solOut = await sol.execute(
    'intercomswap_quote_post',
    {
      channel: '0000intercomswapbtcusdt',
      trade_id: 'trade-sol-fees',
      rfq_id: 'a'.repeat(64),
      pair: 'BTC_LN/USDT_SOL',
      btc_sats: 10000,
      usdt_amount: '1000000',
      trade_fee_collector: '11111111111111111111111111111111',
      sol_refund_window_sec: 259200,
      valid_for_sec: 600,
    },
    { autoApprove: true, dryRun: true }
  );

  const taoOut = await tao.execute(
    'intercomswap_quote_post',
    {
      channel: '0000intercomswapbtctao',
      trade_id: 'trade-tao-fees',
      rfq_id: 'b'.repeat(64),
      pair: 'BTC_LN/TAO_EVM',
      btc_sats: 10000,
      tao_amount_atomic: '1000000',
      trade_fee_collector: '0x2222222222222222222222222222222222222222',
      settlement_refund_after_sec: 259200,
      valid_for_sec: 600,
    },
    { autoApprove: true, dryRun: true }
  );

  assert.equal(solOut.unsigned.body.platform_fee_bps, 10);
  assert.equal(solOut.unsigned.body.trade_fee_bps, 10);
  assert.equal(taoOut.unsigned.body.platform_fee_bps, 10);
  assert.equal(taoOut.unsigned.body.trade_fee_bps, 10);
});

test('offer matching: settlement fee caps apply consistently across SOL and TAO offers', () => {
  const solAppHash = deriveIntercomswapAppHashForBinding(
    getSettlementBinding('solana', { solanaProgramId: '11111111111111111111111111111111' })
  );
  const taoAppHash = deriveIntercomswapAppHashForBinding(
    getSettlementBinding('tao-evm', { taoHtlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653' })
  );

  const solEvt = makeOfferEvent({
    pair: 'BTC_LN/USDT_SOL',
    amountField: 'usdt_amount',
    amountAtomic: '1000000',
    appHash: solAppHash,
  });
  const taoEvt = makeOfferEvent({
    pair: 'BTC_LN/TAO_EVM',
    amountField: 'tao_amount_atomic',
    amountAtomic: '1000000',
    appHash: taoAppHash,
  });

  const solMatched = matchOfferAnnouncementEvent(solEvt, {
    rfqChannel: '0000intercomswap',
    expectedProgramId: '11111111111111111111111111111111',
    maxPlatformFeeBps: 10,
    maxTradeFeeBps: 10,
    maxTotalFeeBps: 20,
    minRefundSec: 259200,
    maxRefundSec: 259200,
    nowUnix: Math.floor(Date.now() / 1000),
  });
  const taoMatched = matchOfferAnnouncementEvent(taoEvt, {
    rfqChannel: '0000intercomswap',
    taoHtlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
    maxPlatformFeeBps: 10,
    maxTradeFeeBps: 10,
    maxTotalFeeBps: 20,
    minSettlementRefundSec: 259200,
    maxRefundSec: 259200,
    nowUnix: Math.floor(Date.now() / 1000),
  });

  assert.equal(solMatched.max_platform_fee_bps, 10);
  assert.equal(solMatched.max_trade_fee_bps, 10);
  assert.equal(solMatched.max_total_fee_bps, 20);
  assert.equal(taoMatched.max_platform_fee_bps, 10);
  assert.equal(taoMatched.max_trade_fee_bps, 10);
  assert.equal(taoMatched.max_total_fee_bps, 20);

  const solRejected = matchOfferAnnouncementEvent(solEvt, {
    rfqChannel: '0000intercomswap',
    expectedProgramId: '11111111111111111111111111111111',
    maxPlatformFeeBps: 9,
    maxTradeFeeBps: 10,
    maxTotalFeeBps: 20,
    minRefundSec: 259200,
    maxRefundSec: 259200,
    nowUnix: Math.floor(Date.now() / 1000),
  });
  const taoRejected = matchOfferAnnouncementEvent(taoEvt, {
    rfqChannel: '0000intercomswap',
    taoHtlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
    maxPlatformFeeBps: 9,
    maxTradeFeeBps: 10,
    maxTotalFeeBps: 20,
    minSettlementRefundSec: 259200,
    maxRefundSec: 259200,
    nowUnix: Math.floor(Date.now() / 1000),
  });

  assert.equal(solRejected, null);
  assert.equal(taoRejected, null);
});
