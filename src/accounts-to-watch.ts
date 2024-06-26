import { Contract, type EventLog } from 'ethers';
import { chunk, uniq } from 'lodash';

import {
  multicall3,
  oEtherV2,
  OrbitLiquidator,
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

  // Iterate through log events from Orbit, finding all Borrow events, grab the borrower and return them
  const { borrowers, endBlockNumber } = await getBorrowersFromLogs(startBlockNumber);
  console.info(`Unique borrowers: ${borrowers.length}`);

  console.info('Fetching accounts with borrowed ETH...');
  const accountsToWatch: string[] = [];

  // We use multicalls to reduce the number of RPC calls, but these calls are limited in size, so we batch them into
  // batches of 500 borrowers
  const chunkedBorrowers = chunk(borrowers, 500);
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
  const borrowers: string[] = [];
  let actualStartBlockNumber = startBlockNumber ? startBlockNumber - 300 : deploymentBlockNumbers.oEtherV2;
  const endBlockNumber = await blastProvider.getBlockNumber();
  while (actualStartBlockNumber < endBlockNumber) {
    const actualEndBlockNumber = Math.min(actualStartBlockNumber + 10_000, endBlockNumber);
    const events = await oEtherV2.queryFilter(oEtherV2.filters.Borrow!(), actualStartBlockNumber, actualEndBlockNumber);

    console.info('Fetched events from block', { start: actualStartBlockNumber, end: actualEndBlockNumber });

    for (const event of events) borrowers.push((event as EventLog).args.borrower);
    actualStartBlockNumber += 10_000;

    await sleep(100);
  }

  return { borrowers: uniq(borrowers), endBlockNumber };
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
    callData: OrbitLiquidator.interface.encodeFunctionData('getAccountDetails', [borrower, contractAddresses.oEtherV2]),
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
  accountDetails: [string[], bigint[]][],
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
  const [_blockNumber2, accountLiquidityReturndata] = await multicall3.aggregate!.staticCall(getAccountLiquidityCalls);
  const accountLiquidity = accountLiquidityReturndata.map((data: string) =>
    orbitSpaceStationInterface.decodeFunctionResult('getAccountLiquidity', data)
  );

  // Initialise a price oracle instance representing Orbit's price oracle
  // We will apply a modifier to this price to determine profitability in the event of a liquidation at the modified price
  const priceOracleAddress = await orbitSpaceStation.oracle!();
  const priceOracle = new Contract(priceOracleAddress, priceOracleInterface, blastProvider);
  const currentEthUsdPrice = await priceOracle.getUnderlyingPrice!(contractAddresses.oEtherV2);

  // Now we determine the profitability per borrower
  for (let i = 0; i < accountDetails.length; i++) {
    // Every borrower can have multiple borrowed balances
    const [oTokens, borrowBalances] = accountDetails[i]!; // NOTE: The borrow balances are in ETH.
    const borrower = borrowers[i]!;
    let ethBorrowBalance = 0n;

    // Search for the biggest borrowed balance
    for (let i = 0; i < oTokens.length; i++) {
      const oToken = oTokens[i];

      if (oToken !== contractAddresses.oEtherV2) continue;

      // TODO this is a bug from upstream I suspect; this should be Math.max(ethBorrowBalance, borrowBalances[i]!)
      ethBorrowBalance = borrowBalances[i]!;
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
      console.debug(`Skipped ${borrower} because it has enough collateral (liquidity: ${liquidity}) }}`);
      continue;
    }

    console.debug(
      `Account (${borrower}) has enough borrowed ETH but little collateral (ethBorrowBalance: ${ethBorrowBalance}, liquidity: ${liquidity})`
    );
    accountsToWatch.push(borrower);
  }

  return accountsToWatch;
};
