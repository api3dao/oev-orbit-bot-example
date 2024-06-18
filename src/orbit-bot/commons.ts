import { hardhatConfig } from '@api3/chains';
import {
  Api3ServerV1__factory as Api3ServerV1Factory,
  OevAuctionHouse__factory as OevAuctionHouseFactory,
} from '@api3/contracts';
import {
  type ErrorCode,
  VoidSigner,
  ethers,
  parseEther,
  type AddressLike,
  type BaseWallet,
  type BigNumberish,
  type BytesLike,
  type EthersError,
  Contract,
} from 'ethers';

import { loadEnv } from '../env';

import {
  externalMulticallSimulatorInterface,
  multicall3Interface,
  OErc20DelegatorInterface,
  OEtherV2Interface,
  orbitEtherLiquidatorInterface,
  orbitSpaceStationInterface,
} from './interfaces';
import { type EnvConfig, envConfigSchema } from './schema';

export const contractAddresses = {
  // Blast network
  api3OevEthUsdProxy: '0xCBE95Ba8fF327a1E3e6Bdade4C598277450145B3',
  api3ServerV1: '0x709944a48cAf83535e43471680fDA4905FB3920a',
  externalMulticallSimulator: '0xb45fe2838F47DCCEe00F635785EAF0c723F742E5',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  oEther: '0xF9B3B455f5d900f62bC1792A6Ca6e1d47B989389',
  oEtherV2: '0x0872b71EFC37CB8DdE22B2118De3d800427fdba0',
  oUsdb: '0x9aECEdCD6A82d26F2f86D331B17a1C1676442A87',
  oWbtc: '0x8c415331761063e5d6b1c8e700f996b13603fc2e',
  orbitEtherLiquidator: '0x66E9CA29cD757E3c7C063163deCDB04feb1fC2bC',
  orbitSpaceStation: '0x1E18C3cb491D908241D0db14b081B51be7B6e652',

  // OEV network
  oevAuctionHouse: '0x34f13a5c0ad750d212267bcbc230c87aefd35cc5',
  oevExtendedSelfMulticall: '0x58366D36C610A28F881e622029982e3D273B5761',
};

export const deploymentBlockNumbers = {
  orbitSpaceStation: 211_724, // https://blastscan.io/tx/0x4aa7e815dee47cc1ebe455ad5f68ff020616e11edbc45cec5d7871c495b861a3
  oEtherV2: 657_831, // https://blastscan.io/tx/0x92186344518698abd71f3de5a821c863c0d81ea97f3fed3ce8d324a3d081ae0c
  oEther: 221_188, // https://blastscan.io/tx/0xf767359de6ef73de18a5ff8302358e38cd37badacf1a8d84114da38d1f461cf2
  oWbtc: 1_636_042, // https://blastscan.io/tx/0x5541e23ba1f25c3402eb22633fc2cfb5480b9394e7b391e06a32ec7d503acff7
  oUsdb: 215_021, // https://blastscan.io/tx/0x4f4e4c86e6e8d81793c2088a4fb16d1dee3262597e42864754fcb4bdb04dd04a
};

// TODO: This is OEV bot specific so it should be moved to OEV bot
export const oevAuctioneerConfig = {
  bidTopic: '0x76302d70726f642d61756374696f6e6565720000000000000000000000000000',
  minBidTimeToLiveSeconds: 15n,
};

const env = loadEnv<EnvConfig>(envConfigSchema);

export const min = (...args: bigint[]) => {
  if (args.length === 0) throw new Error('min() requires at least one argument');
  let mn = args[0]!;
  for (let i = 1; i < args.length; i++) if (args[i]! < mn) mn = args[i]!;
  return mn;
};

export const max = (...args: bigint[]) => {
  if (args.length === 0) throw new Error('max() requires at least one argument');
  let mx = args[0]!;
  for (let i = 1; i < args.length; i++) if (args[i]! > mx) mx = args[i]!;
  return mx;
};

export function generateRandomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32));
}

export async function signData(airnode: BaseWallet, templateId: BytesLike, timestamp: number, data: BytesLike) {
  const signature = await airnode.signMessage(
    ethers.getBytes(ethers.solidityPackedKeccak256(['bytes32', 'uint256', 'bytes'], [templateId, timestamp, data]))
  );
  return signature;
}

export function deriveBeaconId(airnodeAddress: AddressLike, templateId: BytesLike) {
  return ethers.solidityPackedKeccak256(['address', 'bytes32'], [airnodeAddress, templateId]);
}

export async function getDapiTransmutationCalls(
  api3ServerV1Address: AddressLike,
  dapiName: BytesLike,
  value: BigNumberish
) {
  // Generating a private key may be a bit too compute-intensive. We can hardcode a mock one instead.
  const MOCK_AIRNODE_PRIVATE_KEY = '0x0fbcf3c01c9bcde58a6efa722b8d9019043dfaf5cdf557693442732e24b9f5ab';
  const airnode = new ethers.BaseWallet(new ethers.SigningKey(MOCK_AIRNODE_PRIVATE_KEY));
  // We want to use a Beacon ID that no one else has used to avoid griefing. Randomly generating the
  // template ID would solve that.
  const templateId = generateRandomBytes32();
  const timestamp = Math.floor(Date.now() / 1000);
  const data = ethers.AbiCoder.defaultAbiCoder().encode(['int256'], [value]);
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

// eslint-disable-next-line functional/no-classes
export class ProviderWithFallback extends ethers.JsonRpcProvider {
  private readonly fallbackProvider: ethers.JsonRpcProvider | null = null;

  public constructor(
    url: ethers.FetchRequest | string,
    fallbackProvider: ethers.JsonRpcProvider,
    network?: ethers.Networkish,
    options?: ethers.JsonRpcApiProviderOptions
  ) {
    super(url, network, options);
    this.fallbackProvider = fallbackProvider;
  }

  public async send(method: string, params: any) {
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return new Promise((resolve, reject) =>
      super
        .send(method, params)
        .then((result) => resolve(result))
        .catch(async (error) => {
          if (this.fallbackProvider) {
            return (
              this.fallbackProvider
                .send(method, params)
                // eslint-disable-next-line promise/no-nesting
                .then((result) => resolve(result))
                // eslint-disable-next-line promise/no-nesting
                .catch(reject)
            );
          }
          reject(error as Error);
        })
    );
  }
}

export const blastNetwork = new ethers.Network('blast', hardhatConfig.networks().blast!.chainId);
export const blastFallbackFetchRequest = new ethers.FetchRequest(
  env.ORBIT_BLAST_REBLOK_RPC_API_KEY ? 'https://rpc.envelop.is/blast' : 'https://blast-rpc.publicnode.com'
);
blastFallbackFetchRequest.timeout = 10_000; // NOTE: The default FetchRequest timeout is 300_000 ms
export const blastFallbackProvider = new ethers.JsonRpcProvider(blastFallbackFetchRequest, blastNetwork, {
  staticNetwork: blastNetwork,
});
const blastFetchRequest = new ethers.FetchRequest(
  env.ORBIT_BLAST_REBLOK_RPC_API_KEY
    ? `https://rpc.reblok.io/blast?apikey=${env.ORBIT_BLAST_REBLOK_RPC_API_KEY}`
    : 'https://blast-rpc.publicnode.com'
);
blastFetchRequest.timeout = 10_000; // NOTE: The default FetchRequest timeout is 300_000 ms
export const blastProvider = new ProviderWithFallback(blastFetchRequest, blastFallbackProvider, blastNetwork, {
  staticNetwork: blastNetwork,
});

export interface Call {
  target: AddressLike;
  data: BytesLike;
}

export async function simulateTransmutationMulticall(externalMulticallSimulator: Contract, transmutationCalls: Call[]) {
  const transmutationCalldata = transmutationCalls.map((call) =>
    externalMulticallSimulatorInterface.encodeFunctionData('functionCall', [call.target, call.data])
  );

  const multicallReturndata = await externalMulticallSimulator
    .connect(new VoidSigner(ethers.ZeroAddress).connect(blastProvider))
    // @ts-expect-error removal of typechain
    .multicall.staticCall(transmutationCalldata);

  return multicallReturndata.map(
    (returndata: string) => ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], returndata)[0]
  );
}

export const wallet = new ethers.Wallet(env.ORBIT_BOT_WALLET_PRIVATE_KEY);

export const orbitSpaceStation = new Contract(
  contractAddresses.orbitSpaceStation,
  orbitSpaceStationInterface,
  blastProvider
);
export const oEtherV2 = new Contract(contractAddresses.oEtherV2, OEtherV2Interface, blastProvider);
export const oUsdb = new Contract(contractAddresses.oUsdb, OErc20DelegatorInterface, blastProvider) as Contract & {
  balanceOf: (address: string) => Promise<bigint>;
  balanceOfUnderlying: { staticCall: (address: string) => Promise<bigint> };
};
export const multicall3 = new Contract(contractAddresses.multicall3, multicall3Interface, blastProvider);
export const externalMulticallSimulator = new Contract(
  contractAddresses.externalMulticallSimulator,
  externalMulticallSimulatorInterface,
  blastProvider
);
export const orbitEtherLiquidator = new Contract(
  contractAddresses.orbitEtherLiquidator,
  orbitEtherLiquidatorInterface,
  blastProvider
);
export const api3ServerV1 = Api3ServerV1Factory.connect(contractAddresses.api3ServerV1, blastProvider);

// https://github.com/GoogleChromeLabs/jsbi/issues/30#issuecomment-953187833
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export const MIN_ETH_BORROW = parseEther('0.01');

export const MIN_LIQUIDATION_PROFIT_USD = parseEther('0.01'); // NOTE: USD has 18 decimals, same as ETH.

export const getPercentageValue = (value: bigint, percent: number) => {
  const onePercent = 10 ** 10;
  return (value * BigInt(Math.trunc(percent * onePercent))) / BigInt(onePercent) / 100n;
};

export const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const oevNetwork = hardhatConfig.networks()['oev-network']!;

export const oevNetworkProvider = new ethers.JsonRpcProvider(
  oevNetwork.url,
  new ethers.Network('oev-network', oevNetwork.chainId),
  {
    staticNetwork: new ethers.Network('oev-network', oevNetwork.chainId),
    pollingInterval: 500,
  }
);

export const oevAuctionHouse = OevAuctionHouseFactory.connect(contractAddresses.oevAuctionHouse, oevNetworkProvider);

// eslint-disable-next-line functional/no-classes
class SanitizedEthersError extends Error {
  public code: ErrorCode;

  public constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// Ethers error messages are sometimes serialized into huge strings containing the raw transaction bytes that is
// unnecessary. The serialized string is so big, that Grafana log forwarder needs to split the message into multiple
// parts (messing up with our log format). As a workaround, we pick the most useful properties from the error message.
export const sanitizeEthersError = (error: Error) => {
  const ethersError = error as EthersError;

  // We only care about ethers errors and they all should have a code.
  if (!ethersError.code) return error;

  // We don't care about the stack trace, nor error name - just the code and the message. According to the ethers
  // sources, the short message should always be defined.
  const sanitizedError = new SanitizedEthersError(ethersError.code, ethersError.shortMessage);
  // NOTE: We don't need the stack trace, because the errors are usually easy to find by the developer message and the
  // stack can be traced manually. This reduces the risk of the stack trace being too large and "exploding" the log
  // size.
  delete sanitizedError.stack;
  return sanitizedError;
};
