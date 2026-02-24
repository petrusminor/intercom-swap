import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getAddress,
  hexlify,
  isAddress,
  randomBytes,
} from 'ethers';

const DEFAULT_RPC_URL = 'https://lite.chain.opentensor.ai';
const DEFAULT_CHAIN_ID = 964n;
const DEFAULT_CONFIRMATIONS = 1;

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

function normalizeAddress(value, label) {
  const s = String(value || '').trim();
  if (!s || !isAddress(s)) throw new Error(`${label} must be an EVM address`);
  return getAddress(s);
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
    confirmations = process.env.TAO_EVM_CONFIRMATIONS || DEFAULT_CONFIRMATIONS,
    htlcAddress = process.env.TAO_EVM_HTLC_ADDRESS || '',
  } = {}) {
    this.rpcUrl = String(rpcUrl || DEFAULT_RPC_URL).trim() || DEFAULT_RPC_URL;
    this.expectedChainId = parseChainId(chainId, DEFAULT_CHAIN_ID);
    if (this.expectedChainId !== DEFAULT_CHAIN_ID) {
      throw new Error(`TaoEvmSettlementProvider only supports chainId=${DEFAULT_CHAIN_ID}`);
    }
    this.confirmations = parsePositiveInt(confirmations, DEFAULT_CONFIRMATIONS);

    const pk = normalizePrivateKey(privateKey);
    if (!pk) throw new Error('Missing TAO_EVM_PRIVATE_KEY');

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
    const refundAddress = normalizeAddress(input?.refundAddress, 'refundAddress');
    if (refundAddress !== getAddress(signerAddress)) {
      throw new Error(`refundAddress must match signer address (${signerAddress})`);
    }

    const hashlock = normalizeHex32(input?.paymentHashHex, 'paymentHashHex');
    const amount = parseAmountAtomic(input?.amountAtomic);
    const refundAfter = parseRefundAfterUnix(input?.refundAfterUnix);
    const clientSalt = this._resolveClientSalt(input?.terms);

    const swapId = await htlc.lock.staticCall(receiver, hashlock, refundAfter, clientSalt, {
      value: amount,
    });

    const tx = await htlc.lock(receiver, hashlock, refundAfter, clientSalt, {
      value: amount,
    });
    await tx.wait(this.confirmations);

    const settlementId = normalizeSwapId(swapId);
    this._setMetadata(settlementId, {
      settlement_id: settlementId,
      tx_id: tx.hash,
      tx_hash: tx.hash,
      swap_id: settlementId,
      hashlock,
      sender: signerAddress,
      receiver,
      amount_atomic: amount.toString(),
      refund_after_unix: Number(refundAfter),
      contract_address: this.htlcAddress,
      client_salt: clientSalt,
    });

    return {
      settlementId,
      txId: tx.hash,
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

  async verifySwapPrePayOnchain(_input) {
    this._phaseLater('verifySwapPrePayOnchain');
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
