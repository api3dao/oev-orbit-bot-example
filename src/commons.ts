import 'dotenv/config';

import { hardhatConfig } from '@api3/chains';
import {
  Api3ServerV1__factory as Api3ServerV1Factory,
  OevAuctionHouse__factory as OevAuctionHouseFactory,
} from '@api3/contracts';
import {
  FetchRequest,
  JsonRpcProvider,
  Network,
  ZeroAddress,
  VoidSigner,
  type AddressLike,
  BaseWallet,
  type BigNumberish,
  type BytesLike,
  Contract,
  Wallet,
  hexlify,
  randomBytes,
  getBytes,
  solidityPackedKeccak256,
  SigningKey,
  AbiCoder,
  parseEther,
} from 'ethers';

import {
  externalMulticallSimulatorInterface,
  multicall3Interface,
  OErc20DelegatorInterface,
  OEtherV2Interface,
  OrbitLiquidatorInterface,
  orbitSpaceStationInterface,
} from './interfaces';
import { Call } from './types';
import { contractAddresses, oTokenAddresses } from './constants';

export const MIN_COLLATERAL_BUFFER_PERCENT = 3; // The borrower is considered safe if they have at least X percent excess collateral relative to their borrowed amount.
export const BORROWER_LOGS_LOOKBACK_BLOCKS = 300; // The number of blocks to look back for the borrower logs.
export const MAX_LOG_RANGE_BLOCKS = 10_000; // The maximum number of blocks to fetch in a single call.
export const MIN_RPC_DELAY_MS = 100; // The minimum delay between RPC calls in milliseconds.
export const MAX_BORROWER_DETAILS_MULTICALL = 300; // The maximum number of borrowers to fetch details for in a single multicall.
export const MIN_USD_BORROW = parseEther(process.env.MIN_USD_BORROW ?? '0.01'); // The minimum amount of USD that a borrower must have borrowed to be considered for liquidation.
export const REPORT_FULFILLMENT_DELAY_MS = 300_000;
export const MAX_COLLATERAL_REPAY_PERCENTAGE = 95; // We leave some buffer to be sure there is enough collateral after the interest accrual.

// Math.min doesn't support bigint, so we have our implementation here
export const min = (...args: bigint[]) => {
  if (args.length === 0) throw new Error('min() requires at least one argument');
  let mn = args[0]!;
  for (let i = 1; i < args.length; i++) if (args[i]! < mn) mn = args[i]!;
  return mn;
};

export function generateRandomBytes32() {
  return hexlify(randomBytes(32));
}

export async function signData(airnode: BaseWallet, templateId: BytesLike, timestamp: number, data: BytesLike) {
  const signature = await airnode.signMessage(
    getBytes(solidityPackedKeccak256(['bytes32', 'uint256', 'bytes'], [templateId, timestamp, data]))
  );
  return signature;
}

export function deriveBeaconId(airnodeAddress: AddressLike, templateId: BytesLike) {
  return solidityPackedKeccak256(['address', 'bytes32'], [airnodeAddress, templateId]);
}

/**
 * Generates call data for a multicall that sets a dApi name-> data feed mapping and then updates that datafeed with
 * data of our choosing. This allows the app to simulate the liquidation profitability for different price movements.
 *
 * This process relies on various workings in the Api3ServerV1 contract. A useful reference can be found [here](https://docs.api3.org/reference/dapis/verify-beacon.html#verifying-beaconid).
 *
 * The process is:
 * - Generate a templateId (see above reference), timestamp and encoded datafeed value
 * - Sign the generated datafeed sample using a "dummy" private key
 *     - This key is not used on chain, it is used purely for simulating datafeed values. For performance, it is hard-coded.
 * - Derive the beaconId from a combination of the templateId and wallet address
 * - Generate call data for setDapiName which sets the target dApi name to the beacon (datafeed) we just created an update for
 * - Generate call data for updateBeaconWithSignedData using the generated and signed data
 *
 * The multicall data can then be used as part of a larger multicall which simulates a price movement.
 */
export async function getDapiTransmutationCalls(
  api3ServerV1Address: AddressLike,
  dapiName: BytesLike,
  value: BigNumberish
) {
  // Generating a private key may be a bit too compute-intensive. We can hardcode a mock one instead.
  const MOCK_AIRNODE_PRIVATE_KEY = '0x0fbcf3c01c9bcde58a6efa722b8d9019043dfaf5cdf557693442732e24b9f5ab';
  const airnode = new BaseWallet(new SigningKey(MOCK_AIRNODE_PRIVATE_KEY));
  // We want to use a Beacon ID that no one else has used to avoid griefing. Randomly generating the
  // template ID would solve that.
  const templateId = generateRandomBytes32();
  const timestamp = Math.floor(Date.now() / 1000);
  const data = AbiCoder.defaultAbiCoder().encode(['int256'], [value]);
  const signature = await signData(airnode, templateId, timestamp, data);
  const beaconId = deriveBeaconId(airnode.address, templateId);
  const api3ServerV1Interface = Api3ServerV1Factory.createInterface();
  return [
    {
      target: api3ServerV1Address,
      data: api3ServerV1Interface.encodeFunctionData('setDapiName', [dapiName, beaconId]),
    },
    {
      target: api3ServerV1Address,
      data: api3ServerV1Interface.encodeFunctionData('updateBeaconWithSignedData', [
        airnode.address,
        templateId,
        timestamp,
        data,
        signature,
      ]),
    },
  ];
}

export async function simulateTransmutationMulticall(externalMulticallSimulator: Contract, transmutationCalls: Call[]) {
  const transmutationCalldata = transmutationCalls.map((call) =>
    externalMulticallSimulatorInterface.encodeFunctionData('functionCall', [call.target, call.data])
  );

  const multicallReturndata = await externalMulticallSimulator
    .connect(new VoidSigner(ZeroAddress).connect(blastProvider))
    // @ts-expect-error removal of typechain
    .multicall.staticCall(transmutationCalldata);

  return multicallReturndata.map((returndata: string) => AbiCoder.defaultAbiCoder().decode(['bytes'], returndata)[0]);
}

export const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Common resources that can be initialised up-front

export const wallet = Wallet.fromPhrase(process.env.MNEMONIC!);

// ethers JsonRpcProvider has a nasty habit of generating additional RPC calls if the network is not statically set.
export const blastNetwork = new Network('blast', hardhatConfig.networks().blast!.chainId);

// ethers JsonRpcProvider _also_ has extreme timeouts (300 s), so we override this with a custom FetchRequest
const blastFetchRequest = new FetchRequest('https://blast-rpc.publicnode.com');
blastFetchRequest.timeout = 10_000; // NOTE: The default FetchRequest timeout is 300_000 ms
export const blastProvider = new JsonRpcProvider(blastFetchRequest, blastNetwork, {
  staticNetwork: blastNetwork,
});

export const orbitSpaceStation = new Contract(
  contractAddresses.orbitSpaceStation,
  orbitSpaceStationInterface,
  blastProvider
);
export const oEtherV2 = new Contract(oTokenAddresses.oEtherV2, OEtherV2Interface, blastProvider);
export const oUsdb = new Contract(oTokenAddresses.oUsdb, OErc20DelegatorInterface, blastProvider) as Contract & {
  balanceOf: (address: string) => Promise<bigint>;
  balanceOfUnderlying: { staticCall: (address: string) => Promise<bigint> };
};
export const multicall3 = new Contract(contractAddresses.multicall3, multicall3Interface, blastProvider);
export const externalMulticallSimulator = new Contract(
  contractAddresses.externalMulticallSimulator,
  externalMulticallSimulatorInterface,
  blastProvider
);
export const OrbitLiquidator = new Contract(contractAddresses.OrbitLiquidator, OrbitLiquidatorInterface, blastProvider);
export const api3ServerV1 = Api3ServerV1Factory.connect(contractAddresses.api3ServerV1, blastProvider);

export const getPercentageValue = (value: bigint, percent: number) => {
  const onePercent = 10 ** 10;
  return (value * BigInt(Math.trunc(percent * onePercent))) / BigInt(onePercent) / 100n;
};

export const oevNetwork = hardhatConfig.networks()['oev-network']!;

export const oevNetworkProvider = new JsonRpcProvider(oevNetwork.url, new Network('oev-network', oevNetwork.chainId), {
  staticNetwork: new Network('oev-network', oevNetwork.chainId),
  pollingInterval: 500,
});

export const oevAuctionHouse = OevAuctionHouseFactory.connect(contractAddresses.oevAuctionHouse, oevNetworkProvider);
