import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Contract, type EventLog } from 'ethers';
import { chunk } from 'lodash';

import {
  contractAddresses,
  deploymentBlockNumbers,
  multicall3,
  oEtherV2,
  orbitEtherLiquidator,
  blastProvider,
  MIN_ETH_BORROW,
  sleep,
  orbitSpaceStation,
  getPercentageValue,
} from './commons';
import { orbitSpaceStationInterface, priceOracleInterface } from './interfaces';
import { logger } from './logger';

const SAFE_COLLATERAL_BUFFER_PERCENT = 3;

/**
 * Iterate through log events on Orbit to determine accounts worth watching.
 *
 * @async
 * @param {number | null} startBlockNumber - The start block number to fetch events from. Optional.
 * @returns {Object} - The borrowers and the last block number.
 */
export const getAccountsToWatch = async (startBlockNumber?: number | null) => {
  logger.info('Preparing accounts to watch');

  const borrowerSet = new Set<string>([]);
  let actualStartBlockNumber = startBlockNumber ? startBlockNumber - 300 : deploymentBlockNumbers.oEtherV2;
  const endBlockNumber = await blastProvider.getBlockNumber();
  while (actualStartBlockNumber < endBlockNumber) {
    const actualEndBlockNumber = Math.min(actualStartBlockNumber + 10_000, endBlockNumber);
    const events = await oEtherV2.queryFilter(oEtherV2.filters.Borrow!(), actualStartBlockNumber, actualEndBlockNumber);
    logger.info('Fetched events from block', { start: actualStartBlockNumber, end: actualEndBlockNumber });

    for (const event of events) borrowerSet.add((event as EventLog).args.borrower);
    actualStartBlockNumber += 10_000;
    await sleep(100);
  }
  const borrowers = [...borrowerSet.values()];
  logger.info('Unique borrowers', { count: borrowers.length });

  logger.info('Fetching accounts with borrowed ETH');
  const accountsToWatch = [];
  for (const borrowerBatch of chunk(borrowers, 500)) {
    logger.info('Fetching accounts with borrowed ETH', { count: borrowerBatch.length });
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
    logger.info('Fetching account liquidity for accounts', { count: borrowerBatch.length });
    const [_blockNumber2, accountLiquidityReturndata] =
      await multicall3.aggregate!.staticCall(getAccountLiquidityCalls);
    const accountLiquidity = accountLiquidityReturndata.map((data: string) =>
      orbitSpaceStationInterface.decodeFunctionResult('getAccountLiquidity', data)
    );

    const priceOracleAddress = await orbitSpaceStation.oracle!();
    const priceOracle = new Contract(priceOracleAddress, priceOracleInterface, blastProvider); // PriceOracleFactory.connect(priceOracleAddress, blastProvider);
    const currentEthUsdPrice = await priceOracle.getUnderlyingPrice!(contractAddresses.oEtherV2);

    // eslint-disable-next-line unicorn/no-for-loop
    for (let i = 0; i < accountDetails.length; i++) {
      const [oTokens, borrowBalances] = accountDetails[i]!; // NOTE: The borrow balances are in ETH.
      const borrower = borrowerBatch[i]!;
      let ethBorrowBalance = 0n;

      // eslint-disable-next-line unicorn/no-for-loop
      for (let i = 0; i < oTokens.length; i++) {
        const oToken = oTokens[i];

        if (oToken !== contractAddresses.oEtherV2) continue;

        ethBorrowBalance = borrowBalances[i];
      }
      if (!ethBorrowBalance) continue;

      if (ethBorrowBalance < MIN_ETH_BORROW) {
        logger.debug('Skipped account because the borrow balance is too low', { borrower, ethBorrowBalance });
        continue;
      }

      const liquidity = accountLiquidity[i]!;
      const ethBorrowBalanceUsd = (ethBorrowBalance * currentEthUsdPrice) / 10n ** 18n;
      if (
        liquidity[2] === 0n && // No shortfall
        liquidity[1] > getPercentageValue(ethBorrowBalanceUsd, SAFE_COLLATERAL_BUFFER_PERCENT) // The excess liquidity is more than the safe collateral buffer
      ) {
        logger.debug('Skipped account because it has enough collateral', { borrower, liquidity });
        continue;
      }

      logger.debug('Account with enough borrowed ETH and little collateral', { borrower, ethBorrowBalance, liquidity });
      accountsToWatch.push(borrower);
    }
  }
  logger.info('Fetched accounts with borrowed ETH', { count: accountsToWatch.length });

  return { borrowers: accountsToWatch, lastBlock: endBlockNumber };
};

export const ACCOUNTS_TO_WATCH_FILE_PATH = join(__dirname, 'accounts-to-watch.json.ignore');

export const persistAccountsToWatch = async (accountsFn = getAccountsToWatch) => {
  const accounts = await accountsFn();
  writeFileSync(ACCOUNTS_TO_WATCH_FILE_PATH, JSON.stringify(accounts, null, 2));
};

export const getAccountsFromFile = () =>
  JSON.parse(readFileSync(ACCOUNTS_TO_WATCH_FILE_PATH, 'utf8')) as { borrowers: string[]; lastBlock: number };
