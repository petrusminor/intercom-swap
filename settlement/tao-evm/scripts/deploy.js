import hre from 'hardhat';

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const chainId = BigInt(network.chainId);
  if (chainId !== 964n) {
    throw new Error(`Wrong chainId: expected 964, got ${chainId}`);
  }

  const Factory = await hre.ethers.getContractFactory('TaoHTLC');
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(address);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
