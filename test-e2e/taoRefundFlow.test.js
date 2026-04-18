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
import { KIND, PAIR, ASSET, STATE } from '../src/swap/constants.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { applySwapEnvelope, createInitialTrade } from '../src/swap/stateMachine.js';

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

if [ -n "\${PHASE9_LN_LOG:-}" ]; then
  printf '{"cmd":"%s","ts":%s}\\n' "$cmd" "$(date +%s)" >> "$PHASE9_LN_LOG"
fi

peer="\${PHASE9_PEER:-}"
preimage="\${PHASE9_PREIMAGE:-}"

if [ "$cmd" = "listfunds" ]; then
  echo '{"outputs":[],"channels":[]}'
  exit 0
fi
if [ "$cmd" = "listpeerchannels" ]; then
  printf '{"channels":[{"state":"CHANNELD_NORMAL","peer_id":"%s","channel_id":"123x1x0","spendable_msat":"900000000msat","receivable_msat":"900000000msat","amount_msat":"1800000000msat"}]}\\n' "$peer"
  exit 0
fi
if [ "$cmd" = "pay" ]; then
  printf '{"payment_preimage":"%s"}\\n' "$preimage"
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

test('e2e: deterministic TAO refund flow emits TAO_REFUNDED and persists receipt', async (t) => {
  const signer = await createSigner();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-phase9-tao-refund-'));
  const lnCliPath = path.join(tempDir, 'fake-lightning-cli.sh');
  const lnLogPath = path.join(tempDir, 'fake-ln-calls.log');
  const receiptsDbPath = path.join(tempDir, 'receipts.sqlite');

  writeFakeLnCli({ filePath: lnCliPath });

  const prevLnLog = process.env.PHASE9_LN_LOG;
  const prevPreimage = process.env.PHASE9_PREIMAGE;
  const prevPeer = process.env.PHASE9_PEER;

  const preimageHex = '22'.repeat(32);
  const paymentHashHex = '33'.repeat(32);

  process.env.PHASE9_LN_LOG = lnLogPath;
  process.env.PHASE9_PREIMAGE = preimageHex;
  process.env.PHASE9_PEER = signer.pubHex;

  t.after(() => {
    if (prevLnLog === undefined) delete process.env.PHASE9_LN_LOG;
    else process.env.PHASE9_LN_LOG = prevLnLog;
    if (prevPreimage === undefined) delete process.env.PHASE9_PREIMAGE;
    else process.env.PHASE9_PREIMAGE = prevPreimage;
    if (prevPeer === undefined) delete process.env.PHASE9_PEER;
    else process.env.PHASE9_PEER = prevPeer;
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
  const mint = '0x1111111111111111111111111111111111111111';
  const recipient = '0x2222222222222222222222222222222222222222';
  const refund = '0x3333333333333333333333333333333333333333';
  const tradeFeeCollector = '0x4444444444444444444444444444444444444444';

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

  const mockSettlementId = `0x${'ac'.repeat(32)}`;
  const mockLockTxId = `0x${'bd'.repeat(32)}`;
  const mockRefundTxId = `0x${'ce'.repeat(32)}`;
  const settlementCalls = [];
  const mockSettlementProvider = {
    async lock(input) {
      settlementCalls.push({ op: 'lock', input });
      return {
        settlementId: mockSettlementId,
        txId: mockLockTxId,
        metadata: {
          settlement_id: mockSettlementId,
          tx_id: mockLockTxId,
          contract_address: htlcAddress,
          amount_atomic: String(input.amountAtomic),
          refund_after_unix: Number(input.refundAfterUnix),
          receiver: String(input.recipient),
          sender: String(input.refundAddress),
        },
      };
    },
    async verifySwapPrePayOnchain(input) {
      settlementCalls.push({ op: 'verify', input });
      return { ok: true, error: null, onchain: { state: { settlementId: input?.escrowBody?.settlement_id || '' } } };
    },
    async claim(input) {
      settlementCalls.push({ op: 'claim', input });
      return { txId: `0x${'ff'.repeat(32)}` };
    },
    async refund(input) {
      settlementCalls.push({ op: 'refund', input });
      return { txId: mockRefundTxId };
    },
    async waitForConfirmation(txId) {
      settlementCalls.push({ op: 'wait', txId });
    },
  };
  executor._getSettlementProvider = function getSettlementProviderMock() {
    return mockSettlementProvider;
  };

  const nowUnix = Math.floor(Date.now() / 1000);
  const refundAfterUnix = nowUnix + 7200;
  const tradeId = 'phase9-tao-refund-trade';
  const channel = 'swap:phase9-tao-refund-trade';
  const btcSats = 1200;
  const usdtAmount = '5000000000000000';
  const appHash = executor._settlementAppHash();
  const bolt11 = 'lnbcrt1phase9refunddeterministicinvoice0000000000001';

  const quoteUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId,
    body: {
      rfq_id: 'b'.repeat(64),
      pair: PAIR.BTC_LN__TAO_EVM,
      direction: `${ASSET.BTC_LN}->${ASSET.TAO_EVM}`,
      app_hash: appHash,
      btc_sats: btcSats,
      tao_amount_atomic: usdtAmount,
      platform_fee_bps: 0,
      trade_fee_bps: 0,
      trade_fee_collector: tradeFeeCollector,
      settlement_refund_after_sec: 7200,
      valid_until_unix: nowUnix + 3600,
    },
  });
  const quoteEnvelope = signEnvelope(quoteUnsigned, signer);

  const quoteAcceptRes = await executor.execute(
    'intercomswap_quote_accept',
    {
      channel,
      quote_envelope: quoteEnvelope,
    },
    { autoApprove: true }
  );
  assert.equal(quoteAcceptRes.type, 'quote_accept_posted');

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__TAO_EVM,
      direction: `${ASSET.BTC_LN}->${ASSET.TAO_EVM}`,
      app_hash: appHash,
      btc_sats: btcSats,
      tao_amount_atomic: usdtAmount,
      usdt_decimals: 9,
      sol_mint: mint,
      sol_recipient: recipient,
      sol_refund: refund,
      sol_refund_after_unix: refundAfterUnix,
      ln_receiver_peer: signer.pubHex,
      ln_payer_peer: signer.pubHex,
      platform_fee_bps: 0,
      trade_fee_bps: 0,
      trade_fee_collector: tradeFeeCollector,
      terms_valid_until_unix: nowUnix + 3600,
    },
  });
  const termsEnvelope = signEnvelope(termsUnsigned, signer);

  const acceptEnvelope = signEnvelope(
    createUnsignedEnvelope({
      v: 1,
      kind: KIND.ACCEPT,
      tradeId,
      body: {
        terms_hash: hashUnsignedEnvelope(termsUnsigned),
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
        bolt11,
        payment_hash_hex: paymentHashHex,
        amount_msat: String(BigInt(btcSats) * 1000n),
        expires_at_unix: nowUnix + 3600,
      },
    }),
    signer
  );

  executor._scLogAppend({
    type: 'sidechannel_message',
    channel,
    ts: Date.now(),
    message: termsEnvelope,
  });
  executor._scLogAppend({
    type: 'sidechannel_message',
    channel,
    ts: Date.now(),
    message: invoiceEnvelope,
  });
  executor._scLogAppend({
    type: 'sidechannel_message',
    channel,
    ts: Date.now(),
    message: {
      kind: KIND.STATUS,
      trade_id: tradeId,
      signer: signer.pubHex,
      body: {
        state: 'accepted',
        note: 'ln_route_precheck_ok deterministic',
      },
    },
  });

  const escrowRes = await executor.execute(
    'intercomswap_swap_sol_escrow_init_and_post',
    {
      channel,
      trade_id: tradeId,
      payment_hash_hex: paymentHashHex,
      mint,
      amount: usdtAmount,
      recipient,
      refund,
      refund_after_unix: refundAfterUnix,
      trade_fee_collector: tradeFeeCollector,
    },
    { autoApprove: true }
  );
  assert.equal(escrowRes.type, 'tao_htlc_locked_posted');
  assert.equal(escrowRes.envelope.kind, KIND.TAO_HTLC_LOCKED);

  const verifyRes = await executor.execute(
    'intercomswap_swap_verify_pre_pay',
    {
      terms_envelope: termsEnvelope,
      invoice_envelope: invoiceEnvelope,
      escrow_envelope: escrowRes.envelope,
    },
    { autoApprove: true }
  );
  assert.equal(verifyRes.ok, true);
  assert.equal(countLnPayCalls(lnLogPath), 0);

  const refundRes = await executor.execute(
    'intercomswap_swap_sol_refund_and_post',
    {
      channel,
      trade_id: tradeId,
      payment_hash_hex: paymentHashHex,
      mint,
    },
    { autoApprove: true }
  );
  assert.equal(refundRes.type, 'tao_refunded_posted');
  assert.equal(refundRes.envelope.kind, KIND.TAO_REFUNDED);
  assert.equal(refundRes.envelope.body.settlement_id, mockSettlementId);
  assert.equal(refundRes.envelope.body.tx_id, mockRefundTxId);
  assert.equal(countLnPayCalls(lnLogPath), 0);

  const callOps = settlementCalls.map((row) => row.op);
  assert.ok(callOps.includes('verify'), 'verify call missing');
  assert.ok(callOps.includes('refund'), 'refund call missing');
  assert.ok(!callOps.includes('claim'), 'claim should not be called on refund flow');

  const { sig: _refundSig, signer: _refundSigner, ...refundUnsigned } = refundRes.envelope;
  const refundedEnvelopeForStateMachine = signEnvelope(
    {
      ...refundUnsigned,
      ts: (refundAfterUnix + 1) * 1000,
    },
    signer
  );

  let trade = createInitialTrade(tradeId);
  for (const envelope of [termsEnvelope, acceptEnvelope, invoiceEnvelope, escrowRes.envelope, refundedEnvelopeForStateMachine]) {
    const step = applySwapEnvelope(trade, envelope);
    assert.equal(step.ok, true, step.error || 'state machine failed');
    trade = step.trade;
  }
  assert.equal(trade.state, STATE.REFUNDED);

  const store = TradeReceiptsStore.open({ dbPath: receiptsDbPath });
  try {
    const receipt = store.getTrade(tradeId);
    assert.ok(receipt, 'receipt missing');
    assert.equal(receipt.state, 'refunded');
    assert.equal(receipt.settlement_kind, 'tao-evm');
    assert.equal(receipt.tao_settlement_id, mockSettlementId);
    assert.equal(receipt.tao_refund_tx_id, mockRefundTxId);
  } finally {
    store.close();
  }
});
