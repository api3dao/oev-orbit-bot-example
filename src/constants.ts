import { parseEther } from 'ethers';

export const SAFE_COLLATERAL_BUFFER_PERCENT = 3;

export const contractAddresses = {
  // Blast network
  api3OevEthUsdProxy: '0xCBE95Ba8fF327a1E3e6Bdade4C598277450145B3',
  api3ServerV1: '0x709944a48cAf83535e43471680fDA4905FB3920a',
  externalMulticallSimulator: '0xb45fe2838F47DCCEe00F635785EAF0c723F742E5',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  OrbitLiquidator: process.env.ETHER_LIQUIDATOR_ADDRESS ?? '0x',
  // OrbitLiquidator: '0x66E9CA29cD757E3c7C063163deCDB04feb1fC2bC',
  orbitSpaceStation: '0x1E18C3cb491D908241D0db14b081B51be7B6e652',

  // OEV network
  oevAuctionHouse: '0x34f13a5c0ad750d212267bcbc230c87aefd35cc5',
  oevExtendedSelfMulticall: '0x58366D36C610A28F881e622029982e3D273B5761',
};

export const oTokenAddresses = {
  oEtherV2: '0x0872b71EFC37CB8DdE22B2118De3d800427fdba0', // NOTE: oEther v1 uses Pyth and is deprecated and ignored by the bot.
  oUsdb: '0x9aECEdCD6A82d26F2f86D331B17a1C1676442A87',
  oWbtc: '0x8c415331761063e5d6b1c8e700f996b13603fc2e',
  // LRT strategies
  oEth: '0x795dCD51EaC6eb3123b7a4a1f906992EAA54Cb0e',
  oezETH: '0x4991b902F397dC16b0BBd21b0057a20b4B357AE2',
  ofwWETH: '0xB51b76C73fB24f472E0dd63Bb8195bD2170Bc65d',
};

export const MIN_ETH_BORROW = parseEther('0.01');

export const MIN_LIQUIDATION_PROFIT_USD = parseEther('0.01'); // NOTE: USD has 18 decimals, same as ETH.

export const BID_CONDITION = {
  LTE: 0n,
  GTE: 1n,
};

export const OEV_BID_VALIDITY = 30 * 60; // NOTE: Placing one bid on OEV network costs ~0.00003 ETH.

export const deploymentBlockNumbers = {
  orbitSpaceStation: 211_724, // https://blastscan.io/tx/0x4aa7e815dee47cc1ebe455ad5f68ff020616e11edbc45cec5d7871c495b861a3
  oEtherV2: 657_831, // https://blastscan.io/tx/0x92186344518698abd71f3de5a821c863c0d81ea97f3fed3ce8d324a3d081ae0c
  oEther: 221_188, // https://blastscan.io/tx/0xf767359de6ef73de18a5ff8302358e38cd37badacf1a8d84114da38d1f461cf2
  oWbtc: 1_636_042, // https://blastscan.io/tx/0x5541e23ba1f25c3402eb22633fc2cfb5480b9394e7b391e06a32ec7d503acff7
  oUsdb: 215_021, // https://blastscan.io/tx/0x4f4e4c86e6e8d81793c2088a4fb16d1dee3262597e42864754fcb4bdb04dd04a
};

export const oevAuctioneerConfig = {
  bidTopic: '0x76302d70726f642d61756374696f6e6565720000000000000000000000000000',
  minBidTimeToLiveSeconds: 15n,
};
