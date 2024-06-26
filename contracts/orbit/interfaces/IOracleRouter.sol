// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IOracleRouter {
  function getUnderlyingPrice(address oToken) external view returns (uint256);

  function isPriceOracle() external view returns (bool);

  function oTokenToOracleAddress(address oToken) external view returns (address);
}
