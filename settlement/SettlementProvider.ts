export interface SettlementProvider {
  lock(input: {
    paymentHashHex: string;
    amountAtomic: string;
    recipient: string;
    refundAddress: string;
    refundAfterUnix: number;
    terms: object;
  }): Promise<{
    settlementId: string;
    txId: string;
    metadata?: object;
  }>;

  getSignerAddress(): Promise<string>;

  feeSnapshot(input?: {
    tradeFeeCollector?: string | null;
  }): Promise<{
    platformFeeBps: number;
    platformFeeCollector: string;
    tradeFeeBps: number;
    tradeFeeCollector: string;
  }>;

  verifySwapPrePayOnchain(input: {
    terms: object;
    invoiceBody: object;
    escrowBody: object;
    nowUnix?: number;
  }): Promise<{
    ok: boolean;
    error?: string;
    decoded_invoice?: object;
    onchain?: object;
  }>;

  verifyPrePay(input: {
    settlementId: string;
    paymentHashHex: string;
    nowUnix?: number;
  }): Promise<{
    ok: boolean;
    error?: string;
    metadata?: object;
  }>;

  claim(input: {
    settlementId: string;
    preimageHex: string;
  }): Promise<{ txId: string }>;

  refund(input: {
    settlementId: string;
  }): Promise<{ txId: string }>;

  waitForConfirmation(txId: string): Promise<void>;
}
