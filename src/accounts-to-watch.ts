import { Contract, type EventLog } from 'ethers';
import { chunk } from 'lodash';

import {
  multicall3,
  oEtherV2,
  orbitEtherLiquidator,
  blastProvider,
  sleep,
  orbitSpaceStation,
  getPercentageValue,
} from './commons';
import { contractAddresses, deploymentBlockNumbers, MIN_ETH_BORROW, SAFE_COLLATERAL_BUFFER_PERCENT } from './constants';
import { orbitSpaceStationInterface, priceOracleInterface } from './interfaces';

/**
 * Iterate through log events on Orbit to determine accounts worth watching.
 */
export const getAccountsToWatch = async (startBlockNumber?: number | null) => {
  console.info('Preparing accounts to watch');

  const borrowerSet = new Set<string>([]);
  let actualStartBlockNumber = startBlockNumber ? startBlockNumber - 300 : deploymentBlockNumbers.oEtherV2;
  const endBlockNumber = await blastProvider.getBlockNumber();
  while (actualStartBlockNumber < endBlockNumber) {
    const actualEndBlockNumber = Math.min(actualStartBlockNumber + 10_000, endBlockNumber);
    const events = await oEtherV2.queryFilter(oEtherV2.filters.Borrow!(), actualStartBlockNumber, actualEndBlockNumber);
    console.info('Fetched events from block', { start: actualStartBlockNumber, end: actualEndBlockNumber });

    for (const event of events) borrowerSet.add((event as EventLog).args.borrower);
    actualStartBlockNumber += 10_000;
    await sleep(100);
  }
  const borrowers = [...borrowerSet.values()];
  console.info('Unique borrowers', { count: borrowers.length });

  console.info('Fetching accounts with borrowed ETH');
  const accountsToWatch = [];
  for (const borrowerBatch of chunk(borrowers, 500)) {
    console.info('Fetching accounts with borrowed ETH', { count: borrowerBatch.length });
    const getAccountDetailsCalls = borrowerBatch.map((borrower) => ({
      target: contractAddresses.orbitEtherLiquidator,
      callData: orbitEtherLiquidator.interface.encodeFunctionData('getAccountDetails', [
        borrower,
        contractAddresses.oEtherV2,
      ]),
    }));
    const [_blockNumber1, getAccountDetailsEncoded] = await multicall3.aggregate!.staticCall(getAccountDetailsCalls);
    const accountDetails = getAccountDetailsEncoded.map((data: string) =>
      orbitEtherLiquidator.interface.decodeFunctionResult('getAccountDetails', data)
    );

    // TODO: This should be in the contract
    const getAccountLiquidityCalls = borrowerBatch.map((borrower) => ({
      target: contractAddresses.orbitSpaceStation,
      callData: orbitSpaceStationInterface.encodeFunctionData('getAccountLiquidity', [borrower]),
    }));
    console.info('Fetching account liquidity for accounts', { count: borrowerBatch.length });
    const [_blockNumber2, accountLiquidityReturndata] =
      await multicall3.aggregate!.staticCall(getAccountLiquidityCalls);
    const accountLiquidity = accountLiquidityReturndata.map((data: string) =>
      orbitSpaceStationInterface.decodeFunctionResult('getAccountLiquidity', data)
    );

    const priceOracleAddress = await orbitSpaceStation.oracle!();
    const priceOracle = new Contract(priceOracleAddress, priceOracleInterface, blastProvider); // PriceOracleFactory.connect(priceOracleAddress, blastProvider);
    const currentEthUsdPrice = await priceOracle.getUnderlyingPrice!(contractAddresses.oEtherV2);

    for (let i = 0; i < accountDetails.length; i++) {
      const [oTokens, borrowBalances] = accountDetails[i]!; // NOTE: The borrow balances are in ETH.
      const borrower = borrowerBatch[i]!;
      let ethBorrowBalance = 0n;

      for (let i = 0; i < oTokens.length; i++) {
        const oToken = oTokens[i];

        if (oToken !== contractAddresses.oEtherV2) continue;

        ethBorrowBalance = borrowBalances[i];
      }
      if (!ethBorrowBalance) continue;

      if (ethBorrowBalance < MIN_ETH_BORROW) {
        console.debug('Skipped account because the borrow balance is too low', { borrower, ethBorrowBalance });
        continue;
      }

      const liquidity = accountLiquidity[i]!;
      const ethBorrowBalanceUsd = (ethBorrowBalance * currentEthUsdPrice) / 10n ** 18n;
      if (
        liquidity[2] === 0n && // No shortfall
        liquidity[1] > getPercentageValue(ethBorrowBalanceUsd, SAFE_COLLATERAL_BUFFER_PERCENT) // The excess liquidity is more than the safe collateral buffer
      ) {
        console.debug('Skipped account because it has enough collateral', { borrower, liquidity });
        continue;
      }

      console.debug('Account with enough borrowed ETH and little collateral', {
        borrower,
        ethBorrowBalance,
        liquidity,
      });
      accountsToWatch.push(borrower);
    }
  }
  console.info('Fetched accounts with borrowed ETH', { count: accountsToWatch.length });

  return { borrowers: accountsToWatch, lastBlock: endBlockNumber };
};
