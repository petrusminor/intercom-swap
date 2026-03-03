import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { lnInvoice } from '../src/ln/client.js';
import { decodeBolt11 } from '../src/ln/bolt11.js';

const FIXTURE_BOLT11 =
  'lnbcrt12340p1p5ct6ensp525myu22mhh03a2zr636tn59eahjhkprajmd2ppnl586qz27wvjxqpp5xkvweakdjc9m0rlxm3hhmfvz9hd6acjexfkuz06aeax0n2c7u0zqdq8v3jhxccxqyjw5qcqp29qxpqysgqtrheftp4lndgsjz80xx64sf3vfmtn7qzrtdha9mwxqg0mnqqz8hncgk9k3dzh48ftud92w4j4eskck044tdzpkl9ymrjf3hzsf6cjtgpupxvn0';
const FIXTURE_PAYMENT_HASH = '3598ecf6cd960bb78fe6dc6f7da5822ddbaee259326dc13f5dcf4cf9ab1ee3c4';

function writeFakeClnCli(scriptPath, logPath) {
  const src = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > ${JSON.stringify(logPath)}
echo '{"bolt11":"${FIXTURE_BOLT11}","payment_hash":"${FIXTURE_PAYMENT_HASH}"}'
`;
  fs.writeFileSync(scriptPath, src, { mode: 0o755 });
}

function readArgs(logPath) {
  return String(fs.readFileSync(logPath, 'utf8') || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function newLnOpts(cliBin) {
  return {
    impl: 'cln',
    backend: 'cli',
    network: 'regtest',
    cliBin,
    cwd: '/home/validator1/intercom-swap',
  };
}

test('lnInvoice: includes expiry arg when expirySec is set and returned bolt11 decodes to expected expiry', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-ln-invoice-expiry-'));
  const cliPath = path.join(tmp, 'fake-lightning-cli.sh');
  const logPath = path.join(tmp, 'args.log');
  writeFakeClnCli(cliPath, logPath);

  const invoice = await lnInvoice(newLnOpts(cliPath), {
    amountMsat: '1234',
    label: 'expiry-set',
    description: 'expiry-set',
    expirySec: 604800,
  });

  const args = readArgs(logPath);
  assert.deepEqual(args, ['--network=regtest', 'invoice', '1234msat', 'expiry-set', 'expiry-set', '604800']);
  assert.equal(invoice.payment_hash, FIXTURE_PAYMENT_HASH);

  const decoded = decodeBolt11(invoice.bolt11);
  assert.equal(decoded.expiry_seconds, 604800);
  assert.equal(decoded.expires_at_unix, 1770988979);
});

test('lnInvoice: omits expiry arg when expirySec is unset and returned bolt11 expiry remains sane', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-ln-invoice-expiry-'));
  const cliPath = path.join(tmp, 'fake-lightning-cli.sh');
  const logPath = path.join(tmp, 'args.log');
  writeFakeClnCli(cliPath, logPath);

  const invoice = await lnInvoice(newLnOpts(cliPath), {
    amountMsat: '1234',
    label: 'expiry-default',
    description: 'expiry-default',
  });

  const args = readArgs(logPath);
  assert.deepEqual(args, ['--network=regtest', 'invoice', '1234msat', 'expiry-default', 'expiry-default']);
  assert.equal(invoice.payment_hash, FIXTURE_PAYMENT_HASH);

  const decoded = decodeBolt11(invoice.bolt11);
  assert.ok(Number.isFinite(decoded.expiry_seconds));
  assert.ok(decoded.expiry_seconds >= 60);
  assert.ok(decoded.expires_at_unix > decoded.timestamp_unix);
});
