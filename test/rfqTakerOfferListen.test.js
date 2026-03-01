import test from 'node:test';
import assert from 'node:assert/strict';

import { attachSignature } from '../src/protocol/signedMessage.js';
import { createUnsignedEnvelope } from '../src/protocol/signedMessage.js';
import { matchOfferAnnouncementEvent } from '../src/rfq/offerMatch.js';
import { deriveIntercomswapAppHash } from '../src/swap/app.js';
import { ASSET, KIND, PAIR, DIR } from '../src/swap/constants.js';
import { SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID } from '../settlement/providerFactory.js';

const TAO_HTLC_ADDRESS = '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653';
const RFQ_CHANNEL = '0000intercomswapbtctao';
const SOL_APP_HASH = deriveIntercomswapAppHash({ solanaProgramId: SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID });
const TAO_APP_HASH = deriveIntercomswapAppHash({ solanaProgramId: TAO_HTLC_ADDRESS });

function signEnvelope(unsignedEnvelope) {
  return attachSignature(unsignedEnvelope, {
    signerPubKeyHex: '11'.repeat(32),
    sigHex: '22'.repeat(64),
  });
}

function makeOfferEvent(offers) {
  return {
    type: 'sidechannel_message',
    channel: RFQ_CHANNEL,
    message: signEnvelope(
      createUnsignedEnvelope({
        v: 1,
        kind: KIND.SVC_ANNOUNCE,
        tradeId: 'svc_offer_test',
        body: {
          name: 'maker:test',
          pairs: [PAIR.BTC_LN__USDT_SOL, PAIR.BTC_LN__TAO_EVM],
          rfq_channels: [RFQ_CHANNEL],
          offers,
          valid_until_unix: Math.floor(Date.now() / 1000) + 60,
        },
      })
    ),
  };
}

function matchOffer(evt) {
  return matchOfferAnnouncementEvent(evt, {
    offerChannels: [RFQ_CHANNEL],
    rfqChannel: RFQ_CHANNEL,
    fallbackPair: PAIR.BTC_LN__USDT_SOL,
    expectedProgramId: SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID,
    taoHtlcAddress: TAO_HTLC_ADDRESS,
    minRefundSec: 72 * 3600,
    maxRefundSec: 7 * 24 * 3600,
    maxPlatformFeeBps: 500,
    maxTradeFeeBps: 1000,
    maxTotalFeeBps: 1500,
  });
}

test('rfq taker offer-listen: derives TAO RFQ overrides from svc_announce offers', () => {
  const evt = makeOfferEvent([
    {
      pair: PAIR.BTC_LN__USDT_SOL,
      have: ASSET.USDT_SOL,
      want: ASSET.BTC_LN,
      app_hash: SOL_APP_HASH,
      btc_sats: 50_000,
      usdt_amount: '100000000',
      max_platform_fee_bps: 500,
      max_trade_fee_bps: 1000,
      max_total_fee_bps: 1500,
      min_sol_refund_window_sec: 72 * 3600,
      max_sol_refund_window_sec: 7 * 24 * 3600,
      settlement_refund_after_sec: 259200,
    },
    {
      pair: PAIR.BTC_LN__TAO_EVM,
      have: ASSET.TAO_EVM,
      want: ASSET.BTC_LN,
      settlement_kind: 'tao-evm',
      app_hash: TAO_APP_HASH,
      btc_sats: 50_000,
      tao_amount_atomic: '4200000000',
      max_platform_fee_bps: 10,
      max_trade_fee_bps: 10,
      max_total_fee_bps: 20,
      settlement_refund_after_sec: 259200,
    },
  ]);

  const matched = matchOffer(evt);
  assert.ok(matched, 'expected TAO offer to match when malformed USDT offer is skipped');
  assert.equal(matched.pair, PAIR.BTC_LN__TAO_EVM);
  assert.equal(matched.direction, DIR.BTC_LN__TO__TAO_EVM);
  assert.equal(matched.settlement_kind, 'tao-evm');
  assert.equal(matched.btc_sats, 50_000);
  assert.equal(matched.amount_field, 'tao_amount_atomic');
  assert.equal(matched.tao_amount_atomic, '4200000000');
  assert.equal(matched.settlement_refund_after_sec, 259200);
});

test('rfq taker offer-listen: derives USDT RFQ overrides and rejects TAO-only fields on SOL pair', () => {
  const evt = makeOfferEvent([
    {
      pair: PAIR.BTC_LN__TAO_EVM,
      have: ASSET.TAO_EVM,
      want: ASSET.BTC_LN,
      app_hash: TAO_APP_HASH,
      btc_sats: 50_000,
      tao_amount_atomic: '4200000000',
      min_sol_refund_window_sec: 72 * 3600,
      max_platform_fee_bps: 10,
      max_trade_fee_bps: 10,
      max_total_fee_bps: 20,
      settlement_refund_after_sec: 259200,
    },
    {
      pair: PAIR.BTC_LN__USDT_SOL,
      have: ASSET.USDT_SOL,
      want: ASSET.BTC_LN,
      app_hash: SOL_APP_HASH,
      btc_sats: 25_000,
      usdt_amount: '123450000',
      max_platform_fee_bps: 500,
      max_trade_fee_bps: 1000,
      max_total_fee_bps: 1500,
      min_sol_refund_window_sec: 72 * 3600,
      max_sol_refund_window_sec: 7 * 24 * 3600,
    },
  ]);

  const matched = matchOffer(evt);
  assert.ok(matched, 'expected USDT offer to match when malformed TAO offer is skipped');
  assert.equal(matched.pair, PAIR.BTC_LN__USDT_SOL);
  assert.equal(matched.direction, DIR.BTC_LN__TO__USDT_SOL);
  assert.equal(matched.settlement_kind, 'solana');
  assert.equal(matched.btc_sats, 25_000);
  assert.equal(matched.amount_field, 'usdt_amount');
  assert.equal(matched.usdt_amount, '123450000');
  assert.equal(matched.min_sol_refund_window_sec, 72 * 3600);
  assert.equal(matched.max_sol_refund_window_sec, 7 * 24 * 3600);
});
