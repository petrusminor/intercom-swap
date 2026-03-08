import test from 'node:test';
import assert from 'node:assert/strict';

import { attachSignature } from '../src/protocol/signedMessage.js';
import { buildRfqUnsignedEnvelope } from '../src/rfq/buildRfq.js';
import { deriveIntercomswapAppHash } from '../src/swap/app.js';
import { PAIR } from '../src/swap/constants.js';
import { resolveMakerSettlementRefundConfig, validateLocalMakerEnvelope } from '../scripts/rfq-maker.mjs';
import { DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC } from '../src/rfq/cliFlags.js';

const TAO_HTLC_ADDRESS = '0x6B1E5e136c91e5Cb7c5c30C996ae9F3119460653';

function buildSignedInboundRfq({ settlementRefundAfterSec }) {
  const unsigned = buildRfqUnsignedEnvelope({
    tradeId: 'rfq_maker_inbound_refund_window',
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

test('rfq maker default rejects 120-second settlement refund window', () => {
  assert.throws(
    () =>
      resolveMakerSettlementRefundConfig({
        settlementRefundAfterSecRaw: '120',
        legacySolanaRefundAfterSecRaw: null,
      }),
    /Invalid --settlement-refund-after-sec \(must be >= 259200\)/
  );
});

test('rfq maker accepts 120-second settlement refund window when unsafe override is provided', () => {
  const cfg = resolveMakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: '120',
    legacySolanaRefundAfterSecRaw: null,
    unsafeMinSettlementRefundAfterSecRaw: '1',
  });
  assert.equal(cfg.settlementRefundAfterSec, 120);
  assert.equal(cfg.effectiveMinSettlementRefundAfterSec, 1);
  assert.equal(cfg.unsafeMinProvided, true);
  assert.match(
    String(cfg.warnings[0] || ''),
    /UNSAFE: lowering maker minimum settlement refund window to 1s for this process only/
  );
});

test('rfq maker unsafe min settlement refund override is runtime-only', () => {
  const overridden = resolveMakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: '120',
    legacySolanaRefundAfterSecRaw: null,
    unsafeMinSettlementRefundAfterSecRaw: '1',
  });
  assert.equal(overridden.effectiveMinSettlementRefundAfterSec, 1);
  assert.equal(overridden.unsafeMinProvided, true);

  const defaulted = resolveMakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: String(DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC),
    legacySolanaRefundAfterSecRaw: null,
  });
  assert.equal(defaulted.effectiveMinSettlementRefundAfterSec, DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC);
  assert.equal(defaulted.unsafeMinProvided, false);
});

test('rfq maker default behavior remains unchanged when unsafe flag is omitted', () => {
  const cfg = resolveMakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: null,
    legacySolanaRefundAfterSecRaw: null,
  });
  assert.equal(cfg.settlementRefundAfterSec, DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC);
  assert.equal(cfg.effectiveMinSettlementRefundAfterSec, DEFAULT_SAFE_MIN_SETTLEMENT_REFUND_AFTER_SEC);
  assert.equal(cfg.unsafeMinProvided, false);
  assert.deepEqual(cfg.warnings, []);
});

test('rfq maker inbound RFQ validation rejects settlement_refund_after_sec=120 by default', () => {
  const env = buildSignedInboundRfq({ settlementRefundAfterSec: 120 });
  const res = validateLocalMakerEnvelope(env);
  assert.equal(res.ok, false);
  assert.match(String(res.error || ''), /rfq\.settlement_refund_after_sec must be >= 3600/);
});

test('rfq maker inbound RFQ validation accepts settlement_refund_after_sec=120 when unsafe override=1', () => {
  const cfg = resolveMakerSettlementRefundConfig({
    settlementRefundAfterSecRaw: '120',
    legacySolanaRefundAfterSecRaw: null,
    unsafeMinSettlementRefundAfterSecRaw: '1',
  });
  const env = buildSignedInboundRfq({ settlementRefundAfterSec: 120 });
  const res = validateLocalMakerEnvelope(env, {
    effectiveMinSettlementRefundAfterSec: cfg.effectiveMinSettlementRefundAfterSec,
  });
  assert.equal(res.ok, true, res.error);
});

test('rfq maker inbound RFQ unsafe override is runtime-only and does not persist', () => {
  const env = buildSignedInboundRfq({ settlementRefundAfterSec: 120 });
  const withOverride = validateLocalMakerEnvelope(env, {
    effectiveMinSettlementRefundAfterSec: 1,
  });
  assert.equal(withOverride.ok, true, withOverride.error);

  const withoutOverride = validateLocalMakerEnvelope(env);
  assert.equal(withoutOverride.ok, false);
  assert.match(String(withoutOverride.error || ''), /rfq\.settlement_refund_after_sec must be >= 3600/);
});
