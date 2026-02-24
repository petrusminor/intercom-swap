#!/usr/bin/env node
import process from 'node:process';

import {
  getSettlementProvider,
  normalizeSettlementKind,
  SETTLEMENT_KIND,
  SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID,
} from '../settlement/providerFactory.js';
import { openTradeReceiptsStore } from '../src/receipts/store.js';

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
swaprecover (local-only recovery + receipts)

Commands:
  list --receipts-db <path> [--limit <n>]
  show --receipts-db <path> (--trade-id <id> | --payment-hash <hex32>)
  status --receipts-db <path> (--trade-id <id> | --payment-hash <hex32>) [--settlement <solana|tao-evm>]
  inspect --receipts-db <path> (--trade-id <id> | --payment-hash <hex32>) [--settlement <solana|tao-evm>]
  claim --receipts-db <path> (--trade-id <id> | --payment-hash <hex32>) [--settlement <solana|tao-evm>] [--solana-rpc-url <url[,url2,...]> --solana-keypair <path> [--commitment <confirmed|finalized|processed>] [--solana-cu-limit <units>] [--solana-cu-price <microLamports>]]
  refund --receipts-db <path> (--trade-id <id> | --payment-hash <hex32>) [--settlement <solana|tao-evm>] [--solana-rpc-url <url[,url2,...]> --solana-keypair <path> [--commitment <confirmed|finalized|processed>] [--solana-cu-limit <units>] [--solana-cu-price <microLamports>]]

Notes:
  - Receipts DB should live under onchain/ (gitignored).
  - claim requires ln_preimage_hex to be present in the receipt.
  - settlement defaults to solana when --settlement is omitted.
  - TAO mode uses TAO_EVM_* environment variables (private key is never printed).
`.trim();
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function normalizeHex32(value, label) {
  const hex = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) die(`${label} must be 32-byte hex`);
  return hex;
}

function parsePosIntOrNull(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) die(`Invalid --${label}`);
  return n;
}

function pickTrade(store, { tradeId, paymentHashHex }) {
  if (tradeId) {
    const t = store.getTrade(tradeId);
    if (!t) die(`Trade not found: trade_id=${tradeId}`);
    return t;
  }
  if (paymentHashHex) {
    const t = store.getTradeByPaymentHash(paymentHashHex);
    if (!t) die(`Trade not found for payment_hash=${paymentHashHex}`);
    return t;
  }
  die('Missing --trade-id or --payment-hash');
}

function readRequestedSettlementKind(flags) {
  return normalizeSettlementKind(flags.get('settlement') || SETTLEMENT_KIND.SOLANA);
}

function resolveEffectiveSettlementKind(trade, requestedKind) {
  const raw = String(trade?.settlement_kind || '').trim();
  if (!raw) return requestedKind;
  let fromTrade;
  try {
    fromTrade = normalizeSettlementKind(raw);
  } catch (_e) {
    return requestedKind;
  }
  if (fromTrade !== requestedKind) {
    die(
      `Trade settlement_kind=${fromTrade} differs from --settlement=${requestedKind}; rerun with --settlement ${fromTrade}`
    );
  }
  return fromTrade;
}

function getSettlementIdForTrade(trade, settlementKind) {
  if (settlementKind === SETTLEMENT_KIND.TAO_EVM) {
    const id = String(trade?.tao_settlement_id || '').trim();
    if (!id) die('Trade missing tao_settlement_id');
    return id;
  }
  const id = String(trade?.sol_escrow_pda || '').trim();
  if (!id) die('Trade missing sol_escrow_pda');
  return id;
}

function buildSettlementProvider({ settlementKind, flags, trade, command = '' }) {
  const cmd = String(command || '').trim().toLowerCase();
  const statusHint =
    cmd === 'status' || cmd === 'inspect'
      ? ' (status/inspect currently use the same provider path and require signer config)'
      : '';

  if (settlementKind === SETTLEMENT_KIND.TAO_EVM) {
    const taoChainId = parsePosIntOrNull(process.env.TAO_EVM_CHAIN_ID, 'TAO_EVM_CHAIN_ID') || 964;
    const taoConfirmations =
      parsePosIntOrNull(process.env.TAO_EVM_CONFIRMATIONS, 'TAO_EVM_CONFIRMATIONS') || 1;
    const taoHtlcAddress =
      String(trade?.tao_htlc_address || process.env.TAO_EVM_HTLC_ADDRESS || '').trim();
    const taoPrivateKey = String(process.env.TAO_EVM_PRIVATE_KEY || '').trim();
    if (!taoPrivateKey) {
      die(`Missing TAO_EVM_PRIVATE_KEY${statusHint}`);
    }
    return getSettlementProvider(settlementKind, {
      taoEvm: {
        rpcUrl: process.env.TAO_EVM_RPC_URL || 'https://lite.chain.opentensor.ai',
        chainId: taoChainId,
        privateKey: taoPrivateKey,
        confirmations: taoConfirmations,
        htlcAddress: taoHtlcAddress,
      },
    });
  }

  const rpcUrl = flags.get('solana-rpc-url');
  if (!rpcUrl || rpcUrl === true) die(`Missing --solana-rpc-url${statusHint}`);
  const keyPath = flags.get('solana-keypair');
  if (!keyPath || keyPath === true) die(`Missing --solana-keypair${statusHint}`);
  const commitment = flags.get('commitment') ? String(flags.get('commitment')).trim() : 'confirmed';
  const computeUnitLimit = parsePosIntOrNull(flags.get('solana-cu-limit'), 'solana-cu-limit');
  const computeUnitPriceMicroLamports = parsePosIntOrNull(flags.get('solana-cu-price'), 'solana-cu-price');
  const programId =
    String(trade?.sol_program_id || flags.get('solana-program-id') || SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID).trim() ||
    SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID;
  const mint = String(trade?.sol_mint || flags.get('solana-mint') || '').trim();

  return getSettlementProvider(settlementKind, {
    solana: {
      rpcUrls: String(rpcUrl),
      commitment,
      keypairPath: String(keyPath),
      mint,
      programId,
      computeUnitLimit,
      computeUnitPriceMicroLamports,
    },
  });
}

function eqLowerTrim(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function pickExpectedState({ settlementKind, verifyPrePay, trade }) {
  if (verifyPrePay?.ok) return 'active';

  const receiptState = String(trade?.state || '').trim().toLowerCase();
  if (receiptState === 'claimed' || receiptState === 'refunded' || receiptState === 'canceled') return receiptState;

  if (settlementKind === SETTLEMENT_KIND.TAO_EVM) {
    if (trade?.tao_claim_tx_id) return 'claimed';
    if (trade?.tao_refund_tx_id) return 'refunded';
    return 'closed_or_missing';
  }

  return 'inactive_or_missing';
}

function maybeBuildVerifySwapInput({ settlementKind, settlementId, paymentHashHex, trade }) {
  if (settlementKind === SETTLEMENT_KIND.TAO_EVM) {
    const lockTxId = String(trade?.tao_lock_tx_id || '').trim();
    if (!lockTxId) return null;
    const htlcAddress = String(trade?.tao_htlc_address || '').trim();
    const amountAtomic = String(trade?.tao_amount_atomic || trade?.usdt_amount || '').trim();
    const refundAfter = Number(trade?.tao_refund_after_unix || 0);
    const recipient = String(trade?.tao_recipient || '').trim();
    const refund = String(trade?.tao_refund || '').trim();
    if (!htlcAddress || !amountAtomic || !Number.isFinite(refundAfter) || refundAfter <= 0 || !recipient || !refund) {
      return null;
    }
    return {
      terms: {
        usdt_amount: amountAtomic,
        sol_recipient: recipient,
        sol_refund: refund,
        sol_refund_after_unix: refundAfter,
      },
      invoiceBody: { payment_hash_hex: paymentHashHex },
      escrowBody: {
        payment_hash_hex: paymentHashHex,
        settlement_id: settlementId,
        htlc_address: htlcAddress,
        amount_atomic: amountAtomic,
        refund_after_unix: refundAfter,
        recipient,
        refund,
        tx_id: lockTxId,
      },
    };
  }

  return null;
}

async function runStatus({ settlement, settlementKind, trade, settlementId, paymentHashHex }) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const verifyPrePay = await settlement.verifyPrePay({
    settlementId,
    paymentHashHex,
    nowUnix,
  });

  const verifySwapInput = maybeBuildVerifySwapInput({
    settlementKind,
    settlementId,
    paymentHashHex,
    trade,
  });
  const verifySwapPrePay = verifySwapInput
    ? await settlement.verifySwapPrePayOnchain({ ...verifySwapInput, nowUnix })
    : null;

  const status = pickExpectedState({ settlementKind, verifyPrePay, trade });

  const checks = {};
  if (settlementKind === SETTLEMENT_KIND.TAO_EVM) {
    const onchain = verifySwapPrePay?.ok ? verifySwapPrePay?.onchain?.state || {} : {};
    checks.hashlock_match = verifySwapPrePay?.ok ? eqLowerTrim(onchain.hashlock, paymentHashHex) : null;
    checks.receiver_match = verifySwapPrePay?.ok ? eqLowerTrim(onchain.receiver, trade?.tao_recipient) : null;
    checks.refund_match = verifySwapPrePay?.ok ? eqLowerTrim(onchain.sender, trade?.tao_refund) : null;
    checks.amount_match =
      verifySwapPrePay?.ok && trade?.tao_amount_atomic
        ? String(onchain.amountAtomic || '') === String(trade.tao_amount_atomic)
        : null;
    checks.refund_after_match =
      verifySwapPrePay?.ok && trade?.tao_refund_after_unix
        ? Number(onchain.refundAfterUnix || 0) === Number(trade.tao_refund_after_unix)
        : null;
  } else {
    const md = verifyPrePay?.ok ? verifyPrePay?.metadata || {} : {};
    checks.hashlock_match = verifyPrePay?.ok ? eqLowerTrim(md.payment_hash_hex, paymentHashHex) : null;
    checks.receiver_match = verifyPrePay?.ok ? eqLowerTrim(md.recipient, trade?.sol_recipient) : null;
    checks.refund_match = verifyPrePay?.ok ? eqLowerTrim(md.refund, trade?.sol_refund) : null;
    checks.amount_match =
      verifyPrePay?.ok && trade?.usdt_amount ? String(md.amount_atomic || md.amount || '') === String(trade.usdt_amount) : null;
    checks.refund_after_match =
      verifyPrePay?.ok && trade?.sol_refund_after_unix
        ? Number(md.refund_after_unix || 0) === Number(trade.sol_refund_after_unix)
        : null;
  }

  return {
    type: 'status',
    trade_id: trade.trade_id,
    settlement_kind: settlementKind,
    settlement_id: settlementId,
    payment_hash_hex: paymentHashHex,
    status,
    verify_prepay: verifyPrePay,
    verify_swap_prepay: verifySwapPrePay,
    checks,
  };
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const receiptsDbPath = requireFlag(flags, 'receipts-db');
  const store = openTradeReceiptsStore({ dbPath: receiptsDbPath });
  try {
    if (cmd === 'list') {
      const limitRaw = flags.get('limit');
      const limit = limitRaw ? Math.max(1, Math.min(1000, Number.parseInt(String(limitRaw), 10))) : 50;
      const trades = store.listTrades({ limit });
      process.stdout.write(`${JSON.stringify({ type: 'list', trades }, null, 2)}\n`);
      return;
    }

    if (cmd === 'show') {
      const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')).trim() : '';
      const paymentHashHex = flags.get('payment-hash')
        ? normalizeHex32(flags.get('payment-hash'), 'payment-hash')
        : '';
      const trade = pickTrade(store, { tradeId: tradeId || null, paymentHashHex: paymentHashHex || null });
      process.stdout.write(`${JSON.stringify({ type: 'trade', trade }, null, 2)}\n`);
      return;
    }

    if (cmd === 'status' || cmd === 'inspect') {
      const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')).trim() : '';
      const paymentHashHex = flags.get('payment-hash')
        ? normalizeHex32(flags.get('payment-hash'), 'payment-hash')
        : '';
      const trade = pickTrade(store, { tradeId: tradeId || null, paymentHashHex: paymentHashHex || null });
      const requestedSettlementKind = readRequestedSettlementKind(flags);
      const settlementKind = resolveEffectiveSettlementKind(trade, requestedSettlementKind);
      const hash = normalizeHex32(trade.ln_payment_hash_hex, 'ln_payment_hash_hex');
      const settlementId = getSettlementIdForTrade(trade, settlementKind);
      const settlement = buildSettlementProvider({ settlementKind, flags, trade, command: cmd });

      const out = await runStatus({ settlement, settlementKind, trade, settlementId, paymentHashHex: hash });
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }

    if (cmd === 'claim') {
      const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')).trim() : '';
      const paymentHashHex = flags.get('payment-hash')
        ? normalizeHex32(flags.get('payment-hash'), 'payment-hash')
        : '';

      const trade = pickTrade(store, { tradeId: tradeId || null, paymentHashHex: paymentHashHex || null });
      const requestedSettlementKind = readRequestedSettlementKind(flags);
      const settlementKind = resolveEffectiveSettlementKind(trade, requestedSettlementKind);
      const hash = normalizeHex32(trade.ln_payment_hash_hex, 'ln_payment_hash_hex');
      const preimageHex = normalizeHex32(trade.ln_preimage_hex, 'ln_preimage_hex');
      const settlementId = getSettlementIdForTrade(trade, settlementKind);
      const settlement = buildSettlementProvider({ settlementKind, flags, trade, command: cmd });

      if (settlementKind === SETTLEMENT_KIND.SOLANA) {
        const signerAddress = await settlement.getSignerAddress();
        if (String(trade.sol_recipient || '').trim() && !eqLowerTrim(trade.sol_recipient, signerAddress)) {
          die(`Signer mismatch (need sol_recipient=${trade.sol_recipient})`);
        }
      }

      const verify = await settlement.verifyPrePay({
        settlementId,
        paymentHashHex: hash,
        nowUnix: Math.floor(Date.now() / 1000),
      });
      if (!verify.ok) die(`Pre-claim verify failed: ${verify.error || 'unknown error'}`);

      const claim = await settlement.claim({ settlementId, preimageHex });
      const txId = String(claim?.txId || '').trim();
      if (!txId) die('Missing txId from settlement provider claim');
      await settlement.waitForConfirmation(txId);

      if (settlementKind === SETTLEMENT_KIND.TAO_EVM) {
        store.upsertTrade(trade.trade_id, {
          state: 'claimed',
          settlement_kind: SETTLEMENT_KIND.TAO_EVM,
          ln_payment_hash_hex: hash,
          tao_settlement_id: settlementId,
          tao_claim_tx_id: txId,
        });
        store.appendEvent(trade.trade_id, 'recovery_claim', {
          payment_hash_hex: hash,
          settlement_id: settlementId,
          tx_id: txId,
        });
        process.stdout.write(
          `${JSON.stringify({ type: 'claimed', settlement_kind: settlementKind, trade_id: trade.trade_id, payment_hash_hex: hash, settlement_id: settlementId, tx_id: txId }, null, 2)}\n`
        );
        return;
      }

      store.upsertTrade(trade.trade_id, {
        state: 'claimed',
        settlement_kind: SETTLEMENT_KIND.SOLANA,
        ln_payment_hash_hex: hash,
        sol_escrow_pda: settlementId,
      });
      store.appendEvent(trade.trade_id, 'recovery_claim', {
        payment_hash_hex: hash,
        escrow_pda: settlementId,
        tx_sig: txId,
      });
      process.stdout.write(
        `${JSON.stringify({ type: 'claimed', settlement_kind: settlementKind, trade_id: trade.trade_id, payment_hash_hex: hash, escrow_pda: settlementId, tx_sig: txId }, null, 2)}\n`
      );
      return;
    }

    if (cmd === 'refund') {
      const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')).trim() : '';
      const paymentHashHex = flags.get('payment-hash')
        ? normalizeHex32(flags.get('payment-hash'), 'payment-hash')
        : '';

      const trade = pickTrade(store, { tradeId: tradeId || null, paymentHashHex: paymentHashHex || null });
      const requestedSettlementKind = readRequestedSettlementKind(flags);
      const settlementKind = resolveEffectiveSettlementKind(trade, requestedSettlementKind);
      const hash = normalizeHex32(trade.ln_payment_hash_hex, 'ln_payment_hash_hex');
      const settlementId = getSettlementIdForTrade(trade, settlementKind);
      const settlement = buildSettlementProvider({ settlementKind, flags, trade, command: cmd });

      if (settlementKind === SETTLEMENT_KIND.SOLANA) {
        const signerAddress = await settlement.getSignerAddress();
        if (String(trade.sol_refund || '').trim() && !eqLowerTrim(trade.sol_refund, signerAddress)) {
          die(`Signer mismatch (need sol_refund=${trade.sol_refund})`);
        }
      }

      const refund = await settlement.refund({ settlementId });
      const txId = String(refund?.txId || '').trim();
      if (!txId) die('Missing txId from settlement provider refund');
      await settlement.waitForConfirmation(txId);

      if (settlementKind === SETTLEMENT_KIND.TAO_EVM) {
        store.upsertTrade(trade.trade_id, {
          state: 'refunded',
          settlement_kind: SETTLEMENT_KIND.TAO_EVM,
          ln_payment_hash_hex: hash,
          tao_settlement_id: settlementId,
          tao_refund_tx_id: txId,
        });
        store.appendEvent(trade.trade_id, 'recovery_refund', {
          payment_hash_hex: hash,
          settlement_id: settlementId,
          tx_id: txId,
        });
        process.stdout.write(
          `${JSON.stringify({ type: 'refunded', settlement_kind: settlementKind, trade_id: trade.trade_id, payment_hash_hex: hash, settlement_id: settlementId, tx_id: txId }, null, 2)}\n`
        );
        return;
      }

      store.upsertTrade(trade.trade_id, {
        state: 'refunded',
        settlement_kind: SETTLEMENT_KIND.SOLANA,
        ln_payment_hash_hex: hash,
        sol_escrow_pda: settlementId,
      });
      store.appendEvent(trade.trade_id, 'recovery_refund', {
        payment_hash_hex: hash,
        escrow_pda: settlementId,
        tx_sig: txId,
      });
      process.stdout.write(
        `${JSON.stringify({ type: 'refunded', settlement_kind: settlementKind, trade_id: trade.trade_id, payment_hash_hex: hash, escrow_pda: settlementId, tx_sig: txId }, null, 2)}\n`
      );
      return;
    }

    die(`Unknown command: ${cmd}`);
  } finally {
    store.close();
  }
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
