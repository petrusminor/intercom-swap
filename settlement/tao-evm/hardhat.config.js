import '@nomicfoundation/hardhat-ethers';

const privateKey = String(process.env.TAO_EVM_PRIVATE_KEY || '').trim();

export default {
  solidity: '0.8.20',
  networks: {
    tao: {
      url: process.env.TAO_EVM_RPC_URL || 'https://lite.chain.opentensor.ai',
      chainId: 964,
      accounts: privateKey ? [privateKey] : [],
    },
  },
};
