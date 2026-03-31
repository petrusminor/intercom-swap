#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Contract, Interface, JsonRpcProvider, ZeroAddress } from 'ethers';

import { openTradeReceiptsStore } from '../src/receipts/store.js';
import { normalizeSettlementKind, SETTLEMENT_KIND } from '../settlement/providerFactory.js';

const TAO_HTLC_RECONCILE_ABI = [
  'function swaps(bytes32 swapId) view returns (address sender, address receiver, uint256 amount, uint256 refundAfter, bytes32 hashlock, bool claimed, bool refunded)',
  'event Claimed(bytes32 indexed swapId, bytes preimage)',
  'event Refunded(bytes32 indexed swapId)',
];
const TAO_HTLC_RECONCILE_IFACE = new Interface(TAO_HTLC_RECONCILE_ABI);
const TAO_CLAIMED_TOPIC = TAO_HTLC_RECONCILE_IFACE.getEvent('Claimed').topicHash;
const TAO_REFUNDED_TOPIC = TAO_HTLC_RECONCILE_IFACE.getEvent('Refunded').topicHash;

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
swapreconcile (manual local-only on-chain reconciliation)

Usage:
  reconcile --receipts-db <path> (--trade-id <id> | --payment-hash <hex32>) [--settlement <solana|tao-evm>]
            [--claim-tx-id <0x...>] [--refund-tx-id <0x...>]

Notes:
  - This tool does not send swap messages or change protocol behavior.
  - TAO reconciliation is read-only on-chain and updates local receipts only.
  - Intended for ambiguous local states such as accepted/escrow/test_stop_before_ln_pay.
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

function isEmptyTaoSwapRow(state) {
  return (
    String(state?.sender || ZeroAddress).toLowerCase() === ZeroAddress.toLowerCase() &&
    String(state?.receiver || ZeroAddress).toLowerCase() === ZeroAddress.toLowerCase() &&
    String(state?.amount || '0') === '0' &&
    Number(state?.refundAfter || 0) === 0 &&
    Boolean(state?.claimed) === false &&
    Boolean(state?.refunded) === false
  );
}

export function isEligibleForOnchainRefundReconciliation(trade) {
  const state = String(trade?.state || '').trim().toLowerCase();
  const lastError = String(trade?.last_error || '').trim().toLowerCase();
  if (state === 'refunded' || state === 'claimed' || state === 'canceled') return false;
  if (!String(trade?.tao_settlement_id || '').trim()) return false;
  if (String(trade?.ln_preimage_hex || '').trim()) return false;
  return state === 'accepted' || state === 'escrow' || lastError === 'test_stop_before_ln_pay';
}

export function isEligibleForOnchainClaimReconciliation(trade) {
  const state = String(trade?.state || '').trim().toLowerCase();
  if (state === 'refunded' || state === 'claimed' || state === 'canceled') return false;
  if (!String(trade?.tao_settlement_id || '').trim()) return false;
  return true;
}

export function classifyTaoOnchainReconciliation({ trade, onchain }) {
  const claimEligible = isEligibleForOnchainClaimReconciliation(trade);
  const refundEligible = isEligibleForOnchainRefundReconciliation(trade);
  if (onchain?.status === 'claimed') {
    if (!claimEligible) {
      return {
        eligible: false,
        shouldUpdate: false,
        reason: 'local_state_not_reconcilable',
      };
    }
    return {
      eligible: true,
      shouldUpdate: true,
      nextState: 'claimed',
      reason: 'swap_claimed_onchain',
    };
  }

  if (!refundEligible) {
    return {
      eligible: false,
      shouldUpdate: false,
      reason: 'local_state_not_reconcilable',
    };
  }

  if (onchain?.status === 'missing') {
    return {
      eligible: true,
      shouldUpdate: true,
      nextState: 'refunded',
      reason: 'swap_missing_onchain_after_lock',
    };
  }

  if (onchain?.status === 'refunded') {
    return {
      eligible: true,
      shouldUpdate: true,
      nextState: 'refunded',
      reason: 'swap_refunded_onchain',
    };
  }

  return {
    eligible: true,
    shouldUpdate: false,
    reason: 'onchain_still_active',
  };
}

export function applyOnchainSettlementReconciliation({ store, trade, onchain, nowMs = Date.now() }) {
  const decision = classifyTaoOnchainReconciliation({ trade, onchain });
  if (!decision.shouldUpdate) return decision;
  const nextState = decision.nextState;
  const patch = {
    state: nextState,
    reconciliation_source: 'onchain',
    reconciliation_ts: nowMs,
  };
  if (nextState === 'claimed' && !String(trade?.tao_claim_tx_id || '').trim() && String(onchain?.txId || '').trim()) {
    patch.tao_claim_tx_id = String(onchain.txId).trim();
  }
  if (nextState === 'refunded' && !String(trade?.tao_refund_tx_id || '').trim() && String(onchain?.txId || '').trim()) {
    patch.tao_refund_tx_id = String(onchain.txId).trim();
  }
  store.upsertTrade(trade.trade_id, patch);
  store.appendEvent(trade.trade_id, `onchain_reconcile_${nextState}`, {
    source: 'onchain',
    local_state_before: trade.state || null,
    local_last_error: trade.last_error || null,
    settlement_id: trade.tao_settlement_id || null,
    onchain_status: onchain?.status || null,
    reason: decision.reason,
    tx_id: String(onchain?.txId || '').trim() || null,
    reconciliation_ts: nowMs,
  });
  return {
    ...decision,
    updated: true,
  };
}

export function applyOnchainRefundReconciliation(args) {
  return applyOnchainSettlementReconciliation(args);
}

function compareTerminalEvidence(a, b) {
  const aBlock = Number(a?.blockNumber || 0);
  const bBlock = Number(b?.blockNumber || 0);
  if (aBlock !== bBlock) return aBlock - bBlock;
  const aIndex = Number(a?.logIndex || 0);
  const bIndex = Number(b?.logIndex || 0);
  return aIndex - bIndex;
}

async function readTaoTerminalEvidence({ provider, htlcAddress, settlementId, trade, claimTxId = '', refundTxId = '' }) {
  const normalizedSettlementId = String(settlementId || '').trim().toLowerCase();
  const contractAddress = String(htlcAddress || '').trim();
  let fromBlock = 0;
  const parseCandidateReceipt = async (txId, expectedStatus) => {
    const hash = String(txId || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
    let receipt;
    try {
      receipt = await provider.getTransactionReceipt(hash);
    } catch (_e) {
      return null;
    }
    if (!receipt || Number(receipt.status) !== 1) return null;
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    for (const log of logs) {
      if (String(log?.address || '').toLowerCase() !== contractAddress.toLowerCase()) continue;
      try {
        const parsed = TAO_HTLC_RECONCILE_IFACE.parseLog(log);
        const swapId = String(parsed?.args?.swapId || '').trim().toLowerCase();
        if (swapId !== normalizedSettlementId) continue;
        if (expectedStatus && String(parsed?.name || '').toLowerCase() !== expectedStatus) continue;
        return {
          status: String(parsed?.name || '').toLowerCase(),
          txId: String(receipt.hash || hash).trim(),
          blockNumber: Number(log?.blockNumber || receipt.blockNumber || 0),
          logIndex: Number(log?.index ?? log?.logIndex ?? 0),
          source: 'tx_receipt',
        };
      } catch (_e) {}
    }
    return null;
  };

  const claimReceiptEvidence = await parseCandidateReceipt(claimTxId || trade?.tao_claim_tx_id, 'claimed');
  if (claimReceiptEvidence) return claimReceiptEvidence;

  const refundReceiptEvidence = await parseCandidateReceipt(refundTxId || trade?.tao_refund_tx_id, 'refunded');
  if (refundReceiptEvidence) return refundReceiptEvidence;

  const lockReceiptEvidence = await parseCandidateReceipt(trade?.tao_lock_tx_id, '');
  if (lockReceiptEvidence && Number.isFinite(lockReceiptEvidence.blockNumber) && lockReceiptEvidence.blockNumber > 0) {
    fromBlock = lockReceiptEvidence.blockNumber;
  }

  let logs = [];
  try {
    logs = await provider.getLogs({
      address: contractAddress,
      fromBlock,
      toBlock: 'latest',
      topics: [[TAO_CLAIMED_TOPIC, TAO_REFUNDED_TOPIC], normalizedSettlementId],
    });
  } catch (_e) {
    return null;
  }
  const matches = [];
  for (const log of logs) {
    try {
      const parsed = TAO_HTLC_RECONCILE_IFACE.parseLog(log);
      const swapId = String(parsed?.args?.swapId || '').trim().toLowerCase();
      if (swapId !== normalizedSettlementId) continue;
      matches.push({
        status: String(parsed?.name || '').toLowerCase(),
        txId: String(log?.transactionHash || '').trim() || null,
        blockNumber: Number(log?.blockNumber || 0),
        logIndex: Number(log?.index ?? log?.logIndex ?? 0),
        source: 'event_log',
      });
    } catch (_e) {}
  }
  if (matches.length === 0) return null;
  matches.sort(compareTerminalEvidence);
  const latest = matches[matches.length - 1];
  const kinds = new Set(matches.map((row) => row.status));
  if (kinds.size > 1) {
    return {
      status: 'ambiguous',
      txId: latest.txId || null,
      blockNumber: latest.blockNumber,
      logIndex: latest.logIndex,
      source: latest.source,
      conflict: Array.from(kinds).sort(),
    };
  }
  return latest;
}

async function readTaoOnchainState(trade, { claimTxId = '', refundTxId = '' } = {}) {
  const rpcUrl = String(process.env.TAO_EVM_RPC_URL || 'https://lite.chain.opentensor.ai').trim();
  const htlcAddress = String(trade?.tao_htlc_address || process.env.TAO_EVM_HTLC_ADDRESS || '').trim();
  const settlementId = String(trade?.tao_settlement_id || '').trim();
  if (!htlcAddress) die('Missing TAO_EVM_HTLC_ADDRESS / trade.tao_htlc_address');
  if (!settlementId) die('Trade missing tao_settlement_id');

  const provider = new JsonRpcProvider(rpcUrl);
  const htlc = new Contract(htlcAddress, TAO_HTLC_RECONCILE_ABI, provider);
  const state = await htlc.swaps(settlementId);
  const terminalEvidence = await readTaoTerminalEvidence({
    provider,
    htlcAddress,
    settlementId,
    trade,
    claimTxId,
    refundTxId,
  });
  if (terminalEvidence?.status === 'claimed' || terminalEvidence?.status === 'refunded') {
    return {
      status: terminalEvidence.status,
      sender: String(state?.sender || ZeroAddress),
      receiver: String(state?.receiver || ZeroAddress),
      amount: String(state?.amount ?? 0n),
      refundAfter: Number(state?.refundAfter ?? 0n),
      claimed: terminalEvidence.status === 'claimed',
      refunded: terminalEvidence.status === 'refunded',
      txId: terminalEvidence.txId || null,
      evidence_source: terminalEvidence.source || null,
    };
  }
  if (terminalEvidence?.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      sender: String(state?.sender || ZeroAddress),
      receiver: String(state?.receiver || ZeroAddress),
      amount: String(state?.amount ?? 0n),
      refundAfter: Number(state?.refundAfter ?? 0n),
      claimed: false,
      refunded: false,
      txId: terminalEvidence.txId || null,
      evidence_source: terminalEvidence.source || null,
      conflict: Array.isArray(terminalEvidence.conflict) ? terminalEvidence.conflict : [],
    };
  }
  if (isEmptyTaoSwapRow(state)) {
    return {
      status: 'missing',
      sender: String(state?.sender || ZeroAddress),
      receiver: String(state?.receiver || ZeroAddress),
      amount: String(state?.amount ?? 0n),
      refundAfter: Number(state?.refundAfter ?? 0n),
      claimed: Boolean(state?.claimed),
      refunded: Boolean(state?.refunded),
    };
  }
  if (Boolean(state?.refunded)) {
    return {
      status: 'refunded',
      sender: String(state?.sender || ZeroAddress),
      receiver: String(state?.receiver || ZeroAddress),
      amount: String(state?.amount ?? 0n),
      refundAfter: Number(state?.refundAfter ?? 0n),
      claimed: Boolean(state?.claimed),
      refunded: Boolean(state?.refunded),
    };
  }
  if (Boolean(state?.claimed)) {
    return {
      status: 'claimed',
      sender: String(state?.sender || ZeroAddress),
      receiver: String(state?.receiver || ZeroAddress),
      amount: String(state?.amount ?? 0n),
      refundAfter: Number(state?.refundAfter ?? 0n),
      claimed: Boolean(state?.claimed),
      refunded: Boolean(state?.refunded),
    };
  }
  return {
    status: 'active',
    sender: String(state?.sender || ZeroAddress),
    receiver: String(state?.receiver || ZeroAddress),
    amount: String(state?.amount ?? 0n),
    refundAfter: Number(state?.refundAfter ?? 0n),
    claimed: Boolean(state?.claimed),
    refunded: Boolean(state?.refunded),
  };
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (cmd !== 'reconcile') die(`Unknown command: ${cmd}`);

  const receiptsDbPath = requireFlag(flags, 'receipts-db');
  const store = openTradeReceiptsStore({ dbPath: receiptsDbPath });
  try {
    const tradeId = flags.get('trade-id') ? String(flags.get('trade-id')).trim() : '';
    const paymentHashHex = flags.get('payment-hash')
      ? normalizeHex32(flags.get('payment-hash'), 'payment-hash')
      : '';
    const claimTxId = flags.get('claim-tx-id') ? String(flags.get('claim-tx-id')).trim() : '';
    const refundTxId = flags.get('refund-tx-id') ? String(flags.get('refund-tx-id')).trim() : '';
    const trade = pickTrade(store, { tradeId: tradeId || null, paymentHashHex: paymentHashHex || null });
    const settlementKind = resolveEffectiveSettlementKind(
      trade,
      normalizeSettlementKind(flags.get('settlement') || SETTLEMENT_KIND.SOLANA)
    );
    if (settlementKind !== SETTLEMENT_KIND.TAO_EVM) {
      die(`reconcile currently supports --settlement ${SETTLEMENT_KIND.TAO_EVM} only`);
    }

    const before = {
      trade_id: trade.trade_id,
      state: trade.state || null,
      last_error: trade.last_error || null,
      tao_claim_tx_id: trade.tao_claim_tx_id || null,
      tao_refund_tx_id: trade.tao_refund_tx_id || null,
      reconciliation_source: trade.reconciliation_source || null,
      reconciliation_ts: trade.reconciliation_ts || null,
    };
    const onchain = await readTaoOnchainState(trade, { claimTxId, refundTxId });
    const nowMs = Date.now();
    const decision = applyOnchainSettlementReconciliation({ store, trade, onchain, nowMs });
    const afterTrade = store.getTrade(trade.trade_id);

    if (decision.updated) {
      process.stderr.write(
        `[swapreconcile] updated trade_id=${trade.trade_id} local_state=${before.state || 'n/a'} -> ${afterTrade?.state || 'n/a'} onchain_status=${onchain.status}\n`
      );
    } else {
      process.stderr.write(
        `[swapreconcile] no_change trade_id=${trade.trade_id} local_state=${before.state || 'n/a'} onchain_status=${onchain.status} reason=${decision.reason}\n`
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        type: 'reconcile',
        trade_id: trade.trade_id,
        settlement_kind: settlementKind,
        before,
        onchain,
        decision,
        after: {
          state: afterTrade?.state || null,
          last_error: afterTrade?.last_error || null,
          tao_claim_tx_id: afterTrade?.tao_claim_tx_id || null,
          tao_refund_tx_id: afterTrade?.tao_refund_tx_id || null,
          reconciliation_source: afterTrade?.reconciliation_source || null,
          reconciliation_ts: afterTrade?.reconciliation_ts || null,
        },
      }, null, 2)}\n`
    );
  } finally {
    store.close();
  }
}

const isDirectRun = (() => {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
  return import.meta.url === entry;
})();

if (isDirectRun) {
  main().catch((err) => die(err?.stack || err?.message || String(err)));
}
