import { Contract, type EventLog, formatEther } from 'ethers';
import { chunk, uniq } from 'lodash';

import {
  multicall3,
  oEtherV2,
  OrbitLiquidator,
  blastProvider,
  sleep,
  getPercentageValue,
  BORROWER_LOGS_LOOKBACK_BLOCKS,
  MAX_LOG_RANGE_BLOCKS,
  MIN_RPC_DELAY_MS,
  MIN_COLLATERAL_BUFFER_PERCENT,
  MIN_USD_BORROW,
  MAX_BORROWER_DETAILS_MULTICALL,
} from './commons';
import {
  contractAddresses,
  deploymentBlockNumbers,
  MIN_ETH_BORROW,
  oTokenAddresses,
  SAFE_COLLATERAL_BUFFER_PERCENT,
} from './constants';
import { OEtherV2Interface, orbitSpaceStationInterface, priceOracleInterface } from './interfaces';

/**
 * Iterate through log events on Orbit to determine accounts worth watching.
 */
export const getAccountsToWatch = async (startBlockNumber?: number | null) => {
  console.info('Preparing accounts to watch');

  // Iterate through log events from Orbit, finding all Borrow events, grab the borrower and return them
  const { borrowers, endBlockNumber } = await getBorrowersFromLogs(startBlockNumber);
  console.info(`Unique borrowers: ${borrowers.length}`);

  console.info('Fetching accounts with borrowed ETH...');
  const accountsToWatch: string[] = [];

  // We use multicalls to reduce the number of RPC calls, but these calls are limited in size, so we batch them into
  // batches of 500 borrowers
  const chunkedBorrowers = chunk(borrowers, MAX_BORROWER_DETAILS_MULTICALL);
  for (const accountBatch of chunkedBorrowers) {
    // Get the account details of every account in the batch
    // Account details are the tokens borrowed and the amount of tokens borrowed belonging to a borrower
    const accountDetails = await getAccountDetails(accountBatch);

    // For every borrower we check each of their accounts (from getAccountDetails) and calculate the potential
    // liquidation profitability. Accounts that are potentially profitable to liquidate are added to accountsToWatch
    const accountsToWatchBatch = await checkLiquidationPotentialOfAccounts(accountDetails, accountBatch);
    accountsToWatch.concat(accountsToWatchBatch);
  }
  console.info(`Fetched details of ${accountsToWatch.length} accounts with borrowed ETH`);

  return { borrowers: accountsToWatch, lastBlock: endBlockNumber };
};

/**
 * Iterate through Orbit log events, searching specifically for the "Borrow" event, to find a set of accounts to check for
 * liquidation potential.
 */
export const getBorrowersFromLogs = async (startBlockNumber?: number | null) => {
  console.info('Preparing borrowers to watch', { startBlockNumber });

  const borrowerSet = new Set<string>([]);
  let actualStartBlockNumber = startBlockNumber ? startBlockNumber - BORROWER_LOGS_LOOKBACK_BLOCKS : 0;
  const endBlockNumber = await blastProvider.getBlockNumber();
  while (actualStartBlockNumber <= endBlockNumber) {
    const actualEndBlockNumber = Math.min(actualStartBlockNumber + MAX_LOG_RANGE_BLOCKS, endBlockNumber);
    const events = await getOrbitLogs(actualStartBlockNumber, actualEndBlockNumber);
    console.info('Fetched events in block range', { start: actualStartBlockNumber, end: actualEndBlockNumber });

    for (const event of events) {
      borrowerSet.add(event.args.borrower ?? event.args.redeemer);
    }
    actualStartBlockNumber += MAX_LOG_RANGE_BLOCKS;
    await sleep(MIN_RPC_DELAY_MS);
  }
  const borrowers = [...borrowerSet.values()];
  console.info('Unique borrowers', { count: borrowers.length });

  return { borrowers: borrowers, endBlockNumber };
};

/**
 * Given a set of accounts (represented by EVM public addresses), get the details of each account.
 * The application does this using a multicall to reduce the number of RPC calls used.
 *
 * The process is:
 * - Encode function calls with the account address as an argument
 * - Call a multicall contract (multicall3) to actually do the call (and return the data)
 * - Decode the results of the call and return them
 */
export const getAccountDetails = async (borrowerBatch: string[]) => {
  console.info('Fetching accounts with borrowed ETH', { count: borrowerBatch.length });
  const getAccountDetailsCalls = borrowerBatch.map((borrower) => ({
    target: contractAddresses.OrbitLiquidator,
    callData: OrbitLiquidator.interface.encodeFunctionData('getAccountDetails', [borrower]),
  }));
  const [_blockNumber1, getAccountDetailsEncoded] = await multicall3.aggregate!.staticCall(getAccountDetailsCalls);

  return getAccountDetailsEncoded.map((data: string) =>
    OrbitLiquidator.interface.decodeFunctionResult('getAccountDetails', data)
  );
};

/**
 * Given a set of accounts (public EVM addresses) and their account details, check each account for its ability to be liquidated.
 * The function returns a set of accounts worth watching (for OEV opportunities).
 *
 * Multicalls are used to reduce RPC calls.
 *
 * The process is:
 * - Encode function calls to get account liquidity details (per account)
 * - Do the batch multicall using the encoded data
 * - Decode the multicall result
 * - Get the price of ETH vs USD
 * - Determine borrowed balance and liquidity
 */
export const checkLiquidationPotentialOfAccounts = async (
  accountDetails: [string[], bigint[], bigint[], [bigint, bigint]][], // [oTokens[], borrowBalanceUsd[], tokenBalanceUsd[], [liquidityValue, shortfall]]
  borrowers: string[]
) => {
  const accountsToWatch: string[] = [];

  // Encode the getAccountLiquidity call for use in a multicall for every borrower
  const getAccountLiquidityCalls = borrowers.map((borrower) => ({
    target: contractAddresses.orbitSpaceStation,
    callData: orbitSpaceStationInterface.encodeFunctionData('getAccountLiquidity', [borrower]),
  }));

  // Actually do the liquidity multicall
  console.info('Fetching account liquidity for accounts', { count: borrowers.length });

  // Now we determine the profitability per borrower
  for (let i = 0; i < accountDetails.length; i++) {
    const [oTokens, borrowBalances, tokenBalances, [shortfallValue, liquidityValue]] = accountDetails[i]!;
    const borrower = borrowers[i]!;
    let usdBorrowBalance = 0n;

    for (let i = 0; i < oTokens.length; i++) {
      const oToken = oTokens[i];
      if (oToken !== oTokenAddresses.oEtherV2) continue;
      // @ts-ignore
      usdBorrowBalance = BigInt(borrowBalances[i] - tokenBalances[i]);
    }
    if (usdBorrowBalance < MIN_USD_BORROW) {
      console.debug('Skipped borrower because the borrow balance is too low', {
        borrower,
        usdBorrowBalance: formatEther(usdBorrowBalance),
      });
      continue;
    }

    if (
      shortfallValue === 0n && // No shortfall
      liquidityValue > getPercentageValue(usdBorrowBalance, MIN_COLLATERAL_BUFFER_PERCENT) // The excess liquidity is more than the safe collateral buffer
    ) {
      console.debug('Skipped borrowers because it has enough collateral', {
        borrower,
        liquidity: formatEther(liquidityValue),
      });
      continue;
    }

    console.debug('Borrowers with enough borrowed amount and little collateral', {
      borrower,
      usdBorrowBalance: formatEther(usdBorrowBalance),
      liquidity: formatEther(liquidityValue),
    });
    accountsToWatch.push(borrower);
    await sleep(MIN_RPC_DELAY_MS);
  }

  return accountsToWatch;
};

// TODO new function from upstream, needs documentation
export const getOrbitLogs = async (fromBlock: number, toBlock: number) => {
  const logs = await blastProvider.getLogs({
    address: Object.values(oTokenAddresses),
    fromBlock,
    toBlock,
    topics: [
      [
        oEtherV2.filters.Borrow!().fragment.topicHash,
        oEtherV2.filters.LiquidateBorrow!().fragment.topicHash,
        oEtherV2.filters.RepayBorrow!().fragment.topicHash,
        oEtherV2.filters.Redeem!().fragment.topicHash,
      ],
    ],
  });

  return logs.map((log) => OEtherV2Interface.parseLog(log)!);
};
