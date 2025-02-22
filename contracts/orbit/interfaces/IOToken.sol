// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IOToken {
  function BlastContract() external view returns (address);

  function NO_ERROR() external view returns (uint256);

  function USDBBlast() external view returns (address);

  function WETHBlast() external view returns (address);

  function accrualBlockNumber() external view returns (uint256);

  function accrueInterest() external returns (uint256);

  function admin() external view returns (address payable);

  function allowance(address owner, address spender) external view returns (uint256);

  function approve(address spender, uint256 amount) external returns (bool);

  function balanceOf(address owner) external view returns (uint256);

  function balanceOfUnderlying(address owner) external returns (uint256);

  function borrow(uint256 borrowAmount) external returns (uint256);

  function borrowBalanceCurrent(address account) external returns (uint256);

  function borrowBalanceStored(address account) external view returns (uint256);

  function borrowIndex() external view returns (uint256);

  function borrowRatePerBlock() external view returns (uint256);

  function comptroller() external view returns (address);

  function decimals() external view returns (uint8);

  function exchangeRateCurrent() external returns (uint256);

  function exchangeRateStored() external view returns (uint256);

  function getAccountSnapshot(address account) external view returns (uint256, uint256, uint256, uint256);

  function getCash() external view returns (uint256);

  function implementation() external view returns (address);

  function interestRateModel() external view returns (address);

  function isCToken() external view returns (bool);

  function liquidateBorrow(address borrower, uint256 repayAmount, address cTokenCollateral) external returns (uint256);

  function mint(uint256 mintAmount) external returns (uint256);

  function name() external view returns (string memory);

  function pendingAdmin() external view returns (address payable);

  function protocolSeizeShareMantissa() external view returns (uint256);

  function redeem(uint256 redeemTokens) external returns (uint256);

  function redeemUnderlying(uint256 redeemAmount) external returns (uint256);

  function repayBorrow(uint256 repayAmount) external returns (uint256);

  function repayBorrowBehalf(address borrower, uint256 repayAmount) external returns (uint256);

  function reserveFactorMantissa() external view returns (uint256);

  function seize(address liquidator, address borrower, uint256 seizeTokens) external returns (uint256);

  function supplyRatePerBlock() external view returns (uint256);

  function sweepToken(address token) external;

  function symbol() external view returns (string memory);

  function totalBorrows() external view returns (uint256);

  function totalBorrowsCurrent() external returns (uint256);

  function totalReserves() external view returns (uint256);

  function totalSupply() external view returns (uint256);

  function transfer(address dst, uint256 amount) external returns (bool);

  function transferFrom(address src, address dst, uint256 amount) external returns (bool);

  function underlying() external view returns (address);
}
