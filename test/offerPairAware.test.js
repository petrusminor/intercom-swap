import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ToolExecutor } from '../src/prompt/executor.js';

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

function newExecutor({ settlementKind, lnCli, taoHtlcAddress }) {
  return new ToolExecutor({
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
}

test('offer_post: accepts TAO offer line in tao-evm mode', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-offerpair-'));
  const lnCli = path.join(tmp, 'fake-ln-cli.sh');
  writeFakeLnCli(lnCli);
  const ex = newExecutor({
    settlementKind: 'tao-evm',
    lnCli,
    taoHtlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
  });

  const out = await ex.execute(
    'intercomswap_offer_post',
    {
      channels: ['0000intercomswapbtctao'],
      name: 'maker:tao',
      offers: [
        {
          pair: 'BTC_LN/TAO_EVM',
          have: 'TAO_EVM',
          want: 'BTC_LN',
          btc_sats: 10_000,
          tao_amount_atomic: '4200000000',
          settlement_refund_after_sec: 259200,
          max_platform_fee_bps: 10,
          max_trade_fee_bps: 10,
          max_total_fee_bps: 20,
        },
      ],
    },
    { autoApprove: true, dryRun: true }
  );

  assert.equal(out.type, 'dry_run');
  assert.equal(out.unsigned.body.pairs[0], 'BTC_LN/TAO_EVM');
  assert.equal(out.unsigned.body.offers[0].tao_amount_atomic, '4200000000');
  assert.equal(out.unsigned.body.offers[0].settlement_refund_after_sec, 259200);
  assert.equal(out.unsigned.body.offers[0].settlement_kind, 'tao-evm');
});

test('offer_post: rejects mixed sol/usdt fields on TAO pair', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-offerpair-'));
  const lnCli = path.join(tmp, 'fake-ln-cli.sh');
  writeFakeLnCli(lnCli);
  const ex = newExecutor({
    settlementKind: 'tao-evm',
    lnCli,
    taoHtlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
  });

  await assert.rejects(
    () =>
      ex.execute(
        'intercomswap_offer_post',
        {
          channels: ['0000intercomswapbtctao'],
          name: 'maker:tao',
          offers: [
            {
              pair: 'BTC_LN/TAO_EVM',
              have: 'TAO_EVM',
              want: 'BTC_LN',
              btc_sats: 10_000,
              tao_amount_atomic: '4200000000',
              min_sol_refund_window_sec: 259200,
            },
          ],
        },
        { autoApprove: true, dryRun: true }
      ),
    /min_sol_refund_window_sec\/max_sol_refund_window_sec not allowed/i
  );
});

test('offer_post: rejects TAO fields on USDT pair', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-offerpair-'));
  const lnCli = path.join(tmp, 'fake-ln-cli.sh');
  writeFakeLnCli(lnCli);
  const ex = newExecutor({
    settlementKind: 'solana',
    lnCli,
    taoHtlcAddress: '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653',
  });

  await assert.rejects(
    () =>
      ex.execute(
        'intercomswap_offer_post',
        {
          channels: ['0000intercomswapbtcusdt'],
          name: 'maker:usdt',
          offers: [
            {
              pair: 'BTC_LN/USDT_SOL',
              have: 'USDT_SOL',
              want: 'BTC_LN',
              btc_sats: 10_000,
              usdt_amount: '4200000',
              tao_amount_atomic: '4200000000',
              min_sol_refund_window_sec: 259200,
              max_sol_refund_window_sec: 259200,
            },
          ],
        },
        { autoApprove: true, dryRun: true }
      ),
    /tao_amount_atomic\/settlement_refund_after_sec not allowed/i
  );
});
