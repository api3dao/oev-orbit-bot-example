import { AbiCoder, Interface, keccak256, solidityPacked } from 'ethers';
import { BidDetails } from './types';

export const priceOracleInterface = new Interface([
  'function getUnderlyingPrice(address oToken) external view returns (uint)',
]);

export const orbitSpaceStationInterface = new Interface([
  'function getAccountLiquidity(address account) public view returns (uint, uint, uint)',
  'function oracle() view returns (address oracle)', // not sure if this will work
  'function closeFactorMantissa() view returns (uint closeFactorMantissa)', // not sure if this will work
]);

export const OEtherV2Interface = new Interface([
  'function balanceOf(address owner) external view override returns (uint256)',
  'function balanceOfUnderlying(address owner) external override returns (uint)',
  'event Borrow(address borrower, uint borrowAmount, uint accountBorrows, uint totalBorrows)',
]);

export const OErc20DelegatorInterface = OEtherV2Interface;

export const multicall3Interface = new Interface([
  'function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calldata calls) public payable returns ((bool success, bytes returnData)[] memory returnData)',
  'function aggregate((address target, bytes callData)[] calldata calls) public payable returns (uint256 blockNumber, bytes[] memory returnData)',
]);

export const orbitEtherLiquidatorInterface = new Interface([
  'constructor (address spaceStation)',
  'function liquidate(address target,address borrower,address collateral,uint256 value) external returns (uint256 profitEth, uint256 profitUsd)',
  'function getAccountDetails(address account, address oEther) external view returns (address[] memory oTokens,uint256[] memory borrowBalanceEth,uint256[] memory tokenBalanceEth)',
]);

export const externalMulticallSimulatorInterface = new Interface([
  'function functionCall(address target,bytes memory data) external override returns (bytes memory)',
  'function multicall(bytes[] calldata data) external override returns (bytes[] memory returndata)',
]);

// See https://github.com/api3dao/oev-auction-house?tab=readme-ov-file#biddetails
export const encodeBidDetails = (bidDetails: BidDetails) => {
  const { oevProxyAddress, conditionType, conditionValue, updateSenderAddress, nonce } = bidDetails;

  return AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'int224', 'address', 'bytes32'],
    [oevProxyAddress, conditionType, conditionValue, updateSenderAddress, nonce]
  );
};

export const decodeBidDetails = (encodedBidDetails: string): BidDetails => {
  const bidDetails = AbiCoder.defaultAbiCoder().decode(
    ['address', 'uint256', 'int224', 'address', 'bytes32'],
    encodedBidDetails
  );
  const [oevProxyAddress, conditionType, conditionValue, updateSenderAddress, nonce] = bidDetails;
  return { oevProxyAddress, conditionType, conditionValue, updateSenderAddress, nonce };
};

export const deriveBidId = (bidderAddress: string, bidTopic: string, encodedBidDetails: string) => {
  return keccak256(
    solidityPacked(['address', 'bytes32', 'bytes32'], [bidderAddress, bidTopic, keccak256(encodedBidDetails)])
  );
};
