#!/usr/bin/env node
import process from 'node:process';

import { JsonRpcProvider, Wallet, formatEther, getAddress, isAddress } from 'ethers';

const EXPECTED_CHAIN_ID = 964n;

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireEnv(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) die(`Missing ${name}`);
  return v;
}

function normalizePrivateKey(value) {
  const v = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    die('TAO_EVM_PRIVATE_KEY must be 0x-prefixed 32-byte hex');
  }
  return v;
}

function normalizeAddressEnv(value, label) {
  const v = String(value || '').trim();
  if (!isAddress(v)) die(`${label} must be a valid EVM address`);
  return getAddress(v);
}

async function main() {
  const rpcUrl = requireEnv('TAO_EVM_RPC_URL');
  const privateKey = normalizePrivateKey(requireEnv('TAO_EVM_PRIVATE_KEY'));
  const htlcAddress = normalizeAddressEnv(requireEnv('TAO_EVM_HTLC_ADDRESS'), 'TAO_EVM_HTLC_ADDRESS');

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const signerAddress = await wallet.getAddress();

  const network = await provider.getNetwork();
  const chainId = BigInt(network.chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    die(`Wrong chainId: expected ${EXPECTED_CHAIN_ID} got ${chainId}`);
  }

  const balanceWei = await provider.getBalance(signerAddress);
  const code = await provider.getCode(htlcAddress);
  const hasContractCode = typeof code === 'string' && code !== '0x' && code.length > 2;
  if (!hasContractCode) {
    die(`No contract code at TAO_EVM_HTLC_ADDRESS=${htlcAddress}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      type: 'tao_env_ok',
      rpc_url: rpcUrl,
      chain_id: chainId.toString(),
      signer_address: signerAddress,
      signer_balance_wei: balanceWei.toString(),
      signer_balance_tao: formatEther(balanceWei),
      htlc_address: htlcAddress,
      htlc_code_bytes: String((code.length - 2) / 2),
    })}\n`
  );
  process.stdout.write('PASS tao-env-check\n');
}

main().catch((err) => {
  die(err?.message || String(err));
});
