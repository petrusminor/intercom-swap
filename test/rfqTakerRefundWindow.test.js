import test from 'node:test';
import assert from 'node:assert/strict';

import { attachSignature } from '../src/protocol/signedMessage.js';
import { buildRfqUnsignedEnvelope } from '../src/rfq/buildRfq.js';
import { deriveIntercomswapAppHash } from '../src/swap/app.js';
import { createUnsignedEnvelope } from '../src/protocol/signedMessage.js';
import { KIND, PAIR } from '../src/swap/constants.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { resolveTakerSettlementRefundConfig, validateLocalTakerEnvelope } from '../scripts/rfq-taker.mjs';
import { DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC } from '../src/rfq/cliFlags.js';

const TAO_HTLC_ADDRESS = '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653';

function buildSignedTakerRfq({ settlementRefundAfterSec }) {
  const unsigned = buildRfqUnsignedEnvelope({
    tradeId: 'rfq_taker_refund_window_signing',
    pair: PAIR.BTC_LN__TAO_EVM,
    expectedAppHash: deriveIntercomswapAppHash({ solanaProgramId: TAO_HTLC_ADDRESS }),
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
  return attachSignature(unsigned, {
    signerPubKeyHex: '11'.repeat(32),
    sigHex: '22'.repeat(64),
  });
}

function buildSignedInboundQuote({ settlementRefundAfterSec }) {
  const rfq = buildSignedTakerRfq({ settlementRefundAfterSec });
  const rfqId = hashUnsignedEnvelope({
    v: rfq.v,
    kind: rfq.kind,
    trade_id: rfq.trade_id,
    ts: rfq.ts,
    nonce: rfq.nonce,
    body: rfq.body,
  });
  const unsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE,
    tradeId: 'rfq_taker_refund_window_signing',
    body: {
      rfq_id: rfqId,
      pair: PAIR.BTC_LN__TAO_EVM,
      direction: 'BTC_LN->TAO_EVM',
      app_hash: deriveIntercomswapAppHash({ solanaProgramId: TAO_HTLC_ADDRESS }),
      btc_sats: 50_000,
      tao_amount_atomic: '4200000000000000000',
      settlement_kind: 'tao-evm',
      settlement_refund_after_sec: settlementRefundAfterSec,
      platform_fee_bps: 10,
      trade_fee_bps: 10,
      valid_until_unix: Math.floor(Date.now() / 1000) + 60,
    },
  });
  return attachSignature(unsigned, {
    signerPubKeyHex: '11'.repeat(32),
    sigHex: '22'.repeat(64),
  });
}

test('rfq taker default rejects 120-second settlement refund window', () => {
  assert.throws(
    () =>
      resolveTakerSettlementRefundConfig({
        settlementRefundAfterSecRaw: '120',
        legacySolanaRefundAfterSecRaw: null,
      }),
    /Invalid --settlement-refund-after-sec \(must be >= 259200\)/
  );
});

test('rfq taker accepts 120-second settlement refund window when unsafe override is provided', () => {
  const cfg = resolveTakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: '120',
    legacySolanaRefundAfterSecRaw: null,
    unsafeMinSettlementRefundAfterSecRaw: '1',
  });
  assert.equal(cfg.settlementRefundAfterSec, 120);
  assert.equal(cfg.effectiveMinSettlementRefundAfterSec, 1);
  assert.equal(cfg.unsafeMinProvided, true);
  assert.match(
    String(cfg.warnings[0] || ''),
    /UNSAFE: lowering taker minimum settlement refund window to 1s for this process only/
  );
});

test('rfq taker unsafe min settlement refund override is runtime-only', () => {
  const overridden = resolveTakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: '120',
    legacySolanaRefundAfterSecRaw: null,
    unsafeMinSettlementRefundAfterSecRaw: '1',
  });
  assert.equal(overridden.effectiveMinSettlementRefundAfterSec, 1);
  assert.equal(overridden.unsafeMinProvided, true);

  const defaulted = resolveTakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: String(DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC),
    legacySolanaRefundAfterSecRaw: null,
  });
  assert.equal(defaulted.effectiveMinSettlementRefundAfterSec, DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC);
  assert.equal(defaulted.unsafeMinProvided, false);
});

test('rfq taker default behavior remains unchanged when unsafe flag is omitted', () => {
  const cfg = resolveTakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: null,
    legacySolanaRefundAfterSecRaw: null,
  });
  assert.equal(cfg.settlementRefundAfterSec, DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC);
  assert.equal(cfg.effectiveMinSettlementRefundAfterSec, DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC);
  assert.equal(cfg.unsafeMinProvided, false);
  assert.deepEqual(cfg.warnings, []);
});

test('rfq taker signing/build rejects settlement_refund_after_sec=120 by default', () => {
  const env = buildSignedTakerRfq({ settlementRefundAfterSec: 120 });
  const res = validateLocalTakerEnvelope(env);
  assert.equal(res.ok, false);
  assert.match(String(res.error || ''), /rfq\.settlement_refund_after_sec must be >= 3600/);
});

test('rfq taker signing/build accepts settlement_refund_after_sec=120 when unsafe override=1', () => {
  const cfg = resolveTakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: '120',
    legacySolanaRefundAfterSecRaw: null,
    unsafeMinSettlementRefundAfterSecRaw: '1',
  });
  const env = buildSignedTakerRfq({ settlementRefundAfterSec: 120 });
  const res = validateLocalTakerEnvelope(env, {
    effectiveMinSettlementRefundAfterSec: cfg.effectiveMinSettlementRefundAfterSec,
  });
  assert.equal(res.ok, true, res.error);
});

test('rfq taker signing/build unsafe override is runtime-only and does not persist', () => {
  const env = buildSignedTakerRfq({ settlementRefundAfterSec: 120 });
  const withOverride = validateLocalTakerEnvelope(env, {
    effectiveMinSettlementRefundAfterSec: 1,
  });
  assert.equal(withOverride.ok, true, withOverride.error);

  const withoutOverride = validateLocalTakerEnvelope(env);
  assert.equal(withoutOverride.ok, false);
  assert.match(String(withoutOverride.error || ''), /rfq\.settlement_refund_after_sec must be >= 3600/);
});

test('rfq taker inbound quote validation rejects settlement_refund_after_sec=120 by default', () => {
  const env = buildSignedInboundQuote({ settlementRefundAfterSec: 120 });
  const res = validateLocalTakerEnvelope(env);
  assert.equal(res.ok, false);
  assert.match(String(res.error || ''), /quote\.settlement_refund_after_sec must be >= 3600/);
});

test('rfq taker inbound quote validation accepts settlement_refund_after_sec=120 when unsafe override=1', () => {
  const cfg = resolveTakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: '120',
    legacySolanaRefundAfterSecRaw: null,
    unsafeMinSettlementRefundAfterSecRaw: '1',
  });
  const env = buildSignedInboundQuote({ settlementRefundAfterSec: 120 });
  const res = validateLocalTakerEnvelope(env, {
    effectiveMinSettlementRefundAfterSec: cfg.effectiveMinSettlementRefundAfterSec,
  });
  assert.equal(res.ok, true, res.error);
});

test('rfq taker inbound quote unsafe override is runtime-only and does not persist', () => {
  const env = buildSignedInboundQuote({ settlementRefundAfterSec: 120 });
  const withOverride = validateLocalTakerEnvelope(env, {
    effectiveMinSettlementRefundAfterSec: 1,
  });
  assert.equal(withOverride.ok, true, withOverride.error);

  const withoutOverride = validateLocalTakerEnvelope(env);
  assert.equal(withoutOverride.ok, false);
  assert.match(String(withoutOverride.error || ''), /quote\.settlement_refund_after_sec must be >= 3600/);
});
