A) FILE LIST

  CLI/config

  - scripts/rfq-maker.mjs (/home/validator1/intercom-swap/scripts/rfq-maker.mjs)
  - scripts/rfq-taker.mjs (/home/validator1/intercom-swap/scripts/rfq-taker.mjs)
  - scripts/swaprecover.mjs (/home/validator1/intercom-swap/scripts/swaprecover.mjs)
  - scripts/swapctl.mjs (/home/validator1/intercom-swap/scripts/swapctl.mjs)
  - scripts/escrowctl.mjs (/home/validator1/intercom-swap/scripts/escrowctl.mjs)
  - scripts/promptd.mjs (/home/validator1/intercom-swap/scripts/promptd.mjs)
  - src/prompt/config.js (/home/validator1/intercom-swap/src/prompt/config.js)
  - scripts/rfq-live-fast-restart.sh (/home/validator1/intercom-swap/scripts/rfq-live-fast-
    restart.sh)

  Solana client / RPC / transaction building

  - src/solana/lnUsdtEscrowClient.js (/home/validator1/intercom-swap/src/solana/
    lnUsdtEscrowClient.js)
  - src/solana/rpcPool.js (/home/validator1/intercom-swap/src/solana/rpcPool.js)
  - src/solana/computeBudget.js (/home/validator1/intercom-swap/src/solana/computeBudget.js)
  - src/solana/keypair.js (/home/validator1/intercom-swap/src/solana/keypair.js)
  - src/solana/verifyLnUsdtEscrow.js (/home/validator1/intercom-swap/src/solana/
    verifyLnUsdtEscrow.js)
  - src/swap/verify.js (/home/validator1/intercom-swap/src/swap/verify.js)
  - src/solana/localValidatorManager.js (/home/validator1/intercom-swap/src/solana/
    localValidatorManager.js)

  escrowctl wrapper/invocations

  - scripts/escrowctl.mjs (/home/validator1/intercom-swap/scripts/escrowctl.mjs)
  - scripts/escrowctl.sh (/home/validator1/intercom-swap/scripts/escrowctl.sh)
  - scripts/escrowctl.ps1 (/home/validator1/intercom-swap/scripts/escrowctl.ps1)
  - scripts/rfq-maker.mjs (/home/validator1/intercom-swap/scripts/rfq-maker.mjs) (runtime
    error hint: run escrowctl config-init first)
  - src/prompt/executor.js (/home/validator1/intercom-swap/src/prompt/executor.js) (runtime
    error hint: escrowctl config-init)

  Settlement ops (lock/claim/refund/status + finality waits)

  - scripts/rfq-maker.mjs (/home/validator1/intercom-swap/scripts/rfq-maker.mjs) (lock)
  - scripts/rfq-taker.mjs (/home/validator1/intercom-swap/scripts/rfq-taker.mjs) (verify +
    claim)
  - scripts/swaprecover.mjs (/home/validator1/intercom-swap/scripts/swaprecover.mjs) (claim/
    refund recovery)
  - src/prompt/executor.js (/home/validator1/intercom-swap/src/prompt/executor.js) (swap
    tools + direct sol tools + recovery tools)
  - src/prompt/tradeAuto.js (/home/validator1/intercom-swap/src/prompt/tradeAuto.js)
    (automation stage orchestration)
  - src/solana/lnUsdtEscrowClient.js (/home/validator1/intercom-swap/src/solana/
    lnUsdtEscrowClient.js)
  - src/swap/verify.js (/home/validator1/intercom-swap/src/swap/verify.js)
  - src/solana/verifyLnUsdtEscrow.js (/home/validator1/intercom-swap/src/solana/
    verifyLnUsdtEscrow.js)
  - src/receipts/store.js (/home/validator1/intercom-swap/src/receipts/store.js)

  Swap engine integration points (engine calls Solana / binds SOL settlement semantics)

  - scripts/rfq-maker.mjs (/home/validator1/intercom-swap/scripts/rfq-maker.mjs)
  - scripts/rfq-taker.mjs (/home/validator1/intercom-swap/scripts/rfq-taker.mjs)
  - src/swap/stateMachine.js (/home/validator1/intercom-swap/src/swap/stateMachine.js)
  - src/swap/schema.js (/home/validator1/intercom-swap/src/swap/schema.js)
  - src/swap/constants.js (/home/validator1/intercom-swap/src/swap/constants.js)
  - src/swap/app.js (/home/validator1/intercom-swap/src/swap/app.js)
  - src/prompt/executor.js (/home/validator1/intercom-swap/src/prompt/executor.js)
  - src/prompt/tradeAuto.js (/home/validator1/intercom-swap/src/prompt/tradeAuto.js)
  - src/prompt/tools.js (/home/validator1/intercom-swap/src/prompt/tools.js)

  B) CALL GRAPH

  1. RFQ bot maker lock path

  - scripts/rfq-maker.mjs:main
  - sc.on('sidechannel_message') receives swap.accept
  - createInvoiceAndEscrow(ctx)
  - fetchFeeSnapshot() -> SolanaRpcPool.call(getConfigState/getTradeConfigState)
  - ensureAta() -> getAssociatedTokenAddress + getAccount or createAssociatedTokenAccount
  - SolanaRpcPool.call(createEscrowTx) -> src/solana/lnUsdtEscrowClient.js:createEscrowTx ->
    buildInitInstruction
  - SolanaRpcPool.call(sendAndConfirm) -> sendRawTransaction +
    confirmTransaction('confirmed')
  - post swap.sol_escrow_created envelope, then applySwapEnvelope(...) updates state to
    escrow.

  2. RFQ bot taker verify + claim path

  - scripts/rfq-taker.mjs:main -> startSwap(...)
  - swap channel messages fed into applySwapEnvelope(...)
  - after LN_INVOICE + SOL_ESCROW_CREATED: verifySwapPrePayOnchain(...)
  - src/swap/verify.js:verifySwapPrePayOnchain
  - src/solana/verifyLnUsdtEscrow.js:verifyLnUsdtEscrowOnchain
  - getEscrowState(...) + vault ATA/account checks
  - LN pay (unchanged Lightning leg)
  - claimEscrowTx(...) via SolanaRpcPool.call
  - sendAndConfirm(...) -> sendRawTransaction + confirmTransaction('confirmed')
  - post swap.sol_claimed.

  3. Recovery CLI path

  - scripts/swaprecover.mjs:claim|refund
  - load receipt trade -> getEscrowState(...) (active status check)
  - ensureAta(...)
  - claimEscrowTx(...) or refundEscrowTx(...)
  - sendAndConfirm(...) with configured --commitment
  - update receipts to claimed or refunded.

  4. Prompt/automation path

  - scripts/promptd.mjs builds ToolExecutor + TradeAutoManager
  - src/prompt/tradeAuto.js stages call executor tools:
  - maker: intercomswap_swap_sol_escrow_init_and_post
  - taker verify/pay: intercomswap_swap_ln_pay_and_post_verified (includes on-chain verify)
  - taker claim: intercomswap_swap_sol_claim_and_post
  - src/prompt/executor.js handlers invoke:
  - createEscrowTx -> sendAndConfirm
  - verifySwapPrePayOnchain
  - getEscrowState -> claimEscrowTx/refundEscrowTx -> sendAndConfirm
  - then post signed swap envelopes and persist receipts.

  On-chain confirmation/finality waits used across these paths

  - Explicit waits: connection.confirmTransaction(sig, commitment) in maker/taker/recovery/
    prompt/escrowctl.
  - Default commitment is mostly 'confirmed'; some tools expose configurable --commitment.
  - ATA creation paths may also wait on confirmation (createAssociatedTokenAccount or
    executor getOrCreateAta + sendAndConfirm).

  C) MINIMAL INTERFACE CUT

  Proposed smallest boundary (engine-facing, no Solana types):

  type SettlementClient = {
    feeSnapshot(input: {
      tradeFeeCollector?: string;
      commitment?: 'processed'|'confirmed'|'finalized';
    }): Promise<{
      platformFeeBps: number;
      platformFeeCollector: string;
      tradeFeeBps: number;
      tradeFeeCollector: string;
    }>;

    lock(input: {
      paymentHashHex: string;
      mint: string;
      amountAtomic: string;
      recipient: string;
      refund: string;
      refundAfterUnix: number;
      expectedPlatformFeeBps: number;
      expectedTradeFeeBps: number;
      tradeFeeCollector: string;
      programId?: string;
      cuLimit?: number|null;
      cuPrice?: number|null;
      commitment?: 'processed'|'confirmed'|'finalized';
    }): Promise<{
      txSig: string;
      programId: string;
      escrowPda: string;
      vaultAta: string;
    }>;

    verifyPrePay(input: {
      terms: object;
      invoice: object;
      escrow: object;
      nowUnix?: number;
      commitment?: 'processed'|'confirmed'|'finalized';
    }): Promise<{
      ok: boolean;
      error: string|null;
      onchain?: {
        version: number;
        status: number;
        paymentHashHex: string;
        recipient: string;
        refund: string;
        refundAfterUnix: string;
        mint: string;
        netAmount: string;
        feeAmount: string;
        platformFeeBps?: number;
        platformFeeCollector?: string;
        tradeFeeBps?: number;
        tradeFeeCollector?: string;
        vaultAta: string;
      };
    }>;

    claim(input: {
      preimageHex: string;
      paymentHashHex: string;
      mint: string;
      recipient: string;
      tradeFeeCollector?: string;
      programId?: string;
      cuLimit?: number|null;
      cuPrice?: number|null;
      commitment?: 'processed'|'confirmed'|'finalized';
    }): Promise<{
      txSig: string;
      escrowPda: string;
      vaultAta: string;
    }>;

    refund(input: {
      paymentHashHex: string;
      mint: string;
      refund: string;
      programId?: string;
      cuLimit?: number|null;
      cuPrice?: number|null;
      commitment?: 'processed'|'confirmed'|'finalized';
    }): Promise<{
      txSig: string;
      escrowPda: string;
      vaultAta: string;
    }>;
  };

  Engine data currently expected back from Solana calls

  - Lock path: tx_sig, escrow_pda, vault_ata, program_id, mint, refund_after_unix, recipient,
    refund, amount.
  - Claim/refund path: tx_sig, escrow_pda (required in swap envelope), vault_ata (used in
    receipts/tool outputs).
  - Fee snapshot: platform_fee_bps, platform_fee_collector, trade_fee_bps,
    trade_fee_collector.
  - On-chain verify/status: escrow status, hash, recipient/refund authority, mint, refund
    timeout, net/fee amounts, fee collectors/BPS, vault ATA.
  - Receipts coupling fields: sol_mint, sol_program_id, sol_recipient, sol_refund,
    sol_escrow_pda, sol_vault_ata, sol_refund_after_unix, plus settlement tx signatures.
