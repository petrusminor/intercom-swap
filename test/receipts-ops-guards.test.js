import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initReceiptsStore } from '../scripts/rfq-maker.mjs';

function regexEscape(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeUnwritableDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-receipts-ro-'));
  fs.chmodSync(dir, 0o555);
  const dbPath = path.join(dir, 'receipts.sqlite');
  const cleanup = () => {
    try {
      fs.chmodSync(dir, 0o755);
    } catch (_e) {}
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_e) {}
  };
  return { dbPath, cleanup };
}

test('initReceiptsStore runSwap=1 throws with path+hint when receipts path is unwritable', () => {
  const { dbPath, cleanup } = makeUnwritableDbPath();
  try {
    assert.throws(
      () =>
        initReceiptsStore({
          dbPath,
          runSwap: true,
          allowNoReceipts: false,
          role: 'maker-test',
        }),
      (err) => {
        const msg = String(err?.message || err);
        assert.match(msg, /enabled=false/);
        assert.match(msg, new RegExp(`db_path=${regexEscape(dbPath)}`));
        assert.match(msg, /INTERCOMSWAP_RECEIPTS_DB/);
        assert.match(msg, /allow-no-receipts/);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('initReceiptsStore allow-no-receipts returns enabled=false and logs warning', () => {
  const { dbPath, cleanup } = makeUnwritableDbPath();
  let stderr = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderr += String(chunk);
    return originalWrite(chunk, ...args);
  };
  try {
    const runtime = initReceiptsStore({
      dbPath,
      runSwap: true,
      allowNoReceipts: true,
      role: 'maker-test',
    });
    assert.equal(runtime.enabled, false);
    assert.equal(runtime.receipts, null);
  } finally {
    process.stderr.write = originalWrite;
    cleanup();
  }
  assert.match(stderr, /continuing without receipts/);
  assert.match(stderr, new RegExp(`db_path=${regexEscape(dbPath)}`));
});

test('rfq peer wrappers do not hardcode --receipts-db flags', () => {
  const makerPs1 = fs.readFileSync(path.resolve('scripts/rfq-maker-peer.ps1'), 'utf8');
  const takerPs1 = fs.readFileSync(path.resolve('scripts/rfq-taker-peer.ps1'), 'utf8');
  assert.doesNotMatch(makerPs1, /--receipts-db/);
  assert.doesNotMatch(takerPs1, /--receipts-db/);
});
