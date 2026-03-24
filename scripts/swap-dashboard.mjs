#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const RECEIPTS_DBS = Object.freeze([
  path.join(repoRoot, 'stores', 'swap-maker', 'db', 'receipts.db'),
  path.join(repoRoot, 'stores', 'swap-taker', 'db', 'receipts.db'),
]);

const TERMINAL_STATES = new Set(['claimed', 'refunded', 'canceled', 'cancelled', 'failed', 'expired']);

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  const known = new Set(['--active', '--claimable', '--refundable', '--actionable']);
  for (const flag of flags) {
    if (!known.has(flag)) {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }
  const selected = ['--active', '--claimable', '--refundable', '--actionable'].filter((flag) => flags.has(flag));
  if (selected.length > 1) {
    throw new Error(`Choose at most one filter flag: ${selected.join(', ')}`);
  }
  return {
    active: flags.has('--active'),
    claimable: flags.has('--claimable'),
    refundable: flags.has('--refundable'),
    actionable: flags.has('--actionable'),
  };
}

async function loadSqlite() {
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...args) => {
    const message = typeof warning === 'string' ? warning : String(warning?.message || warning || '');
    const type = typeof args[0] === 'string' ? args[0] : String(warning?.name || '');
    if (type === 'ExperimentalWarning' && message.includes('SQLite is an experimental feature')) {
      return;
    }
    return originalEmitWarning(warning, ...args);
  };
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function isTerminalState(stateRaw) {
  return TERMINAL_STATES.has(String(stateRaw || '').trim().toLowerCase());
}

function normalizeText(value) {
  const s = String(value ?? '').trim();
  return s || '-';
}

function normalizeState(value) {
  const s = String(value ?? '').trim();
  return s || '-';
}

function normalizeAtomic(value) {
  const s = String(value ?? '').trim();
  return /^[0-9]+$/.test(s) ? s : '';
}

function normalizeInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const s = String(value ?? '').trim();
  if (/^-?[0-9]+$/.test(s)) return Number.parseInt(s, 10);
  return null;
}

function effectiveRefundAfterUnix(row) {
  const tao = normalizeInt(row?.tao_refund_after_unix);
  if (tao !== null && tao > 0) return tao;
  const sol = normalizeInt(row?.sol_refund_after_unix);
  if (sol !== null && sol > 0) return sol;
  return null;
}

function formatAtomicHuman(atomicRaw, decimals = 18) {
  const s = normalizeAtomic(atomicRaw);
  if (!s) return '';
  const padded = s.padStart(decimals + 1, '0');
  const split = padded.length - decimals;
  const intPartRaw = padded.slice(0, split).replace(/^0+(?=\d)/, '');
  const intPart = intPartRaw || '0';
  const fracPart = padded.slice(split).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function displayTaoAmount(atomicRaw) {
  const atomic = normalizeAtomic(atomicRaw);
  if (!atomic) return '-';
  if (process.env.INTERCOMSWAP_DASHBOARD_HUMAN === '1') {
    const human = formatAtomicHuman(atomic, 18);
    return human ? `${atomic} (${human})` : atomic;
  }
  return atomic;
}

function normalizeEpochMs(value) {
  const n = normalizeInt(value);
  if (n === null || n < 0) return null;
  if (n > 1e12) return n;
  return n * 1000;
}

function formatAgeFromEpochMs(tsMs, nowMs) {
  if (!Number.isFinite(tsMs) || tsMs < 0 || !Number.isFinite(nowMs) || nowMs < 0) return '-';
  const ageMs = nowMs - tsMs;
  if (ageMs < 0) return '-';
  const ageSec = Math.floor(ageMs / 1000);
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  return `${Math.floor(ageSec / 3600)}h`;
}

function activityTimestampMs(row) {
  const updated = normalizeInt(row?.updated_at);
  const updatedMs = normalizeEpochMs(updated);
  if (updatedMs !== null) return updatedMs;
  const created = normalizeInt(row?.created_at);
  const createdMs = normalizeEpochMs(created);
  if (createdMs !== null) return createdMs;
  return null;
}

function readTrades(dbPath, DatabaseSync) {
  if (!fs.existsSync(dbPath)) return [];

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readonly: true });
      db.exec('PRAGMA busy_timeout=1500;');
      return db
        .prepare(`
        SELECT
          trade_id,
          state,
          role,
          btc_sats,
          usdt_amount,
          tao_amount_atomic,
          sol_escrow_pda,
          tao_settlement_id,
          tao_lock_tx_id,
          sol_refund_after_unix,
          tao_refund_after_unix,
          created_at,
          updated_at
        FROM trades
          ORDER BY COALESCE(updated_at, created_at, 0) DESC
        `)
        .all();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err || '').toLowerCase();
      if (!msg.includes('database is locked') || attempt >= 2) break;
      sleepMs(150 * (attempt + 1));
    } finally {
      try {
        db?.close();
      } catch (_e) {}
    }
  }

  throw lastErr;
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

function mergeValue(values, predicate = (value) => value !== null && value !== undefined && String(value).trim() !== '') {
  for (const value of values) {
    if (predicate(value)) return value;
  }
  return null;
}

function buildGroupedTrades(rows, nowMs) {
  const byTradeId = new Map();
  const nowUnix = Math.floor(nowMs / 1000);

  for (const row of rows) {
    const tradeId = String(row?.trade_id || '').trim();
    if (!tradeId) continue;

    const role = String(row?.role || '').trim().toLowerCase();
    const existing = byTradeId.get(tradeId) || {
      trade_id: tradeId,
      maker: null,
      taker: null,
      other: [],
    };

    if (role === 'maker') existing.maker = row;
    else if (role === 'taker') existing.taker = row;
    else existing.other.push(row);

    byTradeId.set(tradeId, existing);
  }

  const out = [];
  for (const grouped of byTradeId.values()) {
    const fallbackRows = [
      grouped.maker,
      grouped.taker,
      ...grouped.other,
    ].filter(Boolean);

    const makerState = normalizeState(grouped.maker?.state);
    const takerState = normalizeState(grouped.taker?.state);
    const makerTerminal = grouped.maker ? isTerminalState(grouped.maker?.state) : false;
    const takerTerminal = grouped.taker ? isTerminalState(grouped.taker?.state) : false;

    const btcSats = mergeValue(
      fallbackRows.map((row) => normalizeInt(row?.btc_sats)),
      (value) => typeof value === 'number' && Number.isFinite(value)
    );

    const taoAmountAtomic = mergeValue(
      fallbackRows.map((row) => normalizeAtomic(row?.tao_amount_atomic)),
      (value) => Boolean(value)
    );

    const makerRefundAfterUnix = grouped.maker ? effectiveRefundAfterUnix(grouped.maker) : null;
    const takerRefundAfterUnix = grouped.taker ? effectiveRefundAfterUnix(grouped.taker) : null;
    const anyRefundReached =
      (makerState.toLowerCase() === 'escrow' && makerRefundAfterUnix !== null && makerRefundAfterUnix <= nowUnix) ||
      (takerState.toLowerCase() === 'escrow' && takerRefundAfterUnix !== null && takerRefundAfterUnix <= nowUnix);

    const anyClaimed =
      makerState.toLowerCase() === 'claimed' ||
      takerState.toLowerCase() === 'claimed';
    const anyLnPaid = makerState.toLowerCase() === 'ln_paid' || takerState.toLowerCase() === 'ln_paid';
    const anyRefunded =
      makerState.toLowerCase() === 'refunded' ||
      takerState.toLowerCase() === 'refunded';
    const makerInEscrow = makerState.toLowerCase() === 'escrow';
    const bothPresent = Boolean(grouped.maker && grouped.taker);
    const bothTerminal = bothPresent && makerTerminal && takerTerminal;
    const hasLockEvidence = Boolean(
      String(
        grouped.maker?.tao_lock_tx_id ||
        grouped.taker?.tao_lock_tx_id ||
        grouped.maker?.tao_settlement_id ||
        grouped.taker?.tao_settlement_id ||
        grouped.maker?.sol_escrow_pda ||
        grouped.taker?.sol_escrow_pda ||
        ''
      ).trim()
    );
    const partial =
      !bothPresent ||
      btcSats === null ||
      !taoAmountAtomic ||
      makerState === '-' ||
      takerState === '-';

    let overallAction = 'wait';
    let inspectReason = '';
    if (bothTerminal) overallAction = 'done';
    else if (anyClaimed && anyRefundReached) {
      overallAction = 'inspect';
      inspectReason = 'claimed + refund window overlap';
    }
    else if (anyRefunded && (makerState.toLowerCase() === 'escrow' || takerState.toLowerCase() === 'escrow')) {
      overallAction = 'inspect';
      inspectReason = 'refunded + escrow conflict';
    }
    else if (
      (makerState.toLowerCase() === 'refunded' || takerState.toLowerCase() === 'refunded') &&
      anyLnPaid
    ) {
      overallAction = 'inspect';
      inspectReason = 'refunded + ln_paid conflict';
    } else if (anyClaimed) overallAction = 'done';
    else if (anyLnPaid && !anyClaimed) overallAction = 'claim';
    else if (makerInEscrow && anyRefundReached && !anyClaimed && hasLockEvidence) overallAction = 'refund';
    else if (anyRefundReached && !anyClaimed) {
      overallAction = 'inspect';
      inspectReason = 'missing lock evidence';
    } else if (partial) {
      overallAction = 'inspect';
      inspectReason = 'partial state';
    }

    const sortTs = fallbackRows
      .map((row) => activityTimestampMs(row))
      .filter((ts) => ts !== null)
      .sort((a, b) => b - a)[0] ?? null;
    const hint =
      overallAction === 'refund'
        ? `swaprecover.mjs refund --trade-id ${grouped.trade_id} --settlement tao-evm`
        : overallAction === 'claim'
          ? `swaprecover.mjs claim --trade-id ${grouped.trade_id}`
          : '';

    out.push({
      trade_id: grouped.trade_id,
      maker_state: makerState,
      taker_state: takerState,
      btc_sats: btcSats,
      tao_amount_atomic: taoAmountAtomic,
      action: overallAction,
      reason: inspectReason,
      hint,
      age: formatAgeFromEpochMs(sortTs, nowMs),
      sort_ts: sortTs,
    });
  }

  out.sort((a, b) => (b.sort_ts ?? -1) - (a.sort_ts ?? -1));
  return out;
}

function filterTrades(rows, filters) {
  if (filters.claimable) return rows.filter((row) => row.action === 'claim');
  if (filters.refundable) return rows.filter((row) => row.action === 'refund');
  if (filters.actionable) return rows.filter((row) => row.action === 'claim' || row.action === 'refund' || row.action === 'inspect');
  if (filters.active) return rows.filter((row) => row.action !== 'done');
  return rows;
}

function pad(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s : s.padEnd(width, ' ');
}

function printTable(rows) {
  const headers = ['TRADE_ID', 'MAKER_STATE', 'TAKER_STATE', 'BTC_SATS', 'TAO_AMOUNT', 'ACTION', 'AGE', 'REASON', 'HINT'];
  const tableRows = rows.map((row) => ({
    TRADE_ID: normalizeText(row.trade_id),
    MAKER_STATE: normalizeText(row.maker_state),
    TAKER_STATE: normalizeText(row.taker_state),
    BTC_SATS: row.btc_sats === null ? '-' : String(row.btc_sats),
    TAO_AMOUNT: displayTaoAmount(row.tao_amount_atomic),
    ACTION: normalizeText(row.action),
    AGE: normalizeText(row.age),
    REASON: normalizeText(row.reason),
    HINT: normalizeText(row.hint),
  }));

  const widths = Object.fromEntries(
    headers.map((header) => [
      header,
      Math.max(header.length, ...tableRows.map((row) => String(row[header] ?? '').length)),
    ])
  );

  const headerLine = headers.map((header) => pad(header, widths[header])).join('  ');
  const dividerLine = headers.map((header) => '-'.repeat(widths[header])).join('  ');

  process.stdout.write(`${headerLine}\n`);
  process.stdout.write(`${dividerLine}\n`);
  for (const row of tableRows) {
    const line = headers.map((header) => pad(row[header], widths[header])).join('  ');
    process.stdout.write(`${line}\n`);
  }
}

function printSummary(allRows, visibleRows) {
  const counts = {
    total: allRows.length,
    active: allRows.filter((row) => row.action !== 'done').length,
    claimable: allRows.filter((row) => row.action === 'claim').length,
    refundable: allRows.filter((row) => row.action === 'refund').length,
    inspect: allRows.filter((row) => row.action === 'inspect').length,
    inspect_claim_conflict: allRows.filter((row) => row.action === 'inspect' && row.reason === 'claimed + refund window overlap').length,
    inspect_refund_conflict: allRows.filter((row) => row.action === 'inspect' && (row.reason === 'refunded + ln_paid conflict' || row.reason === 'refunded + escrow conflict')).length,
    inspect_missing_data: allRows.filter((row) => row.action === 'inspect' && (row.reason === 'missing lock evidence' || row.reason === 'partial state')).length,
    shown: visibleRows.length,
  };

  process.stdout.write('\n');
  process.stdout.write(`total trades: ${counts.total}\n`);
  process.stdout.write(`shown: ${counts.shown}\n`);
  process.stdout.write(`active: ${counts.active}\n`);
  process.stdout.write(`claimable: ${counts.claimable}\n`);
  process.stdout.write(`refundable: ${counts.refundable}\n`);
  process.stdout.write(`inspect: ${counts.inspect}\n`);
  process.stdout.write(`inspect_claim_conflict: ${counts.inspect_claim_conflict}\n`);
  process.stdout.write(`inspect_refund_conflict: ${counts.inspect_refund_conflict}\n`);
  process.stdout.write(`inspect_missing_data: ${counts.inspect_missing_data}\n`);
}

async function main() {
  const filters = parseArgs(process.argv);
  const { DatabaseSync } = await loadSqlite();
  const nowMs = Date.now();
  const sourceRows = RECEIPTS_DBS.flatMap((dbPath) => readTrades(dbPath, DatabaseSync));
  const groupedRows = buildGroupedTrades(sourceRows, nowMs);
  const visibleRows = filterTrades(groupedRows, filters);

  printTable(visibleRows);
  printSummary(groupedRows, visibleRows);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`swap-dashboard error: ${err?.message || String(err)}\n`);
  process.exitCode = 1;
}
