// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { Ownable } from '@openzeppelin/contracts/access/Ownable.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { IOToken } from './orbit/interfaces/IOToken.sol';
import { IOEther } from './orbit/interfaces/IOEther.sol';
import { ISpaceStation } from './orbit/interfaces/ISpaceStation.sol';
import { IOracleRouter } from './orbit/interfaces/IOracleRouter.sol';

/// @title Orbit Liquidator
/// @notice This contract allows owner to liquidate any Orbit positions.
contract OrbitLiquidator is Ownable {
  address public SPACE_STATION = 0x1E18C3cb491D908241D0db14b081B51be7B6e652;
  address public oETH = 0x0872b71EFC37CB8DdE22B2118De3d800427fdba0; // oEtherV2

  /// @notice Constructor to set the owner.
  constructor() Ownable(msg.sender) {}

  /// @notice Gets the price of a token from the oracle.
  /// @param oToken The address of the token to get the price of.
  /// @return The price of the token in wei.
  function getUnderlyingPrice(address oToken) external view returns (uint256) {
    return _getUnderlyingPrice(oToken);
  }

  /// @notice Gets details of an account's positions.
  /// @param account The address of the account to get details for.
  /// @return oTokens The array of oToken addresses.
  /// @return borrowBalanceUsd The array of borrow balances in USD.
  /// @return tokenBalanceUsd The array of token balances in USD.
  /// @return liquidityData The array containing liquidity and shortfall values.
  function getAccountDetails(
    address account
  )
  external
  view
  returns (
    address[] memory oTokens,
    uint256[] memory borrowBalanceUsd,
    uint256[] memory tokenBalanceUsd,
    uint256[2] memory liquidityData
  )
  {
    oTokens = ISpaceStation(SPACE_STATION).getAssetsIn(account);
    borrowBalanceUsd = new uint256[](oTokens.length);
    tokenBalanceUsd = new uint256[](oTokens.length);
    for (uint256 i = 0; i < oTokens.length; i++) {
      (uint256 possibleError, uint256 oTokenBalance, uint256 borrowBalance, uint256 exchangeRateMantissa) = IOToken(
        oTokens[i]
      ).getAccountSnapshot(account);
      require(possibleError == 0, 'getAccountSnapshot error!');

      uint256 underlyingPrice = _getUnderlyingPrice(oTokens[i]);
      tokenBalanceUsd[i] = (((oTokenBalance * exchangeRateMantissa) / 1e18) * underlyingPrice) / 1e18;
      borrowBalanceUsd[i] = (borrowBalance * underlyingPrice) / 1e18;
    }

    (uint256 err, uint256 liquidityVal, uint256 shortfall) = ISpaceStation(SPACE_STATION).getAccountLiquidity(account);
    require(err == 0, 'getAccountLiquidity error');

    liquidityData[0] = liquidityVal;
    liquidityData[1] = shortfall;
  }

  /// @notice Withdraws an amount of tokens the contract owner.
  /// @param token The address of the token to withdraw.
  /// @param amount The amount of tokens to withdraw.
  function withdrawTokens(address token, uint256 amount) external onlyOwner {
    require(IERC20(token).balanceOf(address(this)) >= amount, 'Insufficient token balance!');
    IERC20(token).transfer(owner(), amount);
  }

  /// @notice Withdraws all tokens to the contract owner.
  /// @param token The address of the token to withdraw.
  function withdrawAllTokens(address token) external onlyOwner {
    uint256 amount = IERC20(token).balanceOf(address(this));
    IERC20(token).transfer(owner(), amount);
  }

  /// @notice Withdraws an amount of ether to the contract owner.
  /// @param amount The amount of ether to withdraw.
  function withdrawEth(uint256 amount) external onlyOwner {
    require(address(this).balance >= amount, 'Insufficient ether balance!');
    (bool sent, ) = payable(owner()).call{ value: amount }('');
    require(sent, 'Failed to send Ether!');
  }

  /// @notice Withdraws all ether to the contract owner.
  function withdrawAllEth() external onlyOwner {
    uint256 amount = address(this).balance;
    (bool sent, ) = payable(owner()).call{ value: amount }('');
    require(sent, 'Failed to send Ether!');
  }

  /// @notice Liquidates a borrower's position in an OToken or OEther contract.
  /// @param target The address of the OToken or OEther contract to liquidate.
  /// @param borrower The address of the borrower to liquidate.
  /// @param collateral The asset to seize.
  /// @param value The amount of ether or token to send with the call.
  /// @return profitUsd The profit from the liquidation in USD.
  function liquidate(
    address target,
    address borrower,
    address collateral,
    uint256 value
  ) external returns (uint256 profitUsd) {
    uint256 collateralBefore = IOToken(collateral).balanceOfUnderlying(address(this));

    if (target == oETH) {
      require(address(this).balance >= value, 'Insufficient ether balance!');
      IOEther(payable(target)).liquidateBorrow{ value: value }(borrower, collateral);
    } else {
      address underlyingToken = IOToken(target).underlying();
      require(IERC20(underlyingToken).balanceOf(address(this)) >= value, 'Insufficient token balance!');
      IERC20(underlyingToken).approve(target, value);
      require(IOToken(target).liquidateBorrow(borrower, value, collateral) == 0, 'Failed liquidating!');
    }

    uint256 collateralAfter = IOToken(collateral).balanceOfUnderlying(address(this));
    uint256 collateralUnderlyingPrice = _getUnderlyingPrice(collateral);
    uint256 revenueCollateral = collateralAfter - collateralBefore;
    profitUsd = (revenueCollateral * collateralUnderlyingPrice) / 1e18;

    require(profitUsd > 0, 'No profit!');
  }

  /// @notice Internal function to get the price of a token from the oracle.
  /// @param oToken The address of the token to get the price of.
  /// @return The price of the token in wei.
  function _getUnderlyingPrice(address oToken) internal view returns (uint256) {
    address oracle = ISpaceStation(SPACE_STATION).oracle();
    return IOracleRouter(oracle).getUnderlyingPrice(oToken);
  }

  receive() external payable {}
}