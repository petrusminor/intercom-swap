import test from 'node:test';
import assert from 'node:assert/strict';

import {
  maybeReuseExistingQuote,
  quoteMatchesCurrentSettlementPolicy,
} from '../scripts/rfq-maker.mjs';
import { attachSignature } from '../src/protocol/signedMessage.js';
import { createUnsignedEnvelope } from '../src/protocol/signedMessage.js';
import { KIND, PAIR } from '../src/swap/constants.js';

function makeSignedQuote({ settlementRefundAfterSec }) {
  return attachSignature(
    createUnsignedEnvelope({
      v: 1,
      kind: KIND.QUOTE,
      tradeId: 'trade_stale_quote_test',
      body: {
        rfq_id: 'rfq_old',
        pair: PAIR.BTC_LN__TAO_EVM,
        direction: 'BTC_LN->TAO_EVM',
        app_hash: '11'.repeat(32),
        btc_sats: 50000,
        tao_amount_atomic: '4200000000',
        settlement_kind: 'tao-evm',
        settlement_refund_after_sec: settlementRefundAfterSec,
        valid_until_unix: Math.floor(Date.now() / 1000) + 60,
      },
    }),
    {
      signerPubKeyHex: '22'.repeat(32),
      sigHex: '33'.repeat(64),
    }
  );
}

test('rfq-maker: stale TAO quote refund policy mismatch prevents existing quote reuse', () => {
  const signedQuote = makeSignedQuote({ settlementRefundAfterSec: 259200 });
  const reuse = quoteMatchesCurrentSettlementPolicy({
    signedQuote,
    pair: PAIR.BTC_LN__TAO_EVM,
    settlementKind: 'tao-evm',
    settlementRefundAfterSec: 3700,
  });

  assert.equal(reuse, false);
});

test('rfq-maker: TAO quote is reusable when settlement refund policy matches', () => {
  const signedQuote = makeSignedQuote({ settlementRefundAfterSec: 3700 });
  const reuse = quoteMatchesCurrentSettlementPolicy({
    signedQuote,
    pair: PAIR.BTC_LN__TAO_EVM,
    settlementKind: 'tao-evm',
    settlementRefundAfterSec: 3700,
  });

  assert.equal(reuse, true);
});

test('rfq-maker: matching existing quote is resent and updates resend metadata', async () => {
  const signedQuote = makeSignedQuote({ settlementRefundAfterSec: 3700 });
  const existingLock = {
    state: 'quoted',
    quoteId: 'quote_reuse_ok',
    signedQuote,
    lastSeenMs: 1,
    lastQuoteSendAtMs: 1,
  };
  const sent = [];

  const res = await maybeReuseExistingQuote({
    existingLock,
    pair: PAIR.BTC_LN__TAO_EVM,
    settlementKind: 'tao-evm',
    settlementRefundAfterSec: 3700,
    nowMs: 9999,
    sendQuote: async (quote) => {
      sent.push(quote);
    },
  });

  assert.deepEqual(
    { reused: res.reused, sent: res.sent, cleared: res.cleared, reason: res.reason },
    { reused: true, sent: true, cleared: false, reason: 'resend_existing_quote' }
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0], signedQuote);
  assert.equal(existingLock.lastSeenMs, 9999);
  assert.equal(existingLock.lastQuoteSendAtMs, 9999);
});
