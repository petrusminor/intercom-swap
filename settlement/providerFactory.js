import {
  SolanaSettlementProvider,
  SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID,
} from './solana/SolanaSettlementProvider.js';
import { TaoEvmSettlementProvider } from './tao-evm/TaoEvmSettlementProvider.js';

export const SETTLEMENT_KIND = Object.freeze({
  SOLANA: 'solana',
  TAO_EVM: 'tao-evm',
});

export { SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID };

export function normalizeSettlementKind(value) {
  const kind = String(value || SETTLEMENT_KIND.SOLANA).trim().toLowerCase();
  if (kind === SETTLEMENT_KIND.SOLANA || kind === SETTLEMENT_KIND.TAO_EVM) return kind;
  throw new Error(`Invalid settlement kind: ${String(value)}`);
}

export function getSettlementBinding(kind, opts = {}) {
  const normalized = normalizeSettlementKind(kind);
  if (normalized === SETTLEMENT_KIND.SOLANA) {
    const programId = String(opts.solanaProgramId || SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID).trim();
    if (!programId) throw new Error('Missing Solana settlement program id');
    return {
      settlement_kind: normalized,
      binding_type: 'program',
      binding_id: programId,
    };
  }
  const htlcAddress = String(opts.taoHtlcAddress || process.env.TAO_EVM_HTLC_ADDRESS || '').trim();
  if (!htlcAddress) throw new Error('Missing TAO_EVM_HTLC_ADDRESS');
  const chainId = Number(opts.taoChainId);
  return {
    settlement_kind: normalized,
    binding_type: 'htlc_contract',
    binding_id: htlcAddress,
    ...(Number.isFinite(chainId) ? { chain_id: chainId } : {}),
  };
}

export function getSettlementAppBinding(kind, opts = {}) {
  return getSettlementBinding(kind, opts).binding_id;
}

export function getSettlementProvider(kind, opts = {}) {
  const normalized = normalizeSettlementKind(kind);
  if (normalized === SETTLEMENT_KIND.SOLANA) {
    const sol = opts.solana || {};
    return new SolanaSettlementProvider({
      rpcUrls: sol.rpcUrls,
      commitment: sol.commitment,
      keypairPath: sol.keypairPath,
      mint: sol.mint,
      programId: sol.programId,
      tradeFeeCollector: sol.tradeFeeCollector,
      computeUnitLimit: sol.computeUnitLimit,
      computeUnitPriceMicroLamports: sol.computeUnitPriceMicroLamports,
    });
  }

  const tao = opts.taoEvm || {};
  return new TaoEvmSettlementProvider({
    rpcUrl: tao.rpcUrl,
    chainId: tao.chainId,
    privateKey: tao.privateKey,
    confirmations: tao.confirmations,
    htlcAddress: tao.htlcAddress,
  });
}
