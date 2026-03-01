import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import b4a from 'b4a';
import PeerWallet from 'trac-wallet';

import { ToolExecutor } from '../src/prompt/executor.js';
import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { TradeReceiptsStore } from '../src/receipts/store.js';
import {
  attachSignature,
  createUnsignedEnvelope,
  signUnsignedEnvelopeHex,
} from '../src/protocol/signedMessage.js';
import { KIND, PAIR, ASSET } from '../src/swap/constants.js';

function signEnvelope(unsignedEnvelope, signer) {
  const sigHex = signUnsignedEnvelopeHex(unsignedEnvelope, signer.secHex);
  return attachSignature(unsignedEnvelope, {
    signerPubKeyHex: signer.pubHex,
    sigHex,
  });
}

async function createSigner() {
  const wallet = new PeerWallet();
  await wallet.ready;
  await wallet.generateKeyPair();
  return {
    pubHex: b4a.toString(wallet.publicKey, 'hex'),
    secHex: b4a.toString(wallet.secretKey, 'hex'),
  };
}

function writeFakeLnCli({ filePath }) {
  const src = `#!/usr/bin/env bash
set -euo pipefail

cmd=""
for a in "$@"; do
  case "$a" in
    --*) ;;
    *) cmd="$a"; break ;;
  esac
done

if [ -n "\${PHASE11_TIMELOCK_FAIL_LN_LOG:-}" ]; then
  printf '{"cmd":"%s","ts":%s}\\n' "$cmd" "$(date +%s)" >> "$PHASE11_TIMELOCK_FAIL_LN_LOG"
fi

if [ "$cmd" = "pay" ]; then
  echo '{"payment_preimage":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
  exit 0
fi

echo '{}'
`;
  fs.writeFileSync(filePath, src, { mode: 0o755 });
}

function countLnPayCalls(logPath) {
  if (!fs.existsSync(logPath)) return 0;
  const lines = String(fs.readFileSync(logPath, 'utf8') || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  let n = 0;
  for (const line of lines) {
    let row = null;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      row = null;
    }
    if (row && row.cmd === 'pay') n += 1;
  }
  return n;
}

test('e2e: TAO timelock-too-short fails verify gate before LN pay', async (t) => {
  const signer = await createSigner();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-phase11-tao-timelock-fail-'));
  const lnCliPath = path.join(tempDir, 'fake-lightning-cli.sh');
  const lnLogPath = path.join(tempDir, 'fake-ln-calls.log');
  const receiptsDbPath = path.join(tempDir, 'receipts.sqlite');

  writeFakeLnCli({ filePath: lnCliPath });

  const prevLnLog = process.env.PHASE11_TIMELOCK_FAIL_LN_LOG;
  process.env.PHASE11_TIMELOCK_FAIL_LN_LOG = lnLogPath;

  t.after(() => {
    if (prevLnLog === undefined) delete process.env.PHASE11_TIMELOCK_FAIL_LN_LOG;
    else process.env.PHASE11_TIMELOCK_FAIL_LN_LOG = prevLnLog;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_e) {}
  });

  const proto = ScBridgeClient.prototype;
  const scOrig = {
    connect: proto.connect,
    close: proto.close,
    send: proto.send,
    subscribe: proto.subscribe,
    stats: proto.stats,
  };

  proto.connect = async function connectMock() {
    this.ws = { readyState: 1, close() {} };
    this.hello = { peer: signer.pubHex, requiresAuth: false };
  };
  proto.close = function closeMock() {
    this.ws = null;
  };
  proto.send = async function sendMock() {
    return { type: 'ok', id: `fake-${Date.now()}` };
  };
  proto.subscribe = async function subscribeMock() {
    return { type: 'ok' };
  };
  proto.stats = async function statsMock() {
    return { channels: [] };
  };

  t.after(() => {
    proto.connect = scOrig.connect;
    proto.close = scOrig.close;
    proto.send = scOrig.send;
    proto.subscribe = scOrig.subscribe;
    proto.stats = scOrig.stats;
  });

  const htlcAddress = '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653';
  const tradeId = 'phase11-tao-timelock-fail-trade';
  const channel = 'swap:phase11-tao-timelock-fail-trade';
  const paymentHashHex = '44'.repeat(32);
  const settlementId = `0x${'ad'.repeat(32)}`;
  const executor = new ToolExecutor({
    scBridge: { url: 'ws://offline.invalid', token: '' },
    peer: { keypairPath: '' },
    ln: {
      impl: 'cln',
      backend: 'cli',
      network: 'regtest',
      cliBin: lnCliPath,
    },
    solana: {
      rpcUrls: 'http://127.0.0.1:8899',
      commitment: 'confirmed',
      programId: '11111111111111111111111111111111',
    },
    receipts: { dbPath: 'onchain/receipts/unused.sqlite' },
    settlementKind: 'tao-evm',
    taoEvm: { htlcAddress },
  });

  executor._requirePeerSigning = async function requirePeerSigningMock() {
    return signer;
  };
  executor._openReceiptsStore = async function openReceiptsStoreMock() {
    return TradeReceiptsStore.open({ dbPath: receiptsDbPath });
  };

  let claimCalls = 0;
  executor._getSettlementProvider = function getSettlementProviderMock() {
    return {
      async verifySwapPrePayOnchain() {
        return {
          ok: true,
          error: null,
          onchain: {
            state: {
              settlementId,
            },
          },
        };
      },
      async claim() {
        claimCalls += 1;
        return { txId: `0x${'ff'.repeat(32)}` };
      },
    };
  };

  const store = TradeReceiptsStore.open({ dbPath: receiptsDbPath });
  try {
    store.upsertTrade(tradeId, {
      state: 'escrow',
      settlement_kind: 'tao-evm',
      ln_payment_hash_hex: paymentHashHex,
      tao_settlement_id: settlementId,
    });
  } finally {
    store.close();
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const appHash = executor._settlementAppHash();
  const termsEnvelope = signEnvelope(
    createUnsignedEnvelope({
      v: 1,
      kind: KIND.TERMS,
      tradeId,
      body: {
        pair: PAIR.BTC_LN__TAO_EVM,
        direction: `${ASSET.BTC_LN}->${ASSET.TAO_EVM}`,
        app_hash: appHash,
        btc_sats: 1000,
        tao_amount_atomic: '5000000',
        sol_mint: '0x1111111111111111111111111111111111111111',
        sol_recipient: '0x2222222222222222222222222222222222222222',
        sol_refund: '0x3333333333333333333333333333333333333333',
        sol_refund_after_unix: nowUnix + 7200,
        ln_receiver_peer: signer.pubHex,
        ln_payer_peer: signer.pubHex,
        platform_fee_bps: 0,
        trade_fee_bps: 0,
        trade_fee_collector: '0x4444444444444444444444444444444444444444',
        terms_valid_until_unix: nowUnix + 3600,
      },
    }),
    signer
  );

  const invoiceEnvelope = signEnvelope(
    createUnsignedEnvelope({
      v: 1,
      kind: KIND.LN_INVOICE,
      tradeId,
      body: {
        bolt11: 'lnbcrt1phase11timelockfailinvoice0000000001',
        payment_hash_hex: paymentHashHex,
        amount_msat: '1000000',
        expires_at_unix: nowUnix + 3600,
      },
    }),
    signer
  );

  const escrowEnvelope = signEnvelope(
    createUnsignedEnvelope({
      v: 1,
      kind: KIND.TAO_HTLC_LOCKED,
      tradeId,
      body: {
        payment_hash_hex: paymentHashHex,
        settlement_id: settlementId,
        htlc_address: htlcAddress,
        amount_atomic: '5000000',
        refund_after_unix: nowUnix + 120,
        recipient: '0x2222222222222222222222222222222222222222',
        refund: '0x3333333333333333333333333333333333333333',
        tx_id: `0x${'be'.repeat(32)}`,
      },
    }),
    signer
  );

  let err = null;
  try {
    await executor.execute(
      'intercomswap_swap_ln_pay_and_post_verified',
      {
        channel,
        terms_envelope: termsEnvelope,
        invoice_envelope: invoiceEnvelope,
        escrow_envelope: escrowEnvelope,
      },
      { autoApprove: true }
    );
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected timelock safety failure');
  assert.match(String(err?.message || ''), /pre-pay verification failed/i);
  assert.match(String(err?.message || ''), /refund_after_unix too soon for safe pay/i);

  assert.equal(countLnPayCalls(lnLogPath), 0, 'LN pay must never be called');
  assert.equal(claimCalls, 0, 'claim must never be called');
  assert.equal(
    executor._scLog.some((evt) => evt?.message?.kind === KIND.TAO_CLAIMED),
    false,
    'TAO_CLAIMED must not be emitted'
  );

  const storeAfter = TradeReceiptsStore.open({ dbPath: receiptsDbPath });
  try {
    const receipt = storeAfter.getTrade(tradeId);
    assert.ok(receipt, 'receipt should still exist');
    assert.notEqual(receipt.state, 'claimed', 'receipt must not be marked claimed');
    assert.equal(receipt.tao_claim_tx_id, null);
  } finally {
    storeAfter.close();
  }
});
