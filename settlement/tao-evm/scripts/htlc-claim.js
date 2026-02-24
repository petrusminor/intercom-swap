import hre from 'hardhat';

const HTLC_ABI = [
  'function claim(bytes32 swapId, bytes preimage)',
  'function swaps(bytes32 swapId) view returns (address sender, address receiver, uint256 amount, uint256 refundAfter, bytes32 hashlock, bool claimed, bool refunded)',
];

function mustHex32(value, label) {
  const s = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(`${label} must be 0x-prefixed 32-byte hex`);
  }
  return s.toLowerCase();
}

function mustPreimage(value) {
  const s = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error('PREIMAGE_HEX must be 0x-prefixed 32-byte hex');
  }
  return s.toLowerCase();
}

async function main() {
  const { ethers } = hre;
  const network = await ethers.provider.getNetwork();
  const chainId = BigInt(network.chainId);
  if (chainId !== 964n) {
    throw new Error(`Wrong chainId: expected 964, got ${chainId}`);
  }

  const htlcAddressRaw = String(process.env.TAO_EVM_HTLC_ADDRESS || '').trim();
  if (!htlcAddressRaw || !ethers.isAddress(htlcAddressRaw)) {
    throw new Error('TAO_EVM_HTLC_ADDRESS must be a valid address');
  }
  const htlcAddress = ethers.getAddress(htlcAddressRaw);

  const swapId = mustHex32(process.env.SWAP_ID, 'SWAP_ID');
  const preimageHex = mustPreimage(process.env.PREIMAGE_HEX);

  const [signer] = await ethers.getSigners();
  const htlc = new ethers.Contract(htlcAddress, HTLC_ABI, signer);

  const tx = await htlc.claim(swapId, preimageHex);
  const receipt = await tx.wait(1);

  const swap = await htlc.swaps(swapId);

  console.log(
    JSON.stringify({
      type: 'htlc_claim',
      chain_id: chainId.toString(),
      contract: htlcAddress,
      swap_id: swapId,
      tx_hash: tx.hash,
      block_number: receipt?.blockNumber ?? null,
      receipt_status: receipt?.status ?? null,
    })
  );

  console.log(
    JSON.stringify({
      type: 'htlc_swap_after_claim',
      swap_id: swapId,
      sender: swap.sender,
      receiver: swap.receiver,
      amount: swap.amount.toString(),
      refund_after: swap.refundAfter.toString(),
      hashlock: mustHex32(swap.hashlock, 'swap.hashlock'),
      claimed: Boolean(swap.claimed),
      refunded: Boolean(swap.refunded),
      sender_is_zero: String(swap.sender).toLowerCase() === ethers.ZeroAddress.toLowerCase(),
    })
  );
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
