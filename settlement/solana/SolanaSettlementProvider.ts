import type { SettlementProvider } from '../SettlementProvider';
import {
  SolanaSettlementProvider as RuntimeSolanaSettlementProvider,
  SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID,
} from './SolanaSettlementProvider.js';

export { SOLANA_SETTLEMENT_DEFAULT_PROGRAM_ID };

export class SolanaSettlementProvider
  extends RuntimeSolanaSettlementProvider
  implements SettlementProvider {}
