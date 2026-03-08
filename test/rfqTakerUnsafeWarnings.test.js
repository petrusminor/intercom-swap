import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTakerMinTimelockConfig,
  resolveTakerRefundAfterMarginConfig,
} from '../scripts/rfq-taker.mjs';

function collectWarnings(env) {
  const timelock = resolveTakerMinTimelockConfig({ env, fallbackSec: 3600 });
  const margin = resolveTakerRefundAfterMarginConfig({ env, fallbackSec: 900 });
  return timelock.warnings.concat(margin.warnings);
}

test('rfq taker unsafe warnings: no warnings when neither override is set', () => {
  assert.deepEqual(collectWarnings({}), []);
});

test('rfq taker unsafe warnings: timelock warning appears when only INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC is lowered', () => {
  const warnings = collectWarnings({ INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC: '1' });
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /UNSAFE: lowering taker minimum timelock remaining to 1s for this process only/
  );
});

test('rfq taker unsafe warnings: margin warning appears when only INTERCOMSWAP_MIN_REFUND_AFTER_MARGIN_SEC is lowered', () => {
  const warnings = collectWarnings({ INTERCOMSWAP_MIN_REFUND_AFTER_MARGIN_SEC: '1' });
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /UNSAFE: lowering taker refund-after vs invoice-expiry margin to 1s for this process only/
  );
});

test('rfq taker unsafe warnings: both warnings appear when both overrides are lowered', () => {
  const warnings = collectWarnings({
    INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC: '1',
    INTERCOMSWAP_MIN_REFUND_AFTER_MARGIN_SEC: '1',
  });
  assert.equal(warnings.length, 2);
  assert.match(
    warnings[0],
    /UNSAFE: lowering taker minimum timelock remaining to 1s for this process only/
  );
  assert.match(
    warnings[1],
    /UNSAFE: lowering taker refund-after vs invoice-expiry margin to 1s for this process only/
  );
});
