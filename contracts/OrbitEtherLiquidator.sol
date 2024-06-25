/*
 * To simplify this repository the infrastructure to compile this contract has been omitted.
 *
 * This contract can be independently compiled and verified by using solc with optimisation enabled and runs set to 200.
 */

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./api3-contracts/utils/interfaces/IExternalMulticallSimulator.sol"; // Ref: https://github.com/api3dao/contracts
import "./orbit/OEther.sol"; // Ref: https://github.com/orbit-protocol/contracts/tree/main/contracts
import "./orbit/SpaceStation.sol"; // Ref: https://github.com/orbit-protocol/contracts/tree/main/contracts

/// @title Orbit liquidator that is able to liquidate OEther and OEtherV2
/// positions.
/// @notice This contract allows the owner to deposit and withdraw ether
contract OrbitEtherLiquidator is Ownable {
    OrbitSpaceStation public orbitStation;

    /// @param _orbitStation The address of the OrbitSpaceStation contract
    constructor(OrbitSpaceStation _orbitStation) Ownable(msg.sender) {
        orbitStation = _orbitStation;
    }

    /// @notice Allows the owner to deposit ether into the contract
    function deposit() external payable onlyOwner {
        require(msg.value > 0, "Must send ether");
    }

    /// @notice Allows the owner to withdraw ether from the contract
    /// @param amount The amount of ether to withdraw
    function withdrawEth(uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Insufficient balance");
        payable(owner()).transfer(amount);
    }

    /// @notice Allows the owner to withdraw all ether from the contract
    function withdrawAllEth() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ether to withdraw");
        payable(owner()).transfer(balance);
    }

    function withdrawToken(OToken token, uint256 amount) external onlyOwner {
        token.transfer(owner(), amount);
    }

    function withdrawAllToken(OToken token) external onlyOwner {
        token.transfer(owner(), token.balanceOf(address(this)));
    }

    function getAccountDetails(address account, OEther oEther)
        external
        view
        returns (
            OToken[] memory oTokens,
            uint256[] memory borrowBalanceEth,
            uint256[] memory tokenBalanceEth
        )
    {
        oTokens = orbitStation.getAssetsIn(account);
        borrowBalanceEth = new uint256[](oTokens.length);
        tokenBalanceEth = new uint256[](oTokens.length);
        uint256 ethPrice = orbitStation.oracle().getUnderlyingPrice(oEther);
        for (uint256 i = 0; i < oTokens.length; i++) {
            (
                uint256 possibleError,
                uint256 oTokenBalance,
                uint256 borrowBalance,
                uint256 exchangeRateMantissa
            ) = oTokens[i].getAccountSnapshot(account);
            require(possibleError == 0, "getAccountSnapshot error");

            borrowBalanceEth[i] = borrowBalance; // In ETH already
            uint256 underlyingPrice = orbitStation.oracle().getUnderlyingPrice(oTokens[i]);
            tokenBalanceEth[i] = oTokenBalance * exchangeRateMantissa / 1e18 * underlyingPrice / 1e18 * 1e18 / ethPrice;
        }
    }

    /// @notice Calls the `liquidateBorrow` function on the specified OEther or
    /// OEtherV2 contract. The function is callable by anyone, because the
    /// proceeds will be withdrawable only by the owner.
    /// @param target The address of the oToken contract to liquidate
    /// @param borrower The address of the borrower to liquidate
    /// @param collateral The asset to seize
    /// @param value The amount of ether to send with the call
    function liquidate(
        OEther target,
        address borrower,
        OToken collateral,
        uint256 value
    ) external returns (uint256 profitEth, uint256 profitUsd) {
        require(address(this).balance >= value, "Insufficient balance");

        uint256 collateralBefore = collateral.balanceOfUnderlying(address(this));

        target.liquidateBorrow{value: value}(borrower, collateral);

        uint256 collateralAfter = collateral.balanceOfUnderlying(address(this));
        uint256 ethExchangeRate = orbitStation.oracle().getUnderlyingPrice(OToken(address(target)));
        uint256 collateralExchangeRate = orbitStation.oracle().getUnderlyingPrice(OToken(address(collateral)));
        uint256 revenueEth = (collateralAfter - collateralBefore) * collateralExchangeRate / ethExchangeRate;
        profitEth = revenueEth - value;
        profitUsd = profitEth * ethExchangeRate / 1e18;
    }
}
