#!/usr/bin/env node
import process from 'node:process';

import { formatEther } from 'ethers';
import { TaoEvmSettlementProvider } from '../settlement/tao-evm/TaoEvmSettlementProvider.js';

const TAO_CHAIN_ID = 964n;
const DEFAULT_RPC_URL = 'https://lite.chain.opentensor.ai';

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main() {
  const settlement = new TaoEvmSettlementProvider({
    rpcUrl: process.env.TAO_EVM_RPC_URL || DEFAULT_RPC_URL,
    chainId: TAO_CHAIN_ID,
    privateKey: process.env.TAO_EVM_PRIVATE_KEY || '',
    confirmations: 1,
  });

  const network = await settlement.provider.getNetwork();
  const chainId = BigInt(network.chainId);
  process.stdout.write(`${JSON.stringify({ type: 'tao_chain', rpc: settlement.rpcUrl, chain_id: chainId.toString() })}\n`);
  if (chainId !== TAO_CHAIN_ID) {
    die(`Wrong chainId: expected ${TAO_CHAIN_ID} got ${chainId}`);
  }

  const address = await settlement.getSignerAddress();
  process.stdout.write(`${JSON.stringify({ type: 'tao_wallet', address })}\n`);

  const balanceWei = await settlement.provider.getBalance(address);
  process.stdout.write(
    `${JSON.stringify({ type: 'tao_balance', address, wei: balanceWei.toString(), tao: formatEther(balanceWei) })}\n`
  );

  const gasLimit = await settlement.provider
    .estimateGas({
      from: address,
      to: address,
      value: 0n,
    })
    .catch(() => 21_000n);

  const feeData = await settlement.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  const estimatedFeeWei = gasLimit * gasPrice;

  if (estimatedFeeWei > 0n && balanceWei < estimatedFeeWei) {
    die(`Insufficient balance for gas: need at least ${estimatedFeeWei} wei, have ${balanceWei} wei`);
  }

  const tx = await settlement.wallet.sendTransaction({
    to: address,
    value: 0n,
  });
  process.stdout.write(
    `${JSON.stringify({
      type: 'tao_tx_sent',
      tx_hash: tx.hash,
      nonce: tx.nonce,
      gas_limit: tx.gasLimit ? tx.gasLimit.toString() : null,
    })}\n`
  );

  await settlement.waitForConfirmation(tx.hash);
  const receipt = await settlement.provider.getTransactionReceipt(tx.hash);
  if (!receipt) die(`Transaction receipt missing after confirmation wait: ${tx.hash}`);

  process.stdout.write(
    `${JSON.stringify({
      type: 'tao_tx_confirmed',
      tx_hash: tx.hash,
      block_number: receipt.blockNumber,
      status: receipt.status,
      gas_used: receipt.gasUsed ? receipt.gasUsed.toString() : null,
    })}\n`
  );

  if (Number(receipt.status) !== 1) {
    die(`Transaction failed with status=${receipt.status}`);
  }
}

main().catch((err) => {
  die(err?.message || String(err));
});
