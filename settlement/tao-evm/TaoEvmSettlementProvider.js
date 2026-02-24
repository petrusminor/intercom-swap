import { JsonRpcProvider, Wallet } from 'ethers';

const DEFAULT_RPC_URL = 'https://lite.chain.opentensor.ai';
const DEFAULT_CHAIN_ID = 964n;
const DEFAULT_CONFIRMATIONS = 1;

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

/**
 * EVM settlement provider scaffold for TAO EVM.
 *
 * Phase 3 scope is connectivity and tx plumbing only. HTLC lock/claim/refund
 * behavior will be added in Phase 4.
 *
 * @implements {import('../SettlementProvider').SettlementProvider}
 */
export class TaoEvmSettlementProvider {
  constructor({
    rpcUrl = process.env.TAO_EVM_RPC_URL || DEFAULT_RPC_URL,
    chainId = DEFAULT_CHAIN_ID,
    privateKey = process.env.TAO_EVM_PRIVATE_KEY || '',
    confirmations = process.env.TAO_EVM_CONFIRMATIONS || DEFAULT_CONFIRMATIONS,
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

  _phase4(methodName) {
    throw new NotImplementedError(`${methodName} not implemented yet. Phase 4 will add HTLC.`);
  }

  async getSignerAddress() {
    await this._ensureReady();
    return this.wallet.getAddress();
  }

  async feeSnapshot(input = {}) {
    await this._ensureReady();
    const signer = await this.wallet.getAddress();

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

  async lock(_input) {
    this._phase4('lock');
  }

  async verifyPrePay(_input) {
    this._phase4('verifyPrePay');
  }

  async verifySwapPrePayOnchain(_input) {
    this._phase4('verifySwapPrePayOnchain');
  }

  async claim(_input) {
    this._phase4('claim');
  }

  async refund(_input) {
    this._phase4('refund');
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
