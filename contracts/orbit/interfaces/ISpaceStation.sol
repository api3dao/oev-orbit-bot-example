// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ISpaceStation {
  function accountAssets(address account, uint256 index) external view returns (address);

  function admin() external view returns (address);

  function allMarkets(uint256 index) external view returns (address);

  function borrowAllowed(address oToken, address borrower, uint256 borrowAmount) external returns (uint256);

  function borrowCapGuardian() external view returns (address);

  function borrowCaps(address oToken) external view returns (uint256);

  function borrowGuardianPaused(address oToken) external view returns (bool);

  function borrowVerify(address oToken, address borrower, uint256 borrowAmount) external;

  function checkMembership(address account, address oToken) external view returns (bool);

  function claimOrb(address[] calldata holders, address[] calldata oTokens, bool borrowers, bool suppliers) external;

  function claimOrb(address holder, address[] calldata oTokens) external;

  function claimOrb(address holder) external;

  function closeFactorMantissa() external view returns (uint256);

  function compAccrued(address account) external view returns (uint256);

  function compBorrowSpeeds(address oToken) external view returns (uint256);

  function compBorrowState(address oToken) external view returns (uint224 index, uint32 block);

  function compBorrowerIndex(address oToken, address borrower) external view returns (uint256);

  function compContributorSpeeds(address contributor) external view returns (uint256);

  function compInitialIndex() external view returns (uint224);

  function compRate() external view returns (uint256);

  function compReceivable(address account) external view returns (uint256);

  function compSpeeds(address oToken) external view returns (uint256);

  function compSupplierIndex(address oToken, address supplier) external view returns (uint256);

  function compSupplySpeeds(address oToken) external view returns (uint256);

  function compSupplyState(address oToken) external view returns (uint224 index, uint32 block);

  function comptrollerImplementation() external view returns (address);

  function enterMarkets(address[] calldata oTokens) external returns (uint256[] memory);

  function exitMarket(address oTokenAddress) external returns (uint256);

  function fixBadAccruals(address[] calldata affectedUsers, uint256[] calldata amounts) external;

  function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256);

  function getAllMarkets() external view returns (address[] memory);

  function getAssetsIn(address account) external view returns (address[] memory);

  function getBlockNumber() external view returns (uint256);

  function getHypotheticalAccountLiquidity(
    address account,
    address oTokenModify,
    uint256 redeemTokens,
    uint256 borrowAmount
  ) external view returns (uint256, uint256, uint256);

  function getTokenAddress() external view returns (address);

  function isComptroller() external view returns (bool);

  function isDeprecated(address oToken) external view returns (bool);

  function lastContributorBlock(address contributor) external view returns (uint256);

  function liquidateBorrowAllowed(
    address oTokenBorrowed,
    address oTokenCollateral,
    address liquidator,
    address borrower,
    uint256 repayAmount
  ) external returns (uint256);

  function liquidateBorrowVerify(
    address oTokenBorrowed,
    address oTokenCollateral,
    address liquidator,
    address borrower,
    uint256 actualRepayAmount,
    uint256 seizeTokens
  ) external;

  function liquidateCalculateSeizeTokens(
    address oTokenBorrowed,
    address oTokenCollateral,
    uint256 actualRepayAmount
  ) external view returns (uint256, uint256);

  function liquidationIncentiveMantissa() external view returns (uint256);

  function markets(
    address oToken
  ) external view returns (bool isListed, uint256 collateralFactorMantissa, bool isComped);

  function maxAssets() external view returns (uint256);

  function mintAllowed(address oToken, address minter, uint256 mintAmount) external returns (uint256);

  function mintGuardianPaused(address oToken) external view returns (bool);

  function mintVerify(address oToken, address minter, uint256 actualMintAmount, uint256 mintTokens) external;

  function oracle() external view returns (address);

  function pauseGuardian() external view returns (address);

  function pendingAdmin() external view returns (address);

  function pendingComptrollerImplementation() external view returns (address);

  function proposal65FixExecuted() external view returns (bool);

  function redeemAllowed(address oToken, address redeemer, uint256 redeemTokens) external returns (uint256);

  function redeemVerify(address oToken, address redeemer, uint256 redeemAmount, uint256 redeemTokens) external;

  function repayBorrowAllowed(
    address oToken,
    address payer,
    address borrower,
    uint256 repayAmount
  ) external returns (uint256);

  function repayBorrowVerify(
    address oToken,
    address payer,
    address borrower,
    uint256 actualRepayAmount,
    uint256 borrowerIndex
  ) external;

  function seizeAllowed(
    address oTokenCollateral,
    address oTokenBorrowed,
    address liquidator,
    address borrower,
    uint256 seizeTokens
  ) external returns (uint256);

  function seizeGuardianPaused() external view returns (bool);

  function seizeVerify(
    address oTokenCollateral,
    address oTokenBorrowed,
    address liquidator,
    address borrower,
    uint256 seizeTokens
  ) external;

  function tokenAddress() external view returns (address);

  function transferAllowed(address oToken, address src, address dst, uint256 transferTokens) external returns (uint256);

  function transferGuardianPaused() external view returns (bool);

  function transferVerify(address oToken, address src, address dst, uint256 transferTokens) external;

  function updateContributorRewards(address contributor) external;
}
