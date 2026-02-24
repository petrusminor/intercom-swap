import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ToolExecutor } from '../src/prompt/executor.js';

function writeFakeLnCli(filePath) {
  const src = `#!/usr/bin/env bash
set -euo pipefail

cmd=""
for a in "$@"; do
  case "$a" in
    --*) ;;
    *) cmd="$a"; break ;;
  esac
done

if [ -n "\${PHASE11_1_LN_LOG:-}" ]; then
  printf '{"cmd":"%s","ts":%s}\\n' "$cmd" "$(date +%s)" >> "$PHASE11_1_LN_LOG"
fi

if [ "$cmd" = "pay" ]; then
  echo '{"payment_preimage":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
  exit 0
fi

echo '{}'
`;
  fs.writeFileSync(filePath, src, { mode: 0o755 });
}

function countPayCalls(logPath) {
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

test('swap LN pay bypass tools are disabled and never call lnPay', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-phase11-1-lnpay-'));
  const lnCliPath = path.join(tempDir, 'fake-lightning-cli.sh');
  const lnLogPath = path.join(tempDir, 'fake-ln-calls.log');

  writeFakeLnCli(lnCliPath);

  const prev = process.env.PHASE11_1_LN_LOG;
  process.env.PHASE11_1_LN_LOG = lnLogPath;

  t.after(() => {
    if (prev === undefined) delete process.env.PHASE11_1_LN_LOG;
    else process.env.PHASE11_1_LN_LOG = prev;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_e) {}
  });

  const ex = new ToolExecutor({
    scBridge: { url: 'ws://127.0.0.1:1', token: 'x' },
    peer: { keypairPath: '' },
    ln: { impl: 'cln', backend: 'cli', network: 'regtest', cliBin: lnCliPath },
    solana: { rpcUrls: 'http://127.0.0.1:8899', commitment: 'confirmed', programId: '11111111111111111111111111111111' },
    receipts: { dbPath: 'onchain/receipts/test/phase11_1.sqlite' },
  });

  await assert.rejects(
    () =>
      ex.execute(
        'intercomswap_swap_ln_pay_and_post',
        {
          channel: 'swap:phase11-1',
          trade_id: 'phase11-1',
          bolt11: 'lnbcrt1phase111safety0000000000000000000000001',
          payment_hash_hex: '11'.repeat(32),
        },
        { autoApprove: true }
      ),
    /disabled for safety; use intercomswap_swap_ln_pay_and_post_verified/i
  );

  await assert.rejects(
    () =>
      ex.execute(
        'intercomswap_swap_ln_pay_and_post_from_invoice',
        {
          channel: 'swap:phase11-1',
          invoice_envelope: {},
        },
        { autoApprove: true }
      ),
    /disabled for safety; use intercomswap_swap_ln_pay_and_post_verified/i
  );

  assert.equal(countPayCalls(lnLogPath), 0, 'lnPay must not be called by disabled swap pay tools');
});
