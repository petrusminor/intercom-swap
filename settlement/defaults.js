import { SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID } from './solana/SolanaSettlementProvider.js';
import { getDefaultTaoEvmHtlcAddress } from './tao-evm/TaoEvmSettlementProvider.js';

export { SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID };

export function resolveSolanaProgramId(solanaProgramId) {
  return String(solanaProgramId || SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID).trim();
}

export function resolveTaoEvmHtlcAddress(taoHtlcAddress) {
  return String(
    taoHtlcAddress ||
    process.env.TAO_EVM_HTLC_ADDRESS ||
    getDefaultTaoEvmHtlcAddress?.() ||
    ''
  ).trim();
}
