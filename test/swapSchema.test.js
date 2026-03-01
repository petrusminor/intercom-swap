import test from 'node:test';
import assert from 'node:assert/strict';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';

import { createUnsignedEnvelope, encodeEnvelopeForSigning, attachSignature } from '../src/protocol/signedMessage.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { deriveIntercomswapAppHash } from '../src/swap/app.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { ASSET, KIND, PAIR } from '../src/swap/constants.js';
import { resolveRfqSettlementAmountAtomic, resolveSettlementRefundAfterSec } from '../src/rfq/cliFlags.js';
import { SETTLEMENT_KIND } from '../settlement/providerFactory.js';

const APP_HASH = deriveIntercomswapAppHash({ solanaProgramId: '11111111111111111111111111111111' });

async function newWallet() {
  const w = new PeerWallet();
  await w.ready;
  await w.generateKeyPair();
  return w;
}

function signEnvelope(wallet, unsigned) {
  const msg = encodeEnvelopeForSigning(unsigned);
  const sigBuf = wallet.sign(b4a.from(msg, 'utf8'));
  return attachSignature(unsigned, {
    signerPubKeyHex: b4a.toString(wallet.publicKey, 'hex'),
    sigHex: b4a.toString(sigBuf, 'hex'),
  });
}

test('swap schema: terms + accept validate', async () => {
  const receiver = await newWallet();
  const payer = await newWallet();

  const tradeId = 'swap_test_schema_1';
  const nowSec = Math.floor(Date.now() / 1000);

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      app_hash: APP_HASH,
      btc_sats: 12345,
      usdt_amount: '1000000',
      usdt_decimals: 6,
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: nowSec + 3600,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
      terms_valid_until_unix: nowSec + 300,
    },
    ts: Date.now(),
    nonce: 'n1',
  });
  const terms = signEnvelope(receiver, termsUnsigned);
  assert.equal(validateSwapEnvelope(terms).ok, true);

  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
    ts: Date.now(),
    nonce: 'n2',
  });
  const accept = signEnvelope(payer, acceptUnsigned);
  assert.equal(validateSwapEnvelope(accept).ok, true);
});

test('swap schema: rfq + quote validate', async () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const rfq = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId: 'rfq_1',
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      app_hash: APP_HASH,
      btc_sats: 1000,
      usdt_amount: '1000000',
      max_platform_fee_bps: 500,
      max_trade_fee_bps: 1000,
      max_total_fee_bps: 1500,
      valid_until_unix: nowSec + 60,
    },
    ts: Date.now(),
    nonce: 'r1',
  });
  assert.equal(validateSwapEnvelope(rfq).ok, true);
  const rfqId = hashUnsignedEnvelope(rfq);

  const quote = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId: 'quote_1',
    body: {
      rfq_id: rfqId,
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      app_hash: APP_HASH,
      btc_sats: 1000,
      usdt_amount: '1000000',
      offer_id: 'a'.repeat(64),
      offer_line_index: 0,
      platform_fee_bps: 50,
      trade_fee_bps: 50,
      trade_fee_collector: '11111111111111111111111111111111',
      valid_until_unix: nowSec + 30,
    },
    ts: Date.now(),
    nonce: 'q1',
  });
  assert.equal(validateSwapEnvelope(quote).ok, true);

  const quoteMissingExpiry = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId: 'quote_2',
    body: {
      rfq_id: rfqId,
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      app_hash: APP_HASH,
      btc_sats: 1000,
      usdt_amount: '1000000',
    },
    ts: Date.now(),
    nonce: 'q2',
  });
  assert.equal(validateSwapEnvelope(quoteMissingExpiry).ok, false);

  const quoteMissingOfferLine = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId: 'quote_3',
    body: {
      rfq_id: rfqId,
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      app_hash: APP_HASH,
      btc_sats: 1000,
      usdt_amount: '1000000',
      offer_id: 'b'.repeat(64),
      valid_until_unix: nowSec + 30,
    },
    ts: Date.now(),
    nonce: 'q3',
  });
  assert.equal(validateSwapEnvelope(quoteMissingOfferLine).ok, false);
});

test('swap schema: TAO rfq + quote + terms validate', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const receiver = await newWallet();
  const payer = await newWallet();

  const rfq = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId: 'rfq_tao_1',
    body: {
      pair: PAIR.BTC_LN__TAO_EVM,
      direction: 'BTC_LN->TAO_EVM',
      app_hash: APP_HASH,
      btc_sats: 1000,
      tao_amount_atomic: '4200000000',
      settlement_refund_after_sec: 259200,
      valid_until_unix: nowSec + 60,
    },
    ts: Date.now(),
    nonce: 'rt1',
  });
  assert.equal(validateSwapEnvelope(rfq).ok, true);
  const rfqId = hashUnsignedEnvelope(rfq);

  const quote = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId: 'quote_tao_1',
    body: {
      rfq_id: rfqId,
      pair: PAIR.BTC_LN__TAO_EVM,
      direction: 'BTC_LN->TAO_EVM',
      app_hash: APP_HASH,
      btc_sats: 1000,
      tao_amount_atomic: '4200000000',
      settlement_refund_after_sec: 259200,
      trade_fee_collector: '0x1111111111111111111111111111111111111111',
      valid_until_unix: nowSec + 30,
    },
    ts: Date.now(),
    nonce: 'qt1',
  });
  assert.equal(validateSwapEnvelope(quote).ok, true);

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId: 'terms_tao_1',
    body: {
      pair: PAIR.BTC_LN__TAO_EVM,
      direction: 'BTC_LN->TAO_EVM',
      app_hash: APP_HASH,
      btc_sats: 1000,
      tao_amount_atomic: '4200000000',
      settlement_kind: 'tao-evm',
      sol_mint: '0x1111111111111111111111111111111111111111',
      sol_recipient: '0x2222222222222222222222222222222222222222',
      sol_refund: '0x3333333333333333333333333333333333333333',
      sol_refund_after_unix: nowSec + 259200,
      platform_fee_bps: 0,
      trade_fee_bps: 0,
      trade_fee_collector: '0x1111111111111111111111111111111111111111',
      ln_receiver_peer: b4a.toString(receiver.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(payer.publicKey, 'hex'),
      terms_valid_until_unix: nowSec + 300,
    },
    ts: Date.now(),
    nonce: 'tt1',
  });
  assert.equal(validateSwapEnvelope(signEnvelope(receiver, termsUnsigned)).ok, true);
});

test('swap schema: TAO pair rejects usdt_amount', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const rfq = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId: 'rfq_tao_bad_1',
    body: {
      pair: PAIR.BTC_LN__TAO_EVM,
      direction: 'BTC_LN->TAO_EVM',
      app_hash: APP_HASH,
      btc_sats: 1000,
      usdt_amount: '1000000',
      valid_until_unix: nowSec + 60,
    },
    ts: Date.now(),
    nonce: 'rb1',
  });
  assert.equal(validateSwapEnvelope(rfq).ok, false);
});

test('swap schema: quote_accept + swap_invite validate', async () => {
  const maker = await newWallet();
  const taker = await newWallet();

  const tradeId = 'swap_test_rfq_1';
  const nowSec = Math.floor(Date.now() / 1000);

  const rfq = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      app_hash: APP_HASH,
      btc_sats: 1000,
      usdt_amount: '1000000',
      valid_until_unix: nowSec + 60,
    },
    ts: Date.now(),
    nonce: 'r1',
  });
  const rfqId = hashUnsignedEnvelope(rfq);

  const quoteUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId,
    body: {
      rfq_id: rfqId,
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      app_hash: APP_HASH,
      btc_sats: 1000,
      usdt_amount: '1000000',
      valid_until_unix: nowSec + 30,
    },
    ts: Date.now(),
    nonce: 'q1',
  });
  const quote = signEnvelope(maker, quoteUnsigned);
  assert.equal(validateSwapEnvelope(quote).ok, true);

  const quoteId = hashUnsignedEnvelope(quoteUnsigned);
  const quoteAcceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE_ACCEPT,
    tradeId,
    body: {
      rfq_id: rfqId,
      quote_id: quoteId,
    },
    ts: Date.now(),
    nonce: 'qa1',
  });
  const quoteAccept = signEnvelope(taker, quoteAcceptUnsigned);
  assert.equal(validateSwapEnvelope(quoteAccept).ok, true);

  const swapInviteUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SWAP_INVITE,
    tradeId,
    body: {
      rfq_id: rfqId,
      quote_id: quoteId,
      swap_channel: 'swap:abc123',
      owner_pubkey: b4a.toString(maker.publicKey, 'hex'),
      invite_b64: 'dGVzdA==',
    },
    ts: Date.now(),
    nonce: 'si1',
  });
  const swapInvite = signEnvelope(maker, swapInviteUnsigned);
  assert.equal(validateSwapEnvelope(swapInvite).ok, true);
});

test('swap schema: svc_announce validates minimal + extended fields', async () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const ok = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SVC_ANNOUNCE,
    tradeId: 'svc_test_1',
    body: {
      name: 'swap-maker',
      pairs: [PAIR.BTC_LN__USDT_SOL],
      rfq_channels: ['0000intercomswapbtcusdt'],
      note: 'e2e note',
      offers: [{ have: ASSET.USDT_SOL, want: ASSET.BTC_LN, pair: PAIR.BTC_LN__USDT_SOL }],
      valid_until_unix: nowSec + 60,
    },
    ts: Date.now(),
    nonce: 'svc1',
  });
  assert.equal(validateSwapEnvelope(ok).ok, true);

  const badOffers = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SVC_ANNOUNCE,
    tradeId: 'svc_test_2',
    body: {
      name: 'swap-maker',
      offers: 'nope',
    },
    ts: Date.now(),
    nonce: 'svc2',
  });
  assert.equal(validateSwapEnvelope(badOffers).ok, false);
});

test('rfq flags: tao mode accepts --usdt-amount as deprecated alias with warning', () => {
  const resolved = resolveRfqSettlementAmountAtomic({
    settlementKind: SETTLEMENT_KIND.TAO_EVM,
    usdtAmountRaw: '12345',
    taoAmountAtomicRaw: '',
    fallbackUsdtAmount: '100000000',
  });
  assert.equal(resolved.amountAtomic, '12345');
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /deprecated/i);
});

test('rfq flags: tao mode prefers --tao-amount-atomic', () => {
  const resolved = resolveRfqSettlementAmountAtomic({
    settlementKind: SETTLEMENT_KIND.TAO_EVM,
    usdtAmountRaw: '',
    taoAmountAtomicRaw: '777',
    fallbackUsdtAmount: '100000000',
  });
  assert.equal(resolved.amountAtomic, '777');
  assert.equal(resolved.warnings.length, 0);
});

test('rfq flags: solana mode rejects --tao-amount-atomic', () => {
  assert.throws(
    () =>
      resolveRfqSettlementAmountAtomic({
        settlementKind: SETTLEMENT_KIND.SOLANA,
        usdtAmountRaw: '100',
        taoAmountAtomicRaw: '200',
        fallbackUsdtAmount: '100000000',
      }),
    /only valid when --settlement tao-evm/i
  );
});

test('rfq flags: settlement refund alias + canonical mapping', () => {
  const canonical = resolveSettlementRefundAfterSec({
    settlementRefundAfterSecRaw: '7201',
    legacySolanaRefundAfterSecRaw: '',
    fallbackSec: 72 * 3600,
    minSec: 3600,
    maxSec: 7 * 24 * 3600,
  });
  assert.equal(canonical.settlementRefundAfterSec, 7201);
  assert.equal(canonical.warnings.length, 0);

  const legacy = resolveSettlementRefundAfterSec({
    settlementRefundAfterSecRaw: '',
    legacySolanaRefundAfterSecRaw: '7202',
    fallbackSec: 72 * 3600,
    minSec: 3600,
    maxSec: 7 * 24 * 3600,
  });
  assert.equal(legacy.settlementRefundAfterSec, 7202);
  assert.equal(legacy.warnings.length, 1);
  assert.match(legacy.warnings[0], /deprecated/i);
});
