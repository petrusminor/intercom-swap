import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMakerSvcAnnounceUnsignedEnvelope,
  resolveMakerSvcAnnounceLoopOptions,
} from '../scripts/rfq-maker.mjs';
import { KIND, PAIR } from '../src/swap/constants.js';

test('rfq-maker svc announce: disabled when prefixed flags are absent', () => {
  const res = resolveMakerSvcAnnounceLoopOptions({ flags: new Map() });

  assert.deepEqual(res, {
    enabled: false,
    channels: [],
    configPath: '',
    intervalSec: 30,
    ttlSec: null,
    watch: true,
    tradeId: '',
  });
});

test('rfq-maker svc announce: parses prefixed loop flags', () => {
  const flags = new Map([
    ['svc-announce-channels', 'lobby-a,lobby-b'],
    ['svc-announce-config', '@/tmp/maker-offer.json'],
    ['svc-announce-interval-sec', '45'],
    ['svc-announce-ttl-sec', '90'],
    ['svc-announce-watch', '0'],
    ['svc-announce-trade-id', 'svc:maker-a'],
  ]);

  const res = resolveMakerSvcAnnounceLoopOptions({ flags });

  assert.deepEqual(res, {
    enabled: true,
    channels: ['lobby-a', 'lobby-b'],
    configPath: '@/tmp/maker-offer.json',
    intervalSec: 45,
    ttlSec: 90,
    watch: false,
    tradeId: 'svc:maker-a',
  });
});

test('rfq-maker svc announce: builds envelope with rfq fallback + ttl', () => {
  const unsigned = buildMakerSvcAnnounceUnsignedEnvelope({
    cfg: {
      name: 'Maker Bot',
      pairs: [PAIR.BTC_LN__TAO_EVM],
      note: 'auto-posted',
    },
    ttlSec: 120,
    defaultRfqChannels: ['0000intercomswapbtctao'],
    nowMs: 1_700_000_000_000,
  });

  assert.equal(unsigned.kind, KIND.SVC_ANNOUNCE);
  assert.equal(unsigned.trade_id, 'svc:Maker-Bot');
  assert.equal(unsigned.body.name, 'Maker Bot');
  assert.deepEqual(unsigned.body.pairs, [PAIR.BTC_LN__TAO_EVM]);
  assert.deepEqual(unsigned.body.rfq_channels, ['0000intercomswapbtctao']);
  assert.equal(unsigned.body.note, 'auto-posted');
  assert.equal(unsigned.body.valid_until_unix, 1_700_000_120);
});

test('rfq-maker svc announce: explicit config trade_id and rfq channels win', () => {
  const unsigned = buildMakerSvcAnnounceUnsignedEnvelope({
    cfg: {
      name: 'Maker Bot',
      trade_id: 'svc:cfg-id',
      rfq_channels: ['cfg-rfq'],
      offers: [{ have: 'TAO_EVM', want: 'BTC_LN', pair: PAIR.BTC_LN__TAO_EVM }],
    },
    tradeId: 'svc:flag-id',
    defaultRfqChannels: ['fallback-rfq'],
  });

  assert.equal(unsigned.trade_id, 'svc:flag-id');
  assert.deepEqual(unsigned.body.rfq_channels, ['cfg-rfq']);
  assert.deepEqual(unsigned.body.offers, [{ have: 'TAO_EVM', want: 'BTC_LN', pair: PAIR.BTC_LN__TAO_EVM }]);
});
