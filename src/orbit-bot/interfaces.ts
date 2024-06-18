import { Interface } from 'ethers';

export const priceOracleInterface = new Interface([
  'function getUnderlyingPrice(address oToken) external view returns (uint)',
]);

// TODO replace these with reduced interfaces like above
// export const orbitSpaceStationInterface = Interface.from(
//   '[{"inputs":[],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"error","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"info","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"detail","type":"uint256"}],"name":"Failure","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"oldAdmin","type":"address"},{"indexed":false,"internalType":"address","name":"newAdmin","type":"address"}],"name":"NewAdmin","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"oldImplementation","type":"address"},{"indexed":false,"internalType":"address","name":"newImplementation","type":"address"}],"name":"NewImplementation","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"oldPendingAdmin","type":"address"},{"indexed":false,"internalType":"address","name":"newPendingAdmin","type":"address"}],"name":"NewPendingAdmin","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"oldPendingImplementation","type":"address"},{"indexed":false,"internalType":"address","name":"newPendingImplementation","type":"address"}],"name":"NewPendingImplementation","type":"event"},{"stateMutability":"payable","type":"fallback"},{"inputs":[],"name":"_acceptAdmin","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"_acceptImplementation","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"newPendingAdmin","type":"address"}],"name":"_setPendingAdmin","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"newPendingImplementation","type":"address"}],"name":"_setPendingImplementation","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"admin","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"comptrollerImplementation","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"pendingAdmin","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"pendingComptrollerImplementation","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}]',
// );
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
