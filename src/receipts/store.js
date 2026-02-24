// Node-only local trade receipt store.
//
// IMPORTANT:
// - This is intentionally NOT implemented as a trac-peer feature / contract storage.
// - It must remain local-only (no replication), and it must live under `onchain/` (gitignored).
//
// This uses Node's built-in experimental SQLite module to avoid native deps.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { stableStringify } from '../util/stableStringify.js';

const SCHEMA_VERSION = 4;

const LEGACY_RFV_CHANNEL_COL = ['o', 't', 'c'].join('') + '_channel';

function readSchemaVersion(db) {
  try {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
    if (!row) return null;
    const n = Number.parseInt(String(row.v), 10);
    return Number.isFinite(n) ? n : null;
  } catch (_e) {
    return null;
  }
}

function writeSchemaVersion(db, version) {
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(
    'schema_version',
    String(version)
  );
}

function listTradeColumns(db) {
  const cols = new Set();
  try {
    // { cid, name, type, notnull, dflt_value, pk }
    for (const row of db.prepare('PRAGMA table_info(trades)').all()) {
      if (row?.name) cols.add(String(row.name));
    }
  } catch (_e) {}
  return cols;
}

function listListingLockColumns(db) {
  const cols = new Set();
  try {
    for (const row of db.prepare('PRAGMA table_info(listing_locks)').all()) {
      if (row?.name) cols.add(String(row.name));
    }
  } catch (_e) {}
  return cols;
}

function ensureListingLocksTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_locks(
      listing_key TEXT PRIMARY KEY,
      listing_type TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      trade_id TEXT,
      state TEXT NOT NULL,
      note TEXT,
      meta_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listing_locks_trade ON listing_locks(trade_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listing_locks_state ON listing_locks(state, updated_at DESC);
  `);
}

function ensureTradeSettlementColumns(db) {
  const cols = listTradeColumns(db);
  const addText = [
    'settlement_kind',
    'tao_settlement_id',
    'tao_htlc_address',
    'tao_amount_atomic',
    'tao_recipient',
    'tao_refund',
    'tao_lock_tx_id',
    'tao_claim_tx_id',
    'tao_refund_tx_id',
  ];
  for (const col of addText) {
    if (cols.has(col)) continue;
    db.exec(`ALTER TABLE trades ADD COLUMN ${col} TEXT;`);
    cols.add(col);
  }
  if (!cols.has('tao_refund_after_unix')) {
    db.exec('ALTER TABLE trades ADD COLUMN tao_refund_after_unix INTEGER;');
    cols.add('tao_refund_after_unix');
  }
}

function migrateSchema(db) {
  let current = readSchemaVersion(db);
  if (current === null) {
    writeSchemaVersion(db, SCHEMA_VERSION);
    return;
  }

  if (current === 1) {
    // v1 -> v2: rename legacy trades channel column -> trades.rfq_channel
    const cols = listTradeColumns(db);
    if (cols.has(LEGACY_RFV_CHANNEL_COL) && !cols.has('rfq_channel')) {
      db.exec(`ALTER TABLE trades RENAME COLUMN ${LEGACY_RFV_CHANNEL_COL} TO rfq_channel;`);
    }
    current = 2;
    writeSchemaVersion(db, current);
  }

  if (current === 2) {
    // v2 -> v3: add listing_locks table for deterministic listing lifecycle guards.
    ensureListingLocksTable(db);
    current = 3;
    writeSchemaVersion(db, current);
  }

  if (current === 3) {
    // v3 -> v4: settlement-aware receipt fields for TAO EVM parity.
    ensureTradeSettlementColumns(db);
    current = 4;
    writeSchemaVersion(db, current);
  }

  if (current === SCHEMA_VERSION) {
    ensureTradeSettlementColumns(db);
    if (!listListingLockColumns(db).has('listing_key')) {
      ensureListingLocksTable(db);
    }
    return;
  }

  throw new Error(`Unsupported receipts schema_version=${current} (expected ${SCHEMA_VERSION})`);
}

function nowMs() {
  return Date.now();
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function resolveDbPath(dbPath) {
  if (!isNonEmptyString(dbPath)) throw new Error('receipts dbPath is required');
  const p = dbPath.trim();
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function coerceText(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return String(v);
}

function coerceInt(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid int: ${v}`);
  return Math.trunc(n);
}

function coerceHex32(v, label) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`${label} must be 32-byte hex`);
  return s;
}

function coerceJson(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string') return v;
  return stableStringify(v);
}

function mapRow(row) {
  if (!row) return null;
  return {
    trade_id: row.trade_id,
    role: row.role,
    rfq_channel: row.rfq_channel,
    swap_channel: row.swap_channel,
    maker_peer: row.maker_peer,
    taker_peer: row.taker_peer,

    btc_sats: row.btc_sats,
    usdt_amount: row.usdt_amount,

    sol_mint: row.sol_mint,
    sol_program_id: row.sol_program_id,
    sol_recipient: row.sol_recipient,
    sol_refund: row.sol_refund,
    sol_escrow_pda: row.sol_escrow_pda,
    sol_vault_ata: row.sol_vault_ata,
    sol_refund_after_unix: row.sol_refund_after_unix,
    settlement_kind: row.settlement_kind,
    tao_settlement_id: row.tao_settlement_id,
    tao_htlc_address: row.tao_htlc_address,
    tao_amount_atomic: row.tao_amount_atomic,
    tao_recipient: row.tao_recipient,
    tao_refund: row.tao_refund,
    tao_refund_after_unix: row.tao_refund_after_unix,
    tao_lock_tx_id: row.tao_lock_tx_id,
    tao_claim_tx_id: row.tao_claim_tx_id,
    tao_refund_tx_id: row.tao_refund_tx_id,

    ln_invoice_bolt11: row.ln_invoice_bolt11,
    ln_payment_hash_hex: row.ln_payment_hash_hex,
    ln_preimage_hex: row.ln_preimage_hex,

    state: row.state,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_error: row.last_error,
  };
}

function mapListingLockRow(row) {
  if (!row) return null;
  return {
    listing_key: row.listing_key,
    listing_type: row.listing_type,
    listing_id: row.listing_id,
    trade_id: row.trade_id,
    state: row.state,
    note: row.note,
    meta_json: row.meta_json,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class TradeReceiptsStore {
  constructor(db, dbPath) {
    this.db = db;
    this.dbPath = dbPath;

    this._stmtGetMeta = db.prepare('SELECT v FROM meta WHERE k = ?');
    this._stmtSetMeta = db.prepare(
      'INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
    );

    this._stmtGetTrade = db.prepare('SELECT * FROM trades WHERE trade_id = ?');
    this._stmtGetTradeByPaymentHash = db.prepare('SELECT * FROM trades WHERE ln_payment_hash_hex = ?');
    this._stmtListTrades = db.prepare('SELECT * FROM trades ORDER BY updated_at DESC LIMIT ? OFFSET ?');
    this._stmtListOpenClaims = db.prepare(
      'SELECT * FROM trades WHERE state = ? AND ln_preimage_hex IS NOT NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    );
    this._stmtListOpenRefunds = db.prepare(
      `SELECT * FROM trades
       WHERE state = ?
         AND (
           ((settlement_kind IS NULL OR settlement_kind = '' OR settlement_kind = 'solana')
             AND sol_refund_after_unix IS NOT NULL
             AND sol_refund_after_unix <= ?)
           OR
           (settlement_kind = 'tao-evm'
             AND tao_refund_after_unix IS NOT NULL
             AND tao_refund_after_unix <= ?)
         )
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    );

    this._stmtInsertEvent = db.prepare(
      'INSERT INTO events(trade_id, ts, kind, payload_json) VALUES(?, ?, ?, ?)'
    );

    this._stmtGetListingLock = db.prepare('SELECT * FROM listing_locks WHERE listing_key = ?');
    this._stmtListListingLocksByTrade = db.prepare(
      'SELECT * FROM listing_locks WHERE trade_id = ? ORDER BY updated_at DESC LIMIT ?'
    );
    this._stmtDeleteListingLock = db.prepare('DELETE FROM listing_locks WHERE listing_key = ?');
    this._stmtDeleteListingLocksByTrade = db.prepare('DELETE FROM listing_locks WHERE trade_id = ?');
    this._stmtUpsertListingLock = db.prepare(`
      INSERT INTO listing_locks(
        listing_key, listing_type, listing_id, trade_id, state, note, meta_json, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(listing_key) DO UPDATE SET
        listing_type=excluded.listing_type,
        listing_id=excluded.listing_id,
        trade_id=excluded.trade_id,
        state=excluded.state,
        note=excluded.note,
        meta_json=excluded.meta_json,
        created_at=listing_locks.created_at,
        updated_at=excluded.updated_at
    `);

    // Full-row upsert (we merge with existing first, then write the full row).
    this._stmtUpsertTrade = db.prepare(`
      INSERT INTO trades(
        trade_id, role, rfq_channel, swap_channel, maker_peer, taker_peer,
        btc_sats, usdt_amount,
        sol_mint, sol_program_id, sol_recipient, sol_refund, sol_escrow_pda, sol_vault_ata, sol_refund_after_unix,
        settlement_kind, tao_settlement_id, tao_htlc_address, tao_amount_atomic, tao_recipient, tao_refund, tao_refund_after_unix, tao_lock_tx_id, tao_claim_tx_id, tao_refund_tx_id,
        ln_invoice_bolt11, ln_payment_hash_hex, ln_preimage_hex,
        state, created_at, updated_at, last_error
      )
      VALUES(
        ?, ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(trade_id) DO UPDATE SET
        role=excluded.role,
        rfq_channel=excluded.rfq_channel,
        swap_channel=excluded.swap_channel,
        maker_peer=excluded.maker_peer,
        taker_peer=excluded.taker_peer,
        btc_sats=excluded.btc_sats,
        usdt_amount=excluded.usdt_amount,
        sol_mint=excluded.sol_mint,
        sol_program_id=excluded.sol_program_id,
        sol_recipient=excluded.sol_recipient,
        sol_refund=excluded.sol_refund,
        sol_escrow_pda=excluded.sol_escrow_pda,
        sol_vault_ata=excluded.sol_vault_ata,
        sol_refund_after_unix=excluded.sol_refund_after_unix,
        settlement_kind=excluded.settlement_kind,
        tao_settlement_id=excluded.tao_settlement_id,
        tao_htlc_address=excluded.tao_htlc_address,
        tao_amount_atomic=excluded.tao_amount_atomic,
        tao_recipient=excluded.tao_recipient,
        tao_refund=excluded.tao_refund,
        tao_refund_after_unix=excluded.tao_refund_after_unix,
        tao_lock_tx_id=excluded.tao_lock_tx_id,
        tao_claim_tx_id=excluded.tao_claim_tx_id,
        tao_refund_tx_id=excluded.tao_refund_tx_id,
        ln_invoice_bolt11=excluded.ln_invoice_bolt11,
        ln_payment_hash_hex=excluded.ln_payment_hash_hex,
        ln_preimage_hex=excluded.ln_preimage_hex,
        state=excluded.state,
        created_at=trades.created_at,
        updated_at=excluded.updated_at,
        last_error=excluded.last_error
    `);
  }

  static open({ dbPath }) {
    const resolved = resolveDbPath(dbPath);
    mkdirp(path.dirname(resolved));

    const db = new DatabaseSync(resolved);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('PRAGMA synchronous=NORMAL;');

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta(
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades(
        trade_id TEXT PRIMARY KEY,
        role TEXT,
        rfq_channel TEXT,
        swap_channel TEXT,
        maker_peer TEXT,
        taker_peer TEXT,

        btc_sats INTEGER,
        usdt_amount TEXT,

        sol_mint TEXT,
        sol_program_id TEXT,
        sol_recipient TEXT,
        sol_refund TEXT,
        sol_escrow_pda TEXT,
        sol_vault_ata TEXT,
        sol_refund_after_unix INTEGER,
        settlement_kind TEXT,
        tao_settlement_id TEXT,
        tao_htlc_address TEXT,
        tao_amount_atomic TEXT,
        tao_recipient TEXT,
        tao_refund TEXT,
        tao_refund_after_unix INTEGER,
        tao_lock_tx_id TEXT,
        tao_claim_tx_id TEXT,
        tao_refund_tx_id TEXT,

        ln_invoice_bolt11 TEXT,
        ln_payment_hash_hex TEXT,
        ln_preimage_hex TEXT,

        state TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_trades_payment_hash ON trades(ln_payment_hash_hex);

      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_trade_ts ON events(trade_id, ts);
    `);

    ensureListingLocksTable(db);

    migrateSchema(db);
    return new TradeReceiptsStore(db, resolved);
  }

  close() {
    try {
      this.db.close();
    } catch (_e) {}
  }

  getTrade(tradeId) {
    const id = String(tradeId || '').trim();
    if (!id) throw new Error('tradeId is required');
    return mapRow(this._stmtGetTrade.get(id));
  }

  getTradeByPaymentHash(paymentHashHex) {
    const hex = coerceHex32(paymentHashHex, 'paymentHashHex');
    return mapRow(this._stmtGetTradeByPaymentHash.get(hex));
  }

  listTrades({ limit = 50 } = {}) {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 50;
    return this._stmtListTrades.all(n, 0).map(mapRow);
  }

  listTradesPaged({ limit = 50, offset = 0 } = {}) {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 50;
    const off = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    return this._stmtListTrades.all(n, off).map(mapRow);
  }

  listOpenClaims({ limit = 50, offset = 0, state = 'ln_paid' } = {}) {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 50;
    const off = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const st = String(state || '').trim() || 'ln_paid';
    return this._stmtListOpenClaims.all(st, n, off).map(mapRow);
  }

  listOpenRefunds({ nowUnix = null, limit = 50, offset = 0, state = 'escrow' } = {}) {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 50;
    const off = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const st = String(state || '').trim() || 'escrow';
    const now = nowUnix === null || nowUnix === undefined ? Math.floor(Date.now() / 1000) : coerceInt(nowUnix);
    return this._stmtListOpenRefunds.all(st, now, now, n, off).map(mapRow);
  }

  upsertTrade(tradeId, patch = {}) {
    const id = String(tradeId || '').trim();
    if (!id) throw new Error('tradeId is required');
    const existing = this.getTrade(id);
    const base = existing || { trade_id: id, created_at: nowMs(), updated_at: nowMs() };

    // Apply patch only for provided keys (undefined means "no change").
    const next = { ...base, updated_at: nowMs() };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined) continue;
      next[k] = v;
    }

    // Coerce/normalize.
    const row = {
      trade_id: id,
      role: coerceText(next.role),
      rfq_channel: coerceText(next.rfq_channel),
      swap_channel: coerceText(next.swap_channel),
      maker_peer: coerceText(next.maker_peer),
      taker_peer: coerceText(next.taker_peer),
      btc_sats: next.btc_sats === undefined ? undefined : coerceInt(next.btc_sats),
      usdt_amount: coerceText(next.usdt_amount),
      sol_mint: coerceText(next.sol_mint),
      sol_program_id: coerceText(next.sol_program_id),
      sol_recipient: coerceText(next.sol_recipient),
      sol_refund: coerceText(next.sol_refund),
      sol_escrow_pda: coerceText(next.sol_escrow_pda),
      sol_vault_ata: coerceText(next.sol_vault_ata),
      sol_refund_after_unix:
        next.sol_refund_after_unix === undefined ? undefined : coerceInt(next.sol_refund_after_unix),
      settlement_kind: coerceText(next.settlement_kind),
      tao_settlement_id: coerceText(next.tao_settlement_id),
      tao_htlc_address: coerceText(next.tao_htlc_address),
      tao_amount_atomic: coerceText(next.tao_amount_atomic),
      tao_recipient: coerceText(next.tao_recipient),
      tao_refund: coerceText(next.tao_refund),
      tao_refund_after_unix:
        next.tao_refund_after_unix === undefined ? undefined : coerceInt(next.tao_refund_after_unix),
      tao_lock_tx_id: coerceText(next.tao_lock_tx_id),
      tao_claim_tx_id: coerceText(next.tao_claim_tx_id),
      tao_refund_tx_id: coerceText(next.tao_refund_tx_id),
      ln_invoice_bolt11: coerceText(next.ln_invoice_bolt11),
      ln_payment_hash_hex:
        next.ln_payment_hash_hex === undefined ? undefined : coerceHex32(next.ln_payment_hash_hex, 'ln_payment_hash_hex'),
      ln_preimage_hex:
        next.ln_preimage_hex === undefined ? undefined : coerceHex32(next.ln_preimage_hex, 'ln_preimage_hex'),
      state: coerceText(next.state),
      created_at: coerceInt(next.created_at),
      updated_at: coerceInt(next.updated_at),
      last_error: coerceText(next.last_error),
    };

    // Node's SQLite bindings reject `undefined`. Store missing fields as NULL.
    for (const k of Object.keys(row)) {
      if (row[k] === undefined) row[k] = null;
    }

    this._stmtUpsertTrade.run(
      row.trade_id,
      row.role,
      row.rfq_channel,
      row.swap_channel,
      row.maker_peer,
      row.taker_peer,
      row.btc_sats,
      row.usdt_amount,
      row.sol_mint,
      row.sol_program_id,
      row.sol_recipient,
      row.sol_refund,
      row.sol_escrow_pda,
      row.sol_vault_ata,
      row.sol_refund_after_unix,
      row.settlement_kind,
      row.tao_settlement_id,
      row.tao_htlc_address,
      row.tao_amount_atomic,
      row.tao_recipient,
      row.tao_refund,
      row.tao_refund_after_unix,
      row.tao_lock_tx_id,
      row.tao_claim_tx_id,
      row.tao_refund_tx_id,
      row.ln_invoice_bolt11,
      row.ln_payment_hash_hex,
      row.ln_preimage_hex,
      row.state,
      row.created_at,
      row.updated_at,
      row.last_error
    );

    return this.getTrade(id);
  }

  appendEvent(tradeId, kind, payload = null, { ts = null } = {}) {
    const id = String(tradeId || '').trim();
    if (!id) throw new Error('tradeId is required');
    const k = String(kind || '').trim();
    if (!k) throw new Error('event kind is required');
    const t = ts === null || ts === undefined ? nowMs() : coerceInt(ts);
    const payloadJson = payload === null || payload === undefined ? null : coerceJson(payload);
    this._stmtInsertEvent.run(id, t, k, payloadJson);
  }

  getListingLock(listingKey) {
    const key = String(listingKey || '').trim();
    if (!key) throw new Error('listingKey is required');
    return mapListingLockRow(this._stmtGetListingLock.get(key));
  }

  listListingLocksByTrade(tradeId, { limit = 500 } = {}) {
    const id = String(tradeId || '').trim();
    if (!id) throw new Error('tradeId is required');
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(2000, Math.trunc(limit))) : 500;
    return this._stmtListListingLocksByTrade.all(id, n).map(mapListingLockRow);
  }

  upsertListingLock(listingKey, patch = {}) {
    const key = String(listingKey || '').trim();
    if (!key) throw new Error('listingKey is required');
    const existing = this.getListingLock(key);
    const base = existing || { listing_key: key, created_at: nowMs(), updated_at: nowMs() };
    const next = { ...base, updated_at: nowMs() };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined) continue;
      next[k] = v;
    }
    const state = String(next.state || '').trim().toLowerCase();
    if (state !== 'in_flight' && state !== 'filled') {
      throw new Error('listing lock state must be in_flight or filled');
    }
    const row = {
      listing_key: key,
      listing_type: coerceText(next.listing_type),
      listing_id: coerceText(next.listing_id),
      trade_id: coerceText(next.trade_id),
      state,
      note: coerceText(next.note),
      meta_json: coerceJson(next.meta_json),
      created_at: coerceInt(next.created_at),
      updated_at: coerceInt(next.updated_at),
    };
    if (!isNonEmptyString(row.listing_type)) throw new Error('listing_type is required');
    if (!isNonEmptyString(row.listing_id)) throw new Error('listing_id is required');
    for (const k of Object.keys(row)) {
      if (row[k] === undefined) row[k] = null;
    }
    this._stmtUpsertListingLock.run(
      row.listing_key,
      row.listing_type,
      row.listing_id,
      row.trade_id,
      row.state,
      row.note,
      row.meta_json,
      row.created_at,
      row.updated_at
    );
    return this.getListingLock(key);
  }

  deleteListingLock(listingKey) {
    const key = String(listingKey || '').trim();
    if (!key) throw new Error('listingKey is required');
    this._stmtDeleteListingLock.run(key);
  }

  deleteListingLocksByTrade(tradeId) {
    const id = String(tradeId || '').trim();
    if (!id) throw new Error('tradeId is required');
    this._stmtDeleteListingLocksByTrade.run(id);
  }
}

export function openTradeReceiptsStore({ dbPath }) {
  return TradeReceiptsStore.open({ dbPath });
}
