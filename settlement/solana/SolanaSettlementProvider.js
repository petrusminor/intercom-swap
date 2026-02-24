import crypto from 'node:crypto';

import { PublicKey } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import { readSolanaKeypair } from '../../src/solana/keypair.js';
import { SolanaRpcPool } from '../../src/solana/rpcPool.js';
import {
  LN_USDT_ESCROW_PROGRAM_ID,
  claimEscrowTx,
  createEscrowTx,
  decodeEscrowState,
  getConfigState,
  getTradeConfigState,
  refundEscrowTx,
} from '../../src/solana/lnUsdtEscrowClient.js';
import { verifySwapPrePayOnchain as verifySwapPrePayOnchainCore } from '../../src/swap/verify.js';

export const SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID = LN_USDT_ESCROW_PROGRAM_ID.toBase58();

function normalizeHex32(value, label) {
  const hex = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${label} must be 32-byte hex`);
  return hex;
}

function toPosIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseAmountAtomic(value) {
  const s = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(s)) throw new Error('amountAtomic must be a positive atomic amount string');
  return BigInt(s);
}

function parseMetadataObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeOnchainValue(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && typeof value.toBase58 === 'function') return value.toBase58();
  return value;
}

function normalizeOnchainState(state) {
  if (!state || typeof state !== 'object') return state;
  const out = {};
  for (const [key, value] of Object.entries(state)) {
    out[key] = normalizeOnchainValue(value);
  }
  return out;
}

export class SolanaSettlementProvider {
  constructor({
    rpcUrls,
    commitment = 'confirmed',
    keypairPath,
    mint = '',
    programId = '',
    tradeFeeCollector = '',
    computeUnitLimit = null,
    computeUnitPriceMicroLamports = null,
  } = {}) {
    if (!keypairPath || typeof keypairPath !== 'string') {
      throw new Error('SolanaSettlementProvider requires keypairPath');
    }
    this.commitment = String(commitment || 'confirmed').trim() || 'confirmed';
    this.pool = new SolanaRpcPool({ rpcUrls, commitment: this.commitment });
    this.signer = readSolanaKeypair(keypairPath);

    const mintStr = String(mint || '').trim();
    this.mint = mintStr ? new PublicKey(mintStr) : null;

    const programStr = String(programId || '').trim();
    this.programId = programStr ? new PublicKey(programStr) : LN_USDT_ESCROW_PROGRAM_ID;

    const tradeFeeCollectorStr = String(tradeFeeCollector || '').trim();
    this.tradeFeeCollector = tradeFeeCollectorStr ? new PublicKey(tradeFeeCollectorStr) : null;

    this.computeUnitLimit = toPosIntOrNull(computeUnitLimit);
    this.computeUnitPriceMicroLamports = toPosIntOrNull(computeUnitPriceMicroLamports);

    this._metaBySettlementId = new Map();
  }

  getProgramId() {
    return this.programId.toBase58();
  }

  getMint() {
    return this.mint ? this.mint.toBase58() : '';
  }

  async getSignerAddress() {
    return this.signer.publicKey.toBase58();
  }

  getTradeFeeCollector() {
    return this.tradeFeeCollector ? this.tradeFeeCollector.toBase58() : null;
  }

  async _sendAndConfirm(connection, tx) {
    const sig = await connection.sendRawTransaction(tx.serialize());
    const conf = await connection.confirmTransaction(sig, this.commitment);
    if (conf?.value?.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }

  async _ensureAta({ connection, mint, owner }) {
    const ata = await getAssociatedTokenAddress(mint, owner);
    try {
      await getAccount(connection, ata, this.commitment);
      return ata;
    } catch (_e) {
      return createAssociatedTokenAccount(connection, this.signer, mint, owner);
    }
  }

  _resolveMint(inputTerms = {}) {
    const fromTerms = String(inputTerms?.sol_mint || '').trim();
    if (fromTerms) return new PublicKey(fromTerms);
    if (this.mint) return this.mint;
    throw new Error('Missing Solana mint (set --solana-mint or include terms.sol_mint)');
  }

  _resolveTradeFeeCollector(inputTerms = {}) {
    const fromTerms = String(inputTerms?.trade_fee_collector || '').trim();
    if (fromTerms) return new PublicKey(fromTerms);
    if (this.tradeFeeCollector) return this.tradeFeeCollector;
    throw new Error('Missing trade fee collector (set --solana-trade-fee-collector or include terms.trade_fee_collector)');
  }

  _setMetadata(settlementId, metadata) {
    const id = String(settlementId || '').trim();
    if (!id) return;
    const prev = parseMetadataObject(this._metaBySettlementId.get(id));
    this._metaBySettlementId.set(id, { ...prev, ...metadata });
  }

  _getMetadata(settlementId) {
    return parseMetadataObject(this._metaBySettlementId.get(String(settlementId || '').trim()));
  }

  async _loadEscrowBySettlementId(settlementId) {
    const escrowPda = new PublicKey(String(settlementId || '').trim());
    const info = await this.pool.call(
      (connection) => connection.getAccountInfo(escrowPda, this.commitment),
      { label: 'settlement:escrow:get-by-id' }
    );
    if (!info) return null;
    return decodeEscrowState(info.data);
  }

  async feeSnapshot({ tradeFeeCollector = null } = {}) {
    const cfg = await this.pool.call(
      (connection) => getConfigState(connection, this.programId, this.commitment),
      { label: 'settlement:fees:get-config' }
    );
    if (!cfg) {
      throw new Error('Solana escrow program config is not initialized (run escrowctl config-init first)');
    }
    const collector = tradeFeeCollector
      ? new PublicKey(String(tradeFeeCollector).trim())
      : (this.tradeFeeCollector || cfg.feeCollector);
    const tradeCfg = await this.pool.call(
      (connection) => getTradeConfigState(connection, collector, this.programId, this.commitment),
      { label: 'settlement:fees:get-trade-config' }
    );
    if (!tradeCfg) throw new Error(`Trade fee config not initialized for ${collector.toBase58()}`);
    return {
      platformFeeBps: Number(cfg.feeBps || 0),
      platformFeeCollector: cfg.feeCollector.toBase58(),
      tradeFeeBps: Number(tradeCfg.feeBps || 0),
      tradeFeeCollector: collector.toBase58(),
    };
  }

  async lock(input) {
    const paymentHashHex = normalizeHex32(input?.paymentHashHex, 'paymentHashHex');
    const amountAtomic = String(input?.amountAtomic || '').trim();
    const amount = parseAmountAtomic(amountAtomic);
    const refundAfterUnix = Number(input?.refundAfterUnix);
    if (!Number.isFinite(refundAfterUnix) || refundAfterUnix <= 0) {
      throw new Error('refundAfterUnix must be a unix seconds integer');
    }

    const terms = parseMetadataObject(input?.terms);
    const mint = this._resolveMint(terms);
    const recipient = new PublicKey(String(input?.recipient || '').trim());
    const refund = new PublicKey(String(input?.refundAddress || '').trim());
    const tradeFeeCollector = this._resolveTradeFeeCollector(terms);

    const expectedPlatformFeeBps = Number(terms?.platform_fee_bps || 0);
    const expectedTradeFeeBps = Number(terms?.trade_fee_bps || 0);

    const build = await this.pool.call(
      async (connection) => {
        const payerAta = await this._ensureAta({
          connection,
          mint,
          owner: this.signer.publicKey,
        });
        return createEscrowTx({
          connection,
          payer: this.signer,
          payerTokenAccount: payerAta,
          mint,
          paymentHashHex,
          recipient,
          refund,
          refundAfterUnix,
          amount,
          expectedPlatformFeeBps,
          expectedTradeFeeBps,
          tradeFeeCollector,
          computeUnitLimit: this.computeUnitLimit,
          computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
          programId: this.programId,
        });
      },
      { label: 'settlement:lock:build' }
    );

    const txId = await this.pool.call(
      (connection) => this._sendAndConfirm(connection, build.tx),
      { label: 'settlement:lock:send' }
    );

    const settlementId = build.escrowPda.toBase58();
    this._setMetadata(settlementId, {
      settlement_id: settlementId,
      payment_hash_hex: paymentHashHex,
      tx_sig: txId,
      tx_id: txId,
      program_id: this.programId.toBase58(),
      escrow_pda: settlementId,
      vault_ata: build.vault.toBase58(),
      mint: mint.toBase58(),
      amount: amountAtomic,
      amount_atomic: amountAtomic,
      recipient: recipient.toBase58(),
      refund: refund.toBase58(),
      refund_after_unix: refundAfterUnix,
      trade_fee_collector: tradeFeeCollector.toBase58(),
      platform_fee_bps: expectedPlatformFeeBps,
      trade_fee_bps: expectedTradeFeeBps,
    });

    return {
      settlementId,
      txId,
      metadata: this._getMetadata(settlementId),
    };
  }

  async verifyPrePay(input) {
    try {
      const settlementId = String(input?.settlementId || '').trim();
      if (!settlementId) throw new Error('settlementId is required');

      const paymentHashHex = normalizeHex32(input?.paymentHashHex, 'paymentHashHex');
      const escrow = await this._loadEscrowBySettlementId(settlementId);
      if (!escrow) return { ok: false, error: 'escrow account not found on chain' };
      if (normalizeHex32(escrow.paymentHashHex, 'escrow.paymentHashHex') !== paymentHashHex) {
        return { ok: false, error: 'escrow payment_hash mismatch' };
      }
      if (Number(escrow.status) !== 0) {
        return { ok: false, error: `escrow is not active (status=${escrow.status})` };
      }

      if (input?.nowUnix !== undefined && input?.nowUnix !== null) {
        const nowUnix = Number(input.nowUnix);
        if (!Number.isFinite(nowUnix) || nowUnix <= 0) {
          return { ok: false, error: 'nowUnix must be a unix seconds number' };
        }
        if (BigInt(Math.trunc(nowUnix)) >= BigInt(escrow.refundAfter)) {
          return { ok: false, error: 'escrow refund_after already reached' };
        }
      }

      const metadata = {
        settlement_id: settlementId,
        payment_hash_hex: paymentHashHex,
        program_id: this.programId.toBase58(),
        escrow_pda: settlementId,
        vault_ata: escrow.vault.toBase58(),
        mint: escrow.mint.toBase58(),
        amount: escrow.netAmount.toString(),
        amount_atomic: escrow.netAmount.toString(),
        recipient: escrow.recipient.toBase58(),
        refund: escrow.refund.toBase58(),
        refund_after_unix: Number(escrow.refundAfter),
        fee_amount: escrow.feeAmount !== undefined && escrow.feeAmount !== null ? escrow.feeAmount.toString() : null,
        fee_bps: Number(escrow.feeBps || 0),
        platform_fee_bps: escrow.platformFeeBps !== undefined && escrow.platformFeeBps !== null ? Number(escrow.platformFeeBps) : null,
        platform_fee_collector: escrow.platformFeeCollector?.toBase58?.() ?? null,
        trade_fee_bps: escrow.tradeFeeBps !== undefined && escrow.tradeFeeBps !== null ? Number(escrow.tradeFeeBps) : null,
        trade_fee_collector: escrow.tradeFeeCollector?.toBase58?.() ?? null,
      };
      this._setMetadata(settlementId, metadata);
      return { ok: true, metadata };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async verifySwapPrePayOnchain({ terms, invoiceBody, escrowBody, nowUnix = null } = {}) {
    const result = await this.pool.call(
      async (connection) =>
        verifySwapPrePayOnchainCore({
          terms,
          invoiceBody,
          escrowBody,
          connection,
          commitment: this.commitment,
          now_unix: nowUnix,
        }),
      { label: 'settlement:verify-prepay' }
    );
    if (!result || typeof result !== 'object') return result;
    if (!result.onchain || typeof result.onchain !== 'object') return result;
    const onchain = result.onchain;
    if (!onchain.state || typeof onchain.state !== 'object') return result;
    return {
      ...result,
      onchain: {
        ...onchain,
        state: normalizeOnchainState(onchain.state),
      },
    };
  }

  async claim(input) {
    const settlementId = String(input?.settlementId || '').trim();
    if (!settlementId) throw new Error('settlementId is required');
    const preimageHex = normalizeHex32(input?.preimageHex, 'preimageHex');
    const paymentHashHex = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');

    const escrow = await this._loadEscrowBySettlementId(settlementId);
    if (!escrow) throw new Error('Escrow not found');
    if (normalizeHex32(escrow.paymentHashHex, 'escrow.paymentHashHex') !== paymentHashHex) {
      throw new Error('Escrow payment hash mismatch for preimage');
    }

    const mint = escrow.mint;
    const tradeFeeCollector = escrow.tradeFeeCollector ?? escrow.feeCollector;
    if (!tradeFeeCollector) throw new Error('Escrow missing tradeFeeCollector');

    const build = await this.pool.call(
      async (connection) => {
        const recipientTokenAccount = await this._ensureAta({
          connection,
          mint,
          owner: this.signer.publicKey,
        });
        return claimEscrowTx({
          connection,
          recipient: this.signer,
          recipientTokenAccount,
          mint,
          paymentHashHex,
          preimageHex,
          tradeFeeCollector,
          computeUnitLimit: this.computeUnitLimit,
          computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
          programId: this.programId,
        });
      },
      { label: 'settlement:claim:build' }
    );

    const txId = await this.pool.call(
      (connection) => this._sendAndConfirm(connection, build.tx),
      { label: 'settlement:claim:send' }
    );

    this._setMetadata(settlementId, {
      payment_hash_hex: paymentHashHex,
      tx_sig: txId,
      tx_id: txId,
      vault_ata: build.vault.toBase58(),
      mint: mint.toBase58(),
      trade_fee_collector: tradeFeeCollector.toBase58(),
    });

    return { txId };
  }

  async refund(input) {
    const settlementId = String(input?.settlementId || '').trim();
    if (!settlementId) throw new Error('settlementId is required');

    const escrow = await this._loadEscrowBySettlementId(settlementId);
    if (!escrow) throw new Error('Escrow not found');

    const paymentHashHex = normalizeHex32(escrow.paymentHashHex, 'escrow.paymentHashHex');
    const mint = escrow.mint;

    const build = await this.pool.call(
      async (connection) => {
        const refundTokenAccount = await this._ensureAta({
          connection,
          mint,
          owner: this.signer.publicKey,
        });
        return refundEscrowTx({
          connection,
          refund: this.signer,
          refundTokenAccount,
          mint,
          paymentHashHex,
          computeUnitLimit: this.computeUnitLimit,
          computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
          programId: this.programId,
        });
      },
      { label: 'settlement:refund:build' }
    );

    const txId = await this.pool.call(
      (connection) => this._sendAndConfirm(connection, build.tx),
      { label: 'settlement:refund:send' }
    );

    this._setMetadata(settlementId, {
      payment_hash_hex: paymentHashHex,
      tx_sig: txId,
      tx_id: txId,
      vault_ata: build.vault.toBase58(),
      mint: mint.toBase58(),
    });

    return { txId };
  }

  async waitForConfirmation(txId) {
    const sig = String(txId || '').trim();
    if (!sig) throw new Error('txId is required');
    await this.pool.call(
      async (connection) => {
        const conf = await connection.confirmTransaction(sig, this.commitment);
        if (conf?.value?.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
      },
      { label: 'settlement:wait-confirmation' }
    );
  }
}
