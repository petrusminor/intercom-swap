#!/usr/bin/env node
// Run:
// TAO_EVM_PRIVATE_KEY=0x... TAO_EVM_HTLC_ADDRESS=0x... \
// TAO_EVM_RPC_URL=https://lite.chain.opentensor.ai \
// node settlement/tao-evm/scripts/provider-htlc-roundtrip.mjs

import crypto from 'node:crypto';
import process from 'node:process';

import { Contract, ZeroAddress, getAddress, isAddress, randomBytes } from 'ethers';
import { TaoEvmSettlementProvider } from '../TaoEvmSettlementProvider.js';

const DEFAULT_RPC_URL = 'https://lite.chain.opentensor.ai';
const CHAIN_ID = 964n;
const LOCK_AMOUNT_WEI = '1000000000000000'; // 0.001 TAO

const HTLC_VIEW_ABI = [
  'function swaps(bytes32 swapId) view returns (address sender, address receiver, uint256 amount, uint256 refundAfter, bytes32 hashlock, bool claimed, bool refunded)',
];

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function getRequiredEnv(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function hexNoPrefix(buf) {
  return Buffer.from(buf).toString('hex').toLowerCase();
}

function randomHex32Prefixed() {
  return `0x${hexNoPrefix(randomBytes(32))}`;
}

async function main() {
  const rpcUrl = String(process.env.TAO_EVM_RPC_URL || DEFAULT_RPC_URL).trim() || DEFAULT_RPC_URL;
  const privateKey = getRequiredEnv('TAO_EVM_PRIVATE_KEY');
  const htlcAddressRaw = getRequiredEnv('TAO_EVM_HTLC_ADDRESS');
  if (!isAddress(htlcAddressRaw)) throw new Error('TAO_EVM_HTLC_ADDRESS must be a valid address');
  const htlcAddress = getAddress(htlcAddressRaw);

  const settlement = new TaoEvmSettlementProvider({
    rpcUrl,
    chainId: CHAIN_ID,
    privateKey,
    htlcAddress,
    confirmations: 1,
  });

  const signerAddress = await settlement.getSignerAddress();
  const nowUnix = Math.floor(Date.now() / 1000);

  const preimageBuf = crypto.randomBytes(32);
  const preimageHex = hexNoPrefix(preimageBuf);
  const paymentHashHex = crypto.createHash('sha256').update(preimageBuf).digest('hex').toLowerCase();
  const clientSalt = randomHex32Prefixed();

  const lock = await settlement.lock({
    paymentHashHex,
    amountAtomic: LOCK_AMOUNT_WEI,
    recipient: signerAddress,
    refundAddress: signerAddress,
    refundAfterUnix: nowUnix + 300,
    terms: {
      client_salt: clientSalt,
    },
  });

  const settlementId = String(lock?.settlementId || '').trim();
  const lockTxId = String(lock?.txId || '').trim();
  assert(/^0x[0-9a-f]{64}$/.test(settlementId), `Invalid settlementId: ${settlementId}`);
  assert(/^0x[0-9a-fA-F]{64}$/.test(lockTxId), `Invalid lock txId: ${lockTxId}`);

  process.stdout.write(
    `${JSON.stringify({
      type: 'provider_lock_ok',
      settlement_id: settlementId,
      tx_id: lockTxId,
      payment_hash_hex: paymentHashHex,
      preimage_hex: preimageHex,
    })}\n`
  );

  await settlement.waitForConfirmation(lockTxId);

  const prepay = await settlement.verifyPrePay({
    settlementId,
    paymentHashHex,
  });

  assert(prepay?.ok === true, `verifyPrePay failed: ${prepay?.error || 'unknown error'}`);
  process.stdout.write(`${JSON.stringify({ type: 'provider_verify_ok', settlement_id: settlementId })}\n`);

  const claim = await settlement.claim({
    settlementId,
    preimageHex,
  });
  const claimTxId = String(claim?.txId || '').trim();
  assert(/^0x[0-9a-fA-F]{64}$/.test(claimTxId), `Invalid claim txId: ${claimTxId}`);

  await settlement.waitForConfirmation(claimTxId);

  const htlc = new Contract(htlcAddress, HTLC_VIEW_ABI, settlement.provider);
  const swap = await htlc.swaps(settlementId);
  const sender = String(swap?.sender || '').trim();
  assert(sender.toLowerCase() === ZeroAddress.toLowerCase(), `Expected deleted swap sender=0x0, got ${sender}`);

  process.stdout.write(
    `${JSON.stringify({
      type: 'provider_claim_ok',
      settlement_id: settlementId,
      claim_tx_id: claimTxId,
      sender_after_claim: sender,
    })}\n`
  );

  process.stdout.write('PASS provider-htlc-roundtrip\n');
}

main().catch((err) => {
  die(err?.message || String(err));
});
