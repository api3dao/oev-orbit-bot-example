import { Contract, type EventLog } from 'ethers';
import { chunk, uniq } from 'lodash';

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

  const { borrowers, endBlockNumber } = await getBorrowersFromLogs(startBlockNumber);
  console.info(`Unique borrowers: ${borrowers.length}`);

  console.info('Fetching accounts with borrowed ETH...');
  const accountsToWatch: string[] = [];
  for (const accountBatch of chunk(borrowers, 500)) {
    const accountDetails = await getAccountDetails(accountBatch);

    const accountsToWatchBatch = await checkHealthOfAccounts(accountDetails, accountBatch);
    accountsToWatch.concat(accountsToWatchBatch);
  }
  console.info(`Fetched details of ${accountsToWatch.length} accounts with borrowed ETH`);

  return { borrowers: accountsToWatch, lastBlock: endBlockNumber };
};

/**
 * Iterate through log events, searching specifically for the "Borrow" event, to find a set of accounts to check for
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
    target: contractAddresses.orbitEtherLiquidator,
    callData: orbitEtherLiquidator.interface.encodeFunctionData('getAccountDetails', [
      borrower,
      contractAddresses.oEtherV2,
    ]),
  }));
  const [_blockNumber1, getAccountDetailsEncoded] = await multicall3.aggregate!.staticCall(getAccountDetailsCalls);

  return getAccountDetailsEncoded.map((data: string) =>
    orbitEtherLiquidator.interface.decodeFunctionResult('getAccountDetails', data)
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
export const checkHealthOfAccounts = async (accountDetails: [string[], bigint[]][], accounts: string[]) => {
  const accountsToWatch = [];

  const getAccountLiquidityCalls = accounts.map((borrower) => ({
    target: contractAddresses.orbitSpaceStation,
    callData: orbitSpaceStationInterface.encodeFunctionData('getAccountLiquidity', [borrower]),
  }));
  console.info('Fetching account liquidity for accounts', { count: accounts.length });
  const [_blockNumber2, accountLiquidityReturndata] = await multicall3.aggregate!.staticCall(getAccountLiquidityCalls);
  const accountLiquidity = accountLiquidityReturndata.map((data: string) =>
    orbitSpaceStationInterface.decodeFunctionResult('getAccountLiquidity', data)
  );

  const priceOracleAddress = await orbitSpaceStation.oracle!();
  const priceOracle = new Contract(priceOracleAddress, priceOracleInterface, blastProvider); // PriceOracleFactory.connect(priceOracleAddress, blastProvider);
  const currentEthUsdPrice = await priceOracle.getUnderlyingPrice!(contractAddresses.oEtherV2);

  for (let i = 0; i < accountDetails.length; i++) {
    const [oTokens, borrowBalances] = accountDetails[i]!; // NOTE: The borrow balances are in ETH.
    const borrower = accounts[i]!;
    let ethBorrowBalance = 0n;

    for (let i = 0; i < oTokens.length; i++) {
      const oToken = oTokens[i];

      if (oToken !== contractAddresses.oEtherV2) continue;

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
