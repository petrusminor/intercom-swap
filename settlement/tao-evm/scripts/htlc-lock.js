import hre from 'hardhat';

const HTLC_ABI = [
  'function lock(address receiver, bytes32 hashlock, uint256 refundAfter, bytes32 clientSalt) payable returns (bytes32 swapId)',
  'function swaps(bytes32 swapId) view returns (address sender, address receiver, uint256 amount, uint256 refundAfter, bytes32 hashlock, bool claimed, bool refunded)',
];

function mustHex32(value, label) {
  const s = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(`${label} must be 0x-prefixed 32-byte hex`);
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

  const [signer] = await ethers.getSigners();
  const sender = await signer.getAddress();
  const receiver = sender;

  const amountWei = ethers.parseEther('0.001');
  const preimageBytes = ethers.randomBytes(32);
  const preimageHex = ethers.hexlify(preimageBytes).toLowerCase();
  const hashlock = ethers.sha256(preimageBytes).toLowerCase();

  const latestBlock = await ethers.provider.getBlock('latest');
  const refundAfter = BigInt(Number(latestBlock?.timestamp || Math.floor(Date.now() / 1000)) + 300);
  const clientSalt = ethers.hexlify(ethers.randomBytes(32)).toLowerCase();

  const htlc = new ethers.Contract(htlcAddress, HTLC_ABI, signer);

  const tx = await htlc.lock(receiver, hashlock, refundAfter, clientSalt, {
    value: amountWei,
  });
  const receipt = await tx.wait(1);

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint256', 'uint256', 'bytes32', 'bytes32'],
    [sender, receiver, amountWei, refundAfter, hashlock, clientSalt]
  );
  const swapId = ethers.keccak256(encoded).toLowerCase();

  const swap = await htlc.swaps(swapId);

  console.log(
    JSON.stringify({
      type: 'htlc_lock',
      chain_id: chainId.toString(),
      contract: htlcAddress,
      sender,
      receiver,
      amount_wei: amountWei.toString(),
      refund_after_unix: refundAfter.toString(),
      hashlock,
      client_salt: clientSalt,
      tx_hash: tx.hash,
      block_number: receipt?.blockNumber ?? null,
    })
  );

  console.log(
    JSON.stringify({
      type: 'htlc_swap',
      swap_id: swapId,
      sender: swap.sender,
      receiver: swap.receiver,
      amount: swap.amount.toString(),
      refund_after: swap.refundAfter.toString(),
      hashlock: mustHex32(swap.hashlock, 'swap.hashlock'),
      claimed: Boolean(swap.claimed),
      refunded: Boolean(swap.refunded),
    })
  );

  console.log(`SWAP_ID=${swapId}`);
  console.log(`PREIMAGE_HEX=${preimageHex}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
