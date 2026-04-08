import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getAddress,
  hexlify,
  isAddress,
  keccak256,
  randomBytes,
} from 'ethers';
import { getAmountForPair, normalizePair } from '../../src/swap/pairs.js';
import { readTaoPrivateKeyFromFile } from '../../src/tao/keyfile.js';
import {
  getTermsSettlementRecipient,
  getTermsSettlementRefundAddress,
  getTermsSettlementRefundAfterUnix,
} from '../../src/swap/settlementTerms.js';
import { evaluatePrePayTimelockSafety } from '../../src/swap/timelockPolicy.js';

const DEFAULT_RPC_URL = 'https://lite.chain.opentensor.ai';
const DEFAULT_CHAIN_ID = 964n;
const DEFAULT_CONFIRMATIONS = 1;
const DEFAULT_MIN_REFUND_SAFETY_SEC = 3600;

const TAO_HTLC_ABI = [
  'function lock(address receiver, bytes32 hashlock, uint256 refundAfter, bytes32 clientSalt) payable returns (bytes32 swapId)',
  'function claim(bytes32 swapId, bytes preimage)',
  'function refund(bytes32 swapId)',
  'function swaps(bytes32 swapId) view returns (address sender, address receiver, uint256 amount, uint256 refundAfter, bytes32 hashlock, bool claimed, bool refunded)',
];

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

function parseChainId(value, fallback = DEFAULT_CHAIN_ID) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid chainId: ${String(value)}`);
  }
  return BigInt(n);
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid positive integer: ${String(value)}`);
  }
  return n;
}

function parseFeeBps(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid fee bps: ${String(value)}`);
  }
  return n;
}

function normalizePrivateKey(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error('TAO_EVM_PRIVATE_KEY must be 0x-prefixed 32-byte hex');
  }
  return v;
}

function normalizeTxHash(value) {
  const hash = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('txId must be a 0x-prefixed 32-byte hash');
  return hash;
}

function normalizeHex32(value, label) {
  const s = String(value || '').trim();
  if (!s) throw new Error(`${label} is required`);
  const noPrefix = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  if (!/^[0-9a-fA-F]{64}$/.test(noPrefix)) {
    throw new Error(`${label} must be 32-byte hex`);
  }
  return `0x${noPrefix.toLowerCase()}`;
}

function normalizePaymentHashHex(value) {
  const s = String(value || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error('paymentHashHex must be 32-byte hex without 0x prefix');
  }
  return `0x${s.toLowerCase()}`;
}

function normalizeAddress(value, label) {
  const s = String(value || '').trim();
  if (!s || !isAddress(s)) throw new Error(`${label} must be an EVM address`);
  return getAddress(s);
}

function parseMinRefundSafetySec() {
  const raw =
    process.env.INTERCOMSWAP_MIN_REFUND_SAFETY_SEC ??
    process.env.INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC ??
    '';
  if (raw === '') return DEFAULT_MIN_REFUND_SAFETY_SEC;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_MIN_REFUND_SAFETY_SEC;
  }
  return n;
}

function parseAmountAtomic(value) {
  const s = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(s)) throw new Error('amountAtomic must be a positive wei integer string');
  const n = BigInt(s);
  if (n <= 0n) throw new Error('amountAtomic must be > 0');
  return n;
}

function parseRefundAfterUnix(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error('refundAfterUnix must be a unix seconds integer');
  }
  return BigInt(n);
}

function parseMetadataObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeSwapId(value) {
  return normalizeHex32(value, 'settlementId');
}

function parseUint256Like(value, label) {
  try {
    const n = BigInt(value);
    if (n < 0n) throw new Error(`${label} must be >= 0`);
    return n;
  } catch (_e) {
    throw new Error(`${label} must be uint256`);
  }
}

export function computeTaoSwapIdFromLockInputs({
  sender,
  receiver,
  value,
  refundAfter,
  hashlock,
  clientSalt,
}) {
  const senderAddress = normalizeAddress(sender, 'sender');
  const receiverAddress = normalizeAddress(receiver, 'receiver');
  const amount = parseUint256Like(value, 'value');
  const refundAfterUnix = parseUint256Like(refundAfter, 'refundAfter');
  const normalizedHashlock = normalizeHex32(hashlock, 'hashlock');
  const normalizedClientSalt = normalizeHex32(clientSalt, 'clientSalt');
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint256', 'uint256', 'bytes32', 'bytes32'],
    [senderAddress, receiverAddress, amount, refundAfterUnix, normalizedHashlock, normalizedClientSalt]
  );
  return keccak256(encoded).toLowerCase();
}

/**
 * EVM settlement provider for TAO EVM.
 *
 * Phase 4 scope:
 * - implements lock/claim/refund against TaoHTLC
 * - keeps feeSnapshot as a placeholder
 * - leaves verifySwapPrePayOnchain for a later integration phase
 *
 * @implements {import('../SettlementProvider').SettlementProvider}
 */
export class TaoEvmSettlementProvider {
  constructor({
    rpcUrl = process.env.TAO_EVM_RPC_URL || DEFAULT_RPC_URL,
    chainId = DEFAULT_CHAIN_ID,
    privateKey = process.env.TAO_EVM_PRIVATE_KEY || '',
    keyfilePath = '',
    confirmations = process.env.TAO_EVM_CONFIRMATIONS || DEFAULT_CONFIRMATIONS,
    htlcAddress = process.env.TAO_EVM_HTLC_ADDRESS || '',
  } = {}) {
    this.rpcUrl = String(rpcUrl || DEFAULT_RPC_URL).trim() || DEFAULT_RPC_URL;
    this.expectedChainId = parseChainId(chainId, DEFAULT_CHAIN_ID);
    if (this.expectedChainId !== DEFAULT_CHAIN_ID) {
      throw new Error(`TaoEvmSettlementProvider only supports chainId=${DEFAULT_CHAIN_ID}`);
    }
    this.confirmations = parsePositiveInt(confirmations, DEFAULT_CONFIRMATIONS);

    const taoKeyfilePath = String(keyfilePath || '').trim();
    let pk = '';
    if (taoKeyfilePath) {
      pk = readTaoPrivateKeyFromFile(taoKeyfilePath);
      if (process.env.DEBUG) {
        process.stderr.write('Loaded TAO signer from file\n');
      }
    } else {
      pk = normalizePrivateKey(privateKey);
      if (!pk) throw new Error('Missing TAO signer: provide --tao-keyfile or TAO_EVM_PRIVATE_KEY');
      if (process.env.DEBUG) {
        process.stderr.write('Loaded TAO signer from environment\n');
      }
    }

    this.provider = new JsonRpcProvider(this.rpcUrl);
    this.wallet = new Wallet(pk, this.provider);

    const rawHtlc = String(htlcAddress || '').trim();
    this.htlcAddress = rawHtlc ? normalizeAddress(rawHtlc, 'TAO_EVM_HTLC_ADDRESS') : '';
    this.htlc = this.htlcAddress ? new Contract(this.htlcAddress, TAO_HTLC_ABI, this.wallet) : null;

    this._metaBySettlementId = new Map();
    this._ready = this._assertExpectedChainId();
  }

  async _assertExpectedChainId() {
    const network = await this.provider.getNetwork();
    const got = BigInt(network.chainId);
    if (got !== this.expectedChainId) {
      throw new Error(`TAO EVM chainId mismatch (expected=${this.expectedChainId} got=${got})`);
    }
    return got;
  }

  async _ensureReady() {
    await this._ready;
  }

  _phaseLater(methodName, phase = 'Phase 5') {
    throw new NotImplementedError(`${methodName} not implemented yet. ${phase} will add HTLC integration checks.`);
  }

  _requireHtlc() {
    if (this.htlc) return this.htlc;
    throw new Error('Missing TAO_EVM_HTLC_ADDRESS');
  }

  _setMetadata(settlementId, metadata) {
    const id = String(settlementId || '').trim().toLowerCase();
    if (!id) return;
    const prev = parseMetadataObject(this._metaBySettlementId.get(id));
    this._metaBySettlementId.set(id, { ...prev, ...metadata });
  }

  _getMetadata(settlementId) {
    return parseMetadataObject(this._metaBySettlementId.get(String(settlementId || '').trim().toLowerCase()));
  }

  _resolveClientSalt(terms = {}) {
    const t = parseMetadataObject(terms);
    const fromTerms = String(t.client_salt || t.clientSalt || '').trim();
    if (fromTerms) return normalizeHex32(fromTerms, 'terms.client_salt');
    return hexlify(randomBytes(32));
  }

  async getSignerAddress() {
    await this._ensureReady();
    return this.wallet.getAddress();
  }

  async feeSnapshot(input = {}) {
    await this._ensureReady();
    const signer = await this.wallet.getAddress();

    // Placeholder fee model for Phase 4: defaults to zero fees unless env overrides are set.
    const platformFeeBps = parseFeeBps(process.env.TAO_EVM_PLATFORM_FEE_BPS, 0);
    const tradeFeeBps = parseFeeBps(process.env.TAO_EVM_TRADE_FEE_BPS, 0);

    const platformFeeCollector =
      String(process.env.TAO_EVM_PLATFORM_FEE_COLLECTOR || '').trim() || signer;
    const tradeFeeCollector =
      String(process.env.TAO_EVM_TRADE_FEE_COLLECTOR || '').trim() ||
      String(input?.tradeFeeCollector || '').trim() ||
      signer;

    return {
      platformFeeBps,
      platformFeeCollector,
      tradeFeeBps,
      tradeFeeCollector,
    };
  }

  async lock(input) {
    await this._ensureReady();
    const htlc = this._requireHtlc();

    const signerAddress = await this.wallet.getAddress();
    const receiver = normalizeAddress(input?.recipient, 'recipient');
    if (receiver === ZeroAddress) throw new Error('recipient must not be zero address');
    const refundAddress = normalizeAddress(input?.refundAddress, 'refundAddress');
    if (refundAddress === ZeroAddress) throw new Error('refundAddress must not be zero address');
    if (refundAddress !== getAddress(signerAddress)) {
      throw new Error(`refundAddress must match signer address (${signerAddress})`);
    }

    const hashlock = normalizePaymentHashHex(input?.paymentHashHex);
    const amount = parseAmountAtomic(input?.amountAtomic);
    const refundAfter = parseRefundAfterUnix(input?.refundAfterUnix);
    const nowUnix = Math.floor(Date.now() / 1000);
    const minRefundSafetySec = parseMinRefundSafetySec();
    if (Number(refundAfter) < nowUnix + minRefundSafetySec) {
      throw new Error(`refundAfterUnix too soon (need >= now + ${minRefundSafetySec}s)`);
    }
    const clientSalt = this._resolveClientSalt(input?.terms);
    const settlementId = normalizeSwapId(
      computeTaoSwapIdFromLockInputs({
        sender: signerAddress,
        receiver,
        value: amount,
        refundAfter,
        hashlock,
        clientSalt,
      })
    );

    const emitStage = async (stage, details = {}) => {
      if (typeof input?.onStage !== 'function') return;
      await input.onStage({
        stage,
        settlementId,
        clientSalt,
        ...details,
      });
    };

    let tx = null;
    let txId = null;
    try {
      await emitStage('rpc_send', {
        hashlock,
        refund_after_unix: Number(refundAfter),
        amount_atomic: amount.toString(),
        recipient: receiver,
        refund: refundAddress,
        htlc_address: this.htlcAddress,
      });

      tx = await htlc.lock(receiver, hashlock, refundAfter, clientSalt, {
        value: amount,
      });
      txId = normalizeTxHash(tx.hash);
      await emitStage('tx_hash', { txId });

      this._setMetadata(settlementId, {
        settlement_id: settlementId,
        tx_id: txId,
        tx_hash: txId,
        swap_id: settlementId,
        hashlock,
        sender: signerAddress,
        receiver,
        amount_atomic: amount.toString(),
        refund_after_unix: Number(refundAfter),
        contract_address: this.htlcAddress,
        htlc_address: this.htlcAddress,
        recipient: receiver,
        refund: refundAddress,
        client_salt: clientSalt,
      });
      if (typeof input?.onBroadcast === 'function') {
        await input.onBroadcast({
          settlementId,
          txId,
          clientSalt,
          metadata: this._getMetadata(settlementId),
        });
      }

      await emitStage('wait_confirm', { txId, confirmations: this.confirmations });
      await tx.wait(this.confirmations);
      await emitStage('confirmed', { txId });
    } catch (err) {
      await emitStage('error', {
        txId,
        error: err?.message ?? String(err),
      });
      throw err;
    }

    return {
      settlementId,
      txId,
      metadata: this._getMetadata(settlementId),
    };
  }

  async verifyPrePay(input) {
    try {
      await this._ensureReady();
      const htlc = this._requireHtlc();

      const settlementId = normalizeSwapId(input?.settlementId);
      const hashlock = normalizeHex32(input?.paymentHashHex, 'paymentHashHex');
      const s = await htlc.swaps(settlementId);

      const sender = String(s?.sender || ZeroAddress);
      if (sender.toLowerCase() === ZeroAddress.toLowerCase()) {
        return { ok: false, error: 'swap not found on chain' };
      }
      const receiver = String(s?.receiver || ZeroAddress);
      const amount = BigInt(s?.amount ?? 0n);
      const refundAfter = BigInt(s?.refundAfter ?? 0n);
      const onchainHashlock = normalizeHex32(s?.hashlock, 'swap.hashlock');
      const claimed = Boolean(s?.claimed);
      const refunded = Boolean(s?.refunded);

      if (onchainHashlock !== hashlock) {
        return { ok: false, error: 'swap hashlock mismatch' };
      }
      if (claimed || refunded) {
        return { ok: false, error: `swap not active (claimed=${claimed} refunded=${refunded})` };
      }

      if (input?.nowUnix !== undefined && input?.nowUnix !== null) {
        const nowUnix = Number(input.nowUnix);
        if (!Number.isFinite(nowUnix) || !Number.isInteger(nowUnix) || nowUnix <= 0) {
          return { ok: false, error: 'nowUnix must be a unix seconds integer' };
        }
        if (BigInt(nowUnix) >= refundAfter) {
          return { ok: false, error: 'swap refund_after already reached' };
        }
      }

      const metadata = {
        settlement_id: settlementId,
        swap_id: settlementId,
        contract_address: this.htlcAddress,
        hashlock: onchainHashlock,
        sender,
        receiver,
        amount_atomic: amount.toString(),
        refund_after_unix: Number(refundAfter),
        claimed,
        refunded,
      };
      this._setMetadata(settlementId, metadata);
      return { ok: true, metadata };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async verifySwapPrePayOnchain(input = {}) {
    const terms = parseMetadataObject(input?.terms);
    const invoiceBody = parseMetadataObject(input?.invoiceBody);
    const escrowBody = parseMetadataObject(input?.escrowBody);
    const termsPair = normalizePair(terms?.pair);
    const termsAmount = String(getAmountForPair(terms, termsPair, { allowLegacyTaoFallback: true }) || '').trim();

    const settlementId = String(escrowBody?.settlement_id || '').trim();
    if (!settlementId) return { ok: false, error: 'escrowBody.settlement_id is required' };
    if (!/^0x[0-9a-fA-F]{64}$/.test(settlementId)) {
      return { ok: false, error: 'escrowBody.settlement_id must be a 0x-prefixed 32-byte hex string' };
    }

    const paymentHashHex = String(invoiceBody?.payment_hash_hex || escrowBody?.payment_hash_hex || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) {
      return { ok: false, error: 'payment_hash_hex is required (32-byte hex without 0x)' };
    }
    const termsRecipientRaw = getTermsSettlementRecipient(terms);
    const termsRefundRaw = getTermsSettlementRefundAddress(terms);
    const termsRefundAfterUnixRaw = getTermsSettlementRefundAfterUnix(terms);

    if (String(escrowBody?.payment_hash_hex || '').trim().toLowerCase() !== paymentHashHex) {
      return { ok: false, error: 'payment_hash mismatch (invoice vs lock message)' };
    }

    if (termsRecipientRaw !== undefined && String(termsRecipientRaw).trim() !== String(escrowBody?.recipient || '').trim()) {
      return { ok: false, error: 'lock recipient mismatch vs terms' };
    }
    if (termsRefundRaw !== undefined && String(termsRefundRaw).trim() !== String(escrowBody?.refund || '').trim()) {
      return { ok: false, error: 'lock refund mismatch vs terms' };
    }
    if (termsAmount && termsAmount !== String(escrowBody?.amount_atomic || '').trim()) {
      return { ok: false, error: 'lock amount mismatch vs terms' };
    }
    if (
      termsRefundAfterUnixRaw !== undefined &&
      termsRefundAfterUnixRaw !== null &&
      Number(escrowBody?.refund_after_unix) < Number(termsRefundAfterUnixRaw)
    ) {
      return { ok: false, error: 'lock refund_after_unix earlier than terms' };
    }

    const verify = await this.verifyPrePay({
      settlementId,
      paymentHashHex,
      ...(input?.nowUnix !== undefined && input?.nowUnix !== null ? { nowUnix: input.nowUnix } : {}),
    });
    if (!verify.ok) {
      return { ok: false, error: verify.error, metadata: verify.metadata };
    }

    const md = parseMetadataObject(verify.metadata);
    if (String(md.sender || '').trim().toLowerCase() === ZeroAddress.toLowerCase()) {
      return { ok: false, error: 'swap not active on-chain (sender is zero address)' };
    }
    if (Boolean(md.claimed) || Boolean(md.refunded)) {
      return {
        ok: false,
        error: `swap not active on-chain (claimed=${Boolean(md.claimed)} refunded=${Boolean(md.refunded)})`,
      };
    }
    const expectedHashlock = `0x${paymentHashHex}`;
    const onchainHashlock = String(md.hashlock || '').trim().toLowerCase();
    if (!onchainHashlock) {
      return { ok: false, error: 'on-chain hashlock is missing' };
    }
    if (onchainHashlock !== expectedHashlock) {
      return {
        ok: false,
        error: `payment_hash mismatch vs on-chain hashlock (expected=${expectedHashlock}, got=${onchainHashlock})`,
      };
    }

    const escrowAmountAtomic = String(escrowBody?.amount_atomic || '').trim();
    if (!/^[0-9]+$/.test(escrowAmountAtomic)) {
      return { ok: false, error: 'escrowBody.amount_atomic is required' };
    }
    const onchainAmountAtomic = String(md.amount_atomic || '').trim();
    if (!/^[0-9]+$/.test(onchainAmountAtomic)) {
      return { ok: false, error: 'on-chain amount_atomic is missing' };
    }
    if (onchainAmountAtomic !== escrowAmountAtomic) {
      return {
        ok: false,
        error: `amount_atomic mismatch vs on-chain (expected=${escrowAmountAtomic}, got=${onchainAmountAtomic})`,
      };
    }
    if (termsAmount && termsAmount !== onchainAmountAtomic) {
      return {
        ok: false,
        error: `amount_atomic mismatch vs terms (expected=${termsAmount}, got=${onchainAmountAtomic})`,
      };
    }

    const escrowRefundAfterUnix = Number(escrowBody?.refund_after_unix);
    if (!Number.isFinite(escrowRefundAfterUnix) || !Number.isInteger(escrowRefundAfterUnix) || escrowRefundAfterUnix <= 0) {
      return { ok: false, error: 'escrowBody.refund_after_unix is required' };
    }
    const onchainRefundAfterUnix = Number(md.refund_after_unix);
    if (!Number.isFinite(onchainRefundAfterUnix) || !Number.isInteger(onchainRefundAfterUnix) || onchainRefundAfterUnix <= 0) {
      return { ok: false, error: 'on-chain refund_after_unix is missing' };
    }
    if (onchainRefundAfterUnix !== escrowRefundAfterUnix) {
      return {
        ok: false,
        error: `refund_after_unix mismatch vs on-chain (expected=${escrowRefundAfterUnix}, got=${onchainRefundAfterUnix})`,
      };
    }
    if (termsRefundAfterUnixRaw !== undefined && termsRefundAfterUnixRaw !== null) {
      const termsRefundAfterUnix = Number(termsRefundAfterUnixRaw);
      if (
        !Number.isFinite(termsRefundAfterUnix) ||
        !Number.isInteger(termsRefundAfterUnix) ||
        termsRefundAfterUnix <= 0
      ) {
        return { ok: false, error: 'terms.sol_refund_after_unix is invalid' };
      }
      if (termsRefundAfterUnix !== onchainRefundAfterUnix) {
        return {
          ok: false,
          error: `refund_after_unix mismatch vs terms (expected=${termsRefundAfterUnix}, got=${onchainRefundAfterUnix})`,
        };
      }
    }
    const minTimelockRemainingSec = parseMinRefundSafetySec();
    const timelockSafety = evaluatePrePayTimelockSafety({
      refundAfterUnix: onchainRefundAfterUnix,
      invoiceExpiryUnix: invoiceBody?.expires_at_unix,
      nowUnix: input?.nowUnix,
      minTimelockRemainingSec,
      requireRefundAfterGreaterThanInvoiceExpiryPlusMin: true,
    });
    if (timelockSafety.code === 'timelock_too_short') {
      return {
        ok: false,
        error:
          `refund_after_unix too soon for safe pay ` +
          `(remaining=${timelockSafety.remainingSec}s min_timelock_remaining_sec=${minTimelockRemainingSec}s)`,
      };
    }
    if (timelockSafety.code === 'invoice_expiry_violation_strict') {
      return {
        ok: false,
        error:
          `refund_after_unix must be > invoice_expiry_unix + INTERCOMSWAP_MIN_TIMELOCK_REMAINING_SEC ` +
          `(refund_after_unix=${timelockSafety.refundAfterUnix} invoice_expiry_unix=${timelockSafety.invoiceExpiryUnix} ` +
          `min_timelock_remaining_sec=${minTimelockRemainingSec})`,
      };
    }

    let expectedHtlcAddress = '';
    let escrowHtlcAddress = '';
    let onchainHtlcAddress = '';
    try {
      expectedHtlcAddress = normalizeAddress(this.htlcAddress, 'TAO_EVM_HTLC_ADDRESS');
      escrowHtlcAddress = normalizeAddress(escrowBody?.htlc_address, 'escrowBody.htlc_address');
      onchainHtlcAddress = normalizeAddress(md.contract_address || this.htlcAddress, 'on-chain contract_address');
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
    if (escrowHtlcAddress !== expectedHtlcAddress) {
      return {
        ok: false,
        error: `htlc_address mismatch vs configured TAO_EVM_HTLC_ADDRESS (expected=${expectedHtlcAddress}, got=${escrowHtlcAddress})`,
      };
    }
    if (onchainHtlcAddress !== expectedHtlcAddress) {
      return {
        ok: false,
        error: `on-chain HTLC address mismatch (expected=${expectedHtlcAddress}, got=${onchainHtlcAddress})`,
      };
    }

    let escrowRecipient = '';
    let onchainRecipient = '';
    let termsRecipient = '';
    let escrowRefund = '';
    let onchainSender = '';
    let termsRefund = '';
    try {
      escrowRecipient = normalizeAddress(escrowBody?.recipient, 'escrowBody.recipient');
      onchainRecipient = normalizeAddress(md.receiver, 'on-chain receiver');
      if (termsRecipientRaw !== undefined && termsRecipientRaw !== null) {
        termsRecipient = normalizeAddress(termsRecipientRaw, 'terms.sol_recipient');
      }
      escrowRefund = normalizeAddress(escrowBody?.refund, 'escrowBody.refund');
      onchainSender = normalizeAddress(md.sender, 'on-chain sender');
      if (termsRefundRaw !== undefined && termsRefundRaw !== null) {
        termsRefund = normalizeAddress(termsRefundRaw, 'terms.sol_refund');
      }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
    if (onchainRecipient !== escrowRecipient) {
      return {
        ok: false,
        error: `recipient mismatch vs on-chain receiver (expected=${escrowRecipient}, got=${onchainRecipient})`,
      };
    }
    if (termsRecipient && onchainRecipient !== termsRecipient) {
      return {
        ok: false,
        error: `recipient mismatch vs terms (expected=${termsRecipient}, got=${onchainRecipient})`,
      };
    }
    if (onchainSender !== escrowRefund) {
      return {
        ok: false,
        error: `refund mismatch vs on-chain sender (expected=${escrowRefund}, got=${onchainSender})`,
      };
    }
    if (termsRefund && onchainSender !== termsRefund) {
      return {
        ok: false,
        error: `refund mismatch vs terms (expected=${termsRefund}, got=${onchainSender})`,
      };
    }

    return {
      ok: true,
      error: null,
      metadata: md,
      onchain: {
        state: {
          settlementId: String(md.settlement_id || settlementId),
          sender: String(md.sender || ''),
          receiver: String(md.receiver || ''),
          amountAtomic: String(md.amount_atomic || ''),
          refundAfterUnix: Number(md.refund_after_unix || 0),
          claimed: Boolean(md.claimed),
          refunded: Boolean(md.refunded),
          hashlock: String(md.hashlock || ''),
          contractAddress: String(md.contract_address || this.htlcAddress || ''),
        },
      },
    };
  }

  async claim(input) {
    await this._ensureReady();
    const htlc = this._requireHtlc();

    const settlementId = normalizeSwapId(input?.settlementId);
    const preimageHex = normalizeHex32(input?.preimageHex, 'preimageHex');

    const tx = await htlc.claim(settlementId, preimageHex);
    await tx.wait(this.confirmations);

    this._setMetadata(settlementId, {
      settlement_id: settlementId,
      tx_id: tx.hash,
      tx_hash: tx.hash,
      preimage_hex: preimageHex,
      claim_tx_id: tx.hash,
    });

    return { txId: tx.hash };
  }

  async refund(input) {
    await this._ensureReady();
    const htlc = this._requireHtlc();

    const settlementId = normalizeSwapId(input?.settlementId);
    const tx = await htlc.refund(settlementId);
    await tx.wait(this.confirmations);

    this._setMetadata(settlementId, {
      settlement_id: settlementId,
      tx_id: tx.hash,
      tx_hash: tx.hash,
      refund_tx_id: tx.hash,
    });

    return { txId: tx.hash };
  }

  async waitForConfirmation(txId) {
    await this._ensureReady();
    const hash = normalizeTxHash(txId);
    const receipt = await this.provider.waitForTransaction(hash, this.confirmations);
    if (!receipt) throw new Error(`Transaction not found: ${hash}`);
    if (Number(receipt.status) !== 1) {
      throw new Error(`Transaction failed: ${hash} status=${receipt.status}`);
    }
  }
}
