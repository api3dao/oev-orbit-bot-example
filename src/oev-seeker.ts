import type { AwardedBidEvent } from '@api3/contracts/dist/typechain-types/api3-server-v1/OevAuctionHouse';
import type { TypedEventLog } from '@api3/contracts/dist/typechain-types/common';
import { go } from '@api3/promise-utils';
import { Contract, ethers, formatEther } from 'ethers';
import { chunk, range, uniq } from 'lodash';

import { getAccountsFromFile, getAccountsToWatch, persistAccountsToWatch } from './accounts-to-watch';
import {
  MIN_LIQUIDATION_PROFIT_USD,
  contractAddresses,
  externalMulticallSimulator,
  getDapiTransmutationCalls,
  getPercentageValue,
  min,
  oEtherV2,
  oUsdb,
  orbitEtherLiquidator,
  orbitSpaceStation,
  blastProvider,
  simulateTransmutationMulticall,
  sleep,
  wallet,
  oevAuctionHouse,
  oevAuctioneerConfig,
  oevNetworkProvider,
  multicall3,
  blastNetwork,
  sanitizeEthersError,
  api3ServerV1,
} from './commons';
import { loadEnv } from './env';
import {
  decodeBidDetails,
  deriveBidId,
  encodeBidDetails,
  multicall3Interface,
  priceOracleInterface,
} from './interfaces';
import { logger } from './logger';
import { type EnvConfig, envConfigSchema } from './schema';
import {
  type AwardDetails,
  type AwardedBidLog,
  type BidDetails,
  type ExpeditedBidExpirationLog,
  getStorage,
  type LiquidationParameters,
  type OevNetworkLog,
  type PlacedBidLog,
  type TargetChainData,
  updateStorage,
} from './storage';

/**
 * The seeker's main coordinator function.
 *
 * The function starts with initialisation calls:
 * - Initialise the target chain related data (acquires accounts to watch)
 *   - Refer to getAccountsToWatch() and getAccountsFromFile()
 * - Initialise the OEV Network chain data
 *   - Fetches OEV Network logs - this allows the app to determine won/lost bids
 * - Expedite Active Bids
 *   - Clear out existing bids, so that the app can start fresh
 *
 * Then, the function starts three loops:
 * - Run account fetcher loop: listens for events that allow the app to track active accounts
 *   - see getAccountsToWatch()
 * - Run the liquidation attempt loop:
 *   - it either attempts a liquidation with awarded OEV data or
 *   - it tries to find an OEV liquidation opportunity
 * - Persist accounts to watch loop: periodically commit the accounts to watch store to disk
 *
 * @async
 * @function runSeeker
 * @returns {Promise<void>} A promise that never resolves
 */
export const runSeeker = async () => {
  await initializeTargetChainData();
  await initializeOevNetworkData();
  await expediteActiveBids(); // NOTE: We want to expedite the active bids, so that the bot can start fresh.

  void runAccountFetcherLoop(100);
  void runAttemptLiquidationLoop(100);
  void persistAccountsToWatchLoop();
};

/**
 * Runs a loop that listens for accounts to watch.
 *
 * @param {number} frequencyMs - The frequency in milliseconds at which to fetch account data.
 * @returns {Promise<void>} - A promise that resolves when the loop is finished.
 * @throws {Error} - If target chain data is not initialized.
 */
export const runAccountFetcherLoop = async (frequencyMs: number) => {
  while (true) {
    const { targetChainData } = getStorage();
    if (!targetChainData) throw new Error('Target chain data not initialized.');

    const { borrowers, lastBlock } = await getAccountsToWatch(targetChainData.lastBlock);
    updateStorage((draft) => {
      draft.targetChainData!.borrowers = uniq([...targetChainData.borrowers, ...borrowers]);
      draft.targetChainData!.lastBlock = lastBlock;
    });

    await sleep(frequencyMs);
  }
};

/**
 * If the PERSIST_ACCOUNTS_TO_WATCH env is set, this loop will commit accounts to watch storage to disk every 3 minutes.
 *
 * @returns {Promise<void>} Should never resolve.
 */
export const persistAccountsToWatchLoop = async () => {
  const { PERSIST_ACCOUNTS_TO_WATCH } = loadEnv<EnvConfig>(envConfigSchema);
  while (PERSIST_ACCOUNTS_TO_WATCH) {
    await sleep(3 * 60 * 1000);
    // eslint-disable-next-line @typescript-eslint/require-await
    await persistAccountsToWatch(async () => getStorage().targetChainData!);
    logger.info(`Persisted accounts to watch to file.`);
  }
};

/**
 * Initializes the target chain data.
 *
 * This function retrieves the target chain data either from accounts to watch (in production)
 * or from a file (in other environments). It then updates the storage with the obtained data.
 *
 * @async
 * @function initializeTargetChainData
 *
 * @returns {void}
 */
const initializeTargetChainData = async () => {
  while (true) {
    const now = Date.now();
    const goInitialize = await go(
      async () => {
        const env = loadEnv<EnvConfig>(envConfigSchema);
        const targetChainData: TargetChainData =
          env.NODE_ENV === 'production' ? await getAccountsToWatch() : getAccountsFromFile();

        logger.info('Accounts with borrowed ETH', {
          count: targetChainData.borrowers.length,
          elapsedMs: Date.now() - now,
        });
        updateStorage((draft) => {
          draft.targetChainData = targetChainData;
        });
      },
      { totalTimeoutMs: 10 * 60 * 1000 }
    );
    if (goInitialize.success) break;

    logger.error('Error initializing OEV bot storage', sanitizeEthersError(goInitialize.error), {
      elapsedMs: Date.now() - now,
    });
    await sleep(2000);
  }
};

/**
 * Initializes the OEV network data by fetching and updating the logs.
 * The logs allow the application to track awarded and lost bids.
 * This function runs continuously until the initialization is successful.
 * If an error occurs during initialization, it waits for 2 seconds before retrying.
 *
 * @async
 * @function initializeOevNetworkData
 * @returns {void}
 */
const initializeOevNetworkData = async () => {
  while (true) {
    const now = Date.now();
    const goInitialize = await go(
      async () => {
        const startBlock = 0;
        const endBlock = await oevNetworkProvider.getBlockNumber();
        const logs = await getOevNetworkLogs(startBlock, endBlock);

        logger.info('Fetched OEV network logs', { count: logs.length, startBlock, endBlock });
        updateStorage((draft) => {
          draft.oevNetworkData = {
            lastFetchedBlock: endBlock,
            logs,
          };
        });
      },
      { attemptTimeoutMs: 10 * 60 * 1000, retries: 1 }
    );
    if (goInitialize.success) break;

    logger.error('Error initializing OEV network state', sanitizeEthersError(goInitialize.error), {
      elapsedMs: Date.now() - now,
    });
    await sleep(2000);
  }
};

const BID_CONDITION = {
  LTE: 0n,
  GTE: 1n,
};

const OEV_BID_VALIDITY = 30 * 60; // NOTE: Placing one bid on OEV network costs ~0.00003 ETH.

const oevEventTopics = [
  oevAuctionHouse.filters.AwardedBid().fragment.topicHash, // Same as ethers.id('AwardedBid(address,bytes32,bytes32,bytes,uint256)')
  oevAuctionHouse.filters.PlacedBid().fragment.topicHash, // Same as ethers.id('PlacedBid(address,bytes32,bytes32,uint256,uint256,bytes,uint32,uint104,uint104)'),
  oevAuctionHouse.filters.ExpeditedBidExpiration().fragment.topicHash, // Same as ethers.id('ExpeditedBidExpiration(address,bytes32,bytes32,uint32)'),
];

const decodeAwardDetails = (encodedAwardDetails: string): AwardDetails => {
  const awardDetails = api3ServerV1.interface.decodeFunctionData(
    'updateOevProxyDataFeedWithSignedData',
    encodedAwardDetails
  );
  const [proxyAddress, dataFeedId, updateId, timestamp, encodedValue, signatures] = awardDetails;
  const value = ethers.AbiCoder.defaultAbiCoder().decode(['int256'], encodedValue)[0]!;
  return { proxyAddress, dataFeedId, updateId, timestamp, encodedValue, signatures, value };
};

const decodeOevNetworkLog = (log: ethers.LogDescription): OevNetworkLog => {
  switch (log.name) {
    case 'AwardedBid': {
      return {
        eventName: 'AwardedBid',
        args: log.args as unknown as AwardedBidLog['args'],
        awardDetails: decodeAwardDetails(log.args.awardDetails),
      };
    }
    case 'ExpeditedBidExpiration': {
      return {
        eventName: 'ExpeditedBidExpiration',
        args: log.args as unknown as ExpeditedBidExpirationLog['args'],
      };
    }
    case 'PlacedBid': {
      return {
        eventName: 'PlacedBid',
        args: log.args as unknown as PlacedBidLog['args'],
        bidDetails: decodeBidDetails(log.args.bidDetails),
      };
    }
    default: {
      throw new Error(`Unknown OEV network log event: ${log.name}`);
    }
  }
};

const getOevNetworkLogs = async (startBlock: number, endBlock: number) => {
  const allLogs: OevNetworkLog[] = [];
  while (startBlock < endBlock) {
    const actualEndBlock = Math.min(startBlock + 10_000, endBlock);
    const logs = await oevNetworkProvider.getLogs({
      fromBlock: startBlock,
      toBlock: actualEndBlock,
      address: oevAuctionHouse.getAddress(),
      topics: [oevEventTopics, ethers.zeroPadValue(wallet.address, 32), oevAuctioneerConfig.bidTopic],
    });
    allLogs.push(...logs.map((log) => decodeOevNetworkLog(oevAuctionHouse.interface.parseLog(log)!)));
    startBlock += 10_000;
  }

  return allLogs;
};

interface Bid {
  log: PlacedBidLog;
  status: 'active' | 'awarded' | 'expired' | 'lost';
  expirationTimestamp: bigint;
}

const buildOevNetworkState = () => {
  const { oevNetworkData } = getStorage();
  if (!oevNetworkData) throw new Error('OEV network data not initialized.');

  const bids = new Map<string /* Bid ID */, Bid>();
  for (const log of oevNetworkData.logs) {
    switch (log.eventName) {
      case 'PlacedBid': {
        bids.set(log.args.bidId, {
          log,
          status: 'active',
          expirationTimestamp: log.args.expirationTimestamp,
        });
        break;
      }
      case 'AwardedBid': {
        const awardedBid = bids.get(log.args.bidId)!;
        awardedBid.status = 'awarded';

        const { awardDetails, args: awardArgs } = log;
        for (const [bidId, bid] of bids) {
          if (bidId === awardArgs.bidId) continue;

          const { bidDetails } = bid.log;
          if (bidDetails.conditionType === BID_CONDITION.LTE && awardDetails.value > bidDetails.conditionValue) {
            continue;
          }
          if (bidDetails.conditionType === BID_CONDITION.GTE && awardDetails.value < bidDetails.conditionValue) {
            continue;
          }
          bid.status = 'lost';
        }
        break;
      }
      case 'ExpeditedBidExpiration': {
        const bid = bids.get(log.args.bidId)!;
        bid.expirationTimestamp = log.args.expirationTimestamp;
        break;
      }
    }
  }

  // Update status of all expired or soon-to-be-expired bids.
  const currentTimestamp = BigInt(Math.trunc(Date.now() / 1000));
  for (const [_bidId, bid] of bids) {
    if (
      bid.status === 'active' &&
      bid.expirationTimestamp - currentTimestamp < oevAuctioneerConfig.minBidTimeToLiveSeconds
    ) {
      bid.status = 'expired';
    }
  }

  return [...bids.values()];
};

// TODO: Add logs everywhere
// TODO: Move common constants to commons file
const expediteActiveBids = async () => {
  const bids = buildOevNetworkState();
  const activeBids = bids.filter((bid) => bid.status === 'active');

  // NOTE: Currently, the bot only makes a single bid at a time, so in case there is a crash, there should be at most
  // one active bid. The logic will iterate over all active bids just to make sure all are expedited.
  if (activeBids.length > 1) logger.warn('More than one active bid to expedite', { count: activeBids.length });

  for (const bid of activeBids) {
    const { log } = bid;
    const { bidId, bidTopic, bidDetails } = log.args;

    logger.info('Expediting bid', { bidId });
    const goExpedite = await go(async () => {
      const tx = await oevAuctionHouse
        .connect(wallet.connect(oevNetworkProvider))
        .expediteBidExpirationMaximally(bidTopic, ethers.keccak256(bidDetails));
      await tx.wait(1);
      return tx;
    });
    if (!goExpedite.success) {
      logger.error('Error expediting bid', sanitizeEthersError(goExpedite.error), { bidId });
      continue;
    }
    logger.info('Expedited bid', { bidId, txHash: goExpedite.data.hash });
  }
};

export const runAttemptLiquidationLoop = async (frequencyMs: number) => {
  while (true) {
    const now = Date.now();
    const { currentlyActiveBid } = getStorage();
    const goRun = await go(
      async () => {
        if (currentlyActiveBid) return attemptLiquidation();
        return findOevLiquidation();
      },
      { totalTimeoutMs: 1 * 60 * 1000 }
    );
    if (!goRun.success) {
      logger.error('Error running OEV bot', sanitizeEthersError(goRun.error), { elapsedMs: Date.now() - now });
    }
    await sleep(frequencyMs);
  }
};

/**
 * Attempts to liquidate a currently active bid using an awarded bid.
 *
 * @throws {Error} If there is no currently active bid.
 *
 * @returns {Promise<void>}
 */
const attemptLiquidation = async () => {
  const { currentlyActiveBid } = getStorage();
  if (!currentlyActiveBid) throw new Error('No currently active bid.');
  const { bidId, expirationTimestamp, blockNumber, bidDetails } = currentlyActiveBid;

  // Check if the bid is still active.
  const timestampNow = Math.trunc(Date.now() / 1000); // NOTE: We need to use off-chain time, because the chain may not produce blocks.
  if (timestampNow >= expirationTimestamp) {
    logger.info('Bid expired or lost the auction to another bid', { bidId });
    updateStorage((draft) => {
      draft.currentlyActiveBid = null;
    });
    return;
  }

  // Check if the bid is awarded.
  let startBlockNumber = blockNumber;
  const endBlockNumber = await oevNetworkProvider.getBlockNumber();
  let bidAwardEvent: TypedEventLog<AwardedBidEvent.Event> | null = null;
  while (startBlockNumber < endBlockNumber) {
    const actualEndBlockNumber = Math.min(startBlockNumber + 10_000, endBlockNumber);
    const bidAwardEvents = await oevAuctionHouse.queryFilter(
      oevAuctionHouse.filters.AwardedBid(undefined, undefined, bidId),
      startBlockNumber,
      actualEndBlockNumber
    );
    if (bidAwardEvents.length > 0) {
      bidAwardEvent = bidAwardEvents[0]!;
      break;
    }
    startBlockNumber += 10_000;
  }
  if (!bidAwardEvent) {
    logger.info('Bid not yet awarded', { bidId });
    return;
  }
  const { awardDetails } = bidAwardEvent.args;
  updateStorage((draft) => {
    draft.currentlyActiveBid = null;
  });
  logger.info('Bid awarded', { bidId, awardDetails });

  // Perform a staticcall to make sure the liquidation is still possible.
  const { liquidationParameters, bidAmount } = currentlyActiveBid;
  const calls = [
    {
      target: contractAddresses.api3ServerV1,
      allowFailure: false,
      value: bidAmount,
      callData: awardDetails,
    },
    {
      target: contractAddresses.orbitEtherLiquidator,
      allowFailure: false,
      value: 0,
      callData: orbitEtherLiquidator.interface.encodeFunctionData('liquidate', [
        liquidationParameters.borrowTokenAddress,
        liquidationParameters.borrower,
        liquidationParameters.collateralTokenAddress,
        liquidationParameters.maxBorrowRepay,
      ]),
    },
  ];

  const [_blockNumber, returndata] = await multicall3.aggregate3Value!.staticCall(calls, { value: bidAmount });
  const [profitEth, profitUsd] = orbitEtherLiquidator.interface.decodeFunctionResult('liquidate', returndata!.at(-1));
  if (profitUsd <= MIN_LIQUIDATION_PROFIT_USD) {
    logger.info('Liquidation still possible, but profit is now too low', {
      eth: formatEther(profitEth),
      usd: formatEther(profitUsd),
    });
    return;
  }

  const walletConnectedMultivall3 = new Contract(
    contractAddresses.multicall3,
    multicall3Interface,
    wallet.connect(blastProvider)
  );
  const tx = await walletConnectedMultivall3.aggregate3Value!(calls, { value: bidAmount });
  await tx.wait(1);
  logger.info('Liquidation transaction', { txHash: tx.hash });

  logger.info(`Waiting before reporting fulfillment`);
  await sleep(300_000);

  const encodedBidDetails = encodeBidDetails(bidDetails);
  const bidDetailsHash = ethers.keccak256(encodedBidDetails);
  const fulfillmentDetails = ethers.getBytes(tx.hash);
  const reportTx = await oevAuctionHouse
    .connect(wallet.connect(oevNetworkProvider))
    .reportFulfillment(oevAuctioneerConfig.bidTopic, bidDetailsHash, fulfillmentDetails);
  await reportTx.wait(1);
  logger.info(`Reported fulfillment`, { txHash: reportTx.hash });
};

/**
 * Finds and processes liquidations for accounts with a shortfall.
 * Retrieves account balances and details, calculates potential liquidation opportunities,
 * and determines the most profitable potential liquidation.
 *
 * Once a potential opportunity has been found, the app places a bid on the OEV network for that feed.
 *
 * @returns {void}
 */
const findOevLiquidation = async () => {
  // Print the wallet and the liquidator contract balances.
  logger.info('Wallet ETH balance', {
    eth: formatEther(await blastProvider.getBalance(wallet.address)),
    oEth: formatEther(await oEtherV2.balanceOf!(wallet.address)),
    ethInOEth: formatEther(await oEtherV2.balanceOfUnderlying!.staticCall(wallet.address)),
  });
  logger.info('Wallet USDB balance', {
    oUsdb: formatEther(await oUsdb.balanceOf(wallet.address)),
    usdbInOUsdb: formatEther(await oUsdb.balanceOfUnderlying.staticCall(wallet.address)),
  });
  logger.info('OrbitEtherLiquidator ETH balance', {
    eth: formatEther(await blastProvider.getBalance(contractAddresses.orbitEtherLiquidator)),
    oEth: formatEther(await oEtherV2.balanceOf!(contractAddresses.orbitEtherLiquidator)),
    ethInOEth: formatEther(await oEtherV2.balanceOfUnderlying!.staticCall(contractAddresses.orbitEtherLiquidator)),
  });
  logger.info('OrbitEtherLiquidator USDB balance', {
    oUsdb: formatEther(await oUsdb.balanceOf(contractAddresses.orbitEtherLiquidator)),
    usdbInOUsdb: formatEther(await oUsdb.balanceOfUnderlying.staticCall(contractAddresses.orbitEtherLiquidator)),
  });

  // Print out the close factor. Currently, the value is set to 0.5, so we can only liquidate 50% of the borrowed asset.
  const closeFactor = await orbitSpaceStation.closeFactorMantissa!();
  logger.info('Close factor', { closeFactor: formatEther(closeFactor) });

  // Transmutation data.
  const priceOracleAddress = await orbitSpaceStation.oracle!();
  const priceOracle = new Contract(priceOracleAddress, priceOracleInterface, blastProvider); // PriceOracleFactory.connect(priceOracleAddress, blastProvider);
  const currentEthUsdPrice = await priceOracle.getUnderlyingPrice!(contractAddresses.oEtherV2);
  logger.info('Current ETH/USD price', { price: formatEther(currentEthUsdPrice) });
  // NOTE: The data feed is configured with 1% deviation threshold and will be automatically updated after 60s delay.
  // This means that the OEV bot will be on timer to get its bid awarded and to capture the liquidation opportunity.
  // Higher percentage gives more time the bot, but the downside is the accuracy of profit calculation, because it
  // assumes the collateral price remains the same from the bid time to the liquidation capture.
  const transmutationValue = getPercentageValue(currentEthUsdPrice, 100.2);
  const ethUsdDapiName = ethers.encodeBytes32String('ETH/USD');
  const dapiTransmutationCalls = await getDapiTransmutationCalls(
    contractAddresses.api3ServerV1,
    ethUsdDapiName,
    transmutationValue
  );

  const { targetChainData } = getStorage();
  if (!targetChainData) throw new Error('Target chain data not initialized.');
  const { borrowers } = targetChainData;
  const getAccountLiquidityCalls = borrowers.map((borrower) => {
    return {
      target: contractAddresses.orbitSpaceStation,
      callData: orbitSpaceStation.interface.encodeFunctionData('getAccountLiquidity', [borrower]),
    };
  });
  const accountLiquidity = [];
  for (const batch of chunk(getAccountLiquidityCalls, 500)) {
    logger.info('Fetching account liquidity for accounts', { count: batch.length });

    const transmutationCalls = [
      ...dapiTransmutationCalls,
      ...batch.map((call) => ({ target: call.target, data: call.callData })),
    ];
    const returndata = await simulateTransmutationMulticall(externalMulticallSimulator, transmutationCalls);
    const [_setDapiNameReturndata, _updateBeaconWithSignedDataReturndata, ...accountLiquidityReturndata] = returndata;
    accountLiquidity.push(
      ...accountLiquidityReturndata.map((data: string) =>
        orbitSpaceStation.interface.decodeFunctionResult('getAccountLiquidity', data)
      )
    );
  }

  // Filter only liquidateable positions and sort them by the shortfall.
  const accounts = accountLiquidity.map((liquidity, index) => ({ liquidity, borrower: borrowers[index]! }));
  const accountsWithShortfall = accounts
    .filter(({ liquidity }) => liquidity[2] > 0)
    .sort((a, b) => (a.liquidity[2] > b.liquidity[2] ? -1 : 1));
  logger.info('Accounts with shortfall', { count: accountsWithShortfall.length });
  if (accountsWithShortfall.length === 0) {
    logger.info('No accounts with shortfall', {
      accountsCloseToLiquidation: accounts
        .sort((a, b) => (a.liquidity[1] < b.liquidity[1] ? -1 : 1))
        .slice(0, 10)
        .map((a) => ({
          borrower: a.borrower,
          excessLiquidity: formatEther(a.liquidity[1]),
        })),
    });
    return;
  }

  // For each account with a shortfall get the details and compute the most profitable liquidation and persist the
  // profit of the largest one. We will use a percentage of the profit as the bid amount for the OEV auctioneer.
  let bestLiquidation: LiquidationParameters | null = null;
  for (const accountWithShortfall of accountsWithShortfall) {
    const { borrower, liquidity } = accountWithShortfall;

    const transmutationCalls = [
      ...dapiTransmutationCalls,
      {
        target: contractAddresses.orbitEtherLiquidator,
        data: orbitEtherLiquidator.interface.encodeFunctionData('getAccountDetails', [
          borrower,
          contractAddresses.oEtherV2,
        ]),
      },
    ];
    const returndata = await simulateTransmutationMulticall(externalMulticallSimulator, transmutationCalls);
    const [getAccountDetailsEncoded] = returndata.slice(-1);
    const [oTokenAddresses, borrowBalanceEth, tokenBalanceEth] = orbitEtherLiquidator.interface.decodeFunctionResult(
      'getAccountDetails',
      getAccountDetailsEncoded
    );
    const assetsInAccount = range(oTokenAddresses.length).map((i) => ({
      oToken: oTokenAddresses[i],
      borrowBalance: borrowBalanceEth[i]!,
      tokenBalance: tokenBalanceEth[i]!,
    }));

    const ethBorrowAsset = assetsInAccount.find((assetObj) => assetObj.oToken === contractAddresses.oEtherV2); // Only oEtherV2 uses API3 proxy. The oEther (v1) uses Pyth.
    if (!ethBorrowAsset) {
      logger.warn('There is no ETH borrow.');
      continue;
    }
    const maxTokenBalanceAsset = assetsInAccount.reduce((acc, curr) =>
      acc.tokenBalance > curr.tokenBalance ? acc : curr
    );

    const orbitEtherLiquidatorBalance = await blastProvider.getBalance(contractAddresses.orbitEtherLiquidator);
    const maxBorrowRepay = min(
      (ethBorrowAsset.borrowBalance * (closeFactor as bigint)) / 10n ** 18n,
      orbitEtherLiquidatorBalance,
      getPercentageValue(maxTokenBalanceAsset.tokenBalance, 95) // NOTE: We leave some buffer to be sure there is enough collateral after the interest accrual.
    );
    logger.debug('Potential liquidation', {
      borrower,
      assetsInAccount,
      shortfall: formatEther(liquidity[2]),
      ethBorrowAsset,
      borrowBalance: formatEther(ethBorrowAsset.borrowBalance),
      maxBorrowRepay: formatEther(maxBorrowRepay),
      tokenBalance: formatEther(maxTokenBalanceAsset.tokenBalance),
    });
    const goCheckLiquidate = await go(async () => {
      const liquidateBorrowCalls = [
        ...dapiTransmutationCalls,
        {
          target: contractAddresses.orbitEtherLiquidator,
          data: orbitEtherLiquidator.interface.encodeFunctionData('liquidate', [
            ethBorrowAsset.oToken,
            borrower,
            maxTokenBalanceAsset.oToken,
            maxBorrowRepay,
          ]),
        },
      ];
      return simulateTransmutationMulticall(externalMulticallSimulator, liquidateBorrowCalls);
    });
    if (goCheckLiquidate.error) {
      logger.error('Static call error', { borrower, error: goCheckLiquidate.error.toString().slice(0, 80) });
      break;
    }
    const liquidateReturndata = goCheckLiquidate.data.at(-1);
    const [profitEth, profitUsd] = orbitEtherLiquidator.interface.decodeFunctionResult(
      'liquidate',
      liquidateReturndata
    );
    if (profitUsd <= MIN_LIQUIDATION_PROFIT_USD) {
      logger.info('Liquidation possible, but profit is too low', {
        borrower,
        eth: formatEther(profitEth),
        usd: formatEther(profitUsd),
      });
      continue;
    }
    logger.info('Possible liquidation profit', {
      borrower,
      maxBorrowRepay: formatEther(maxBorrowRepay),
      eth: formatEther(profitEth),
      usd: formatEther(profitUsd),
    });

    if (!bestLiquidation || profitEth > bestLiquidation.profitEth) {
      bestLiquidation = {
        borrowTokenAddress: ethBorrowAsset.oToken,
        borrower,
        collateralTokenAddress: maxTokenBalanceAsset.oToken,
        maxBorrowRepay,
        profitEth,
        profitUsd,
      };
    }
  }

  if (!bestLiquidation) {
    logger.info('No liquidation opportunity found.');
    return;
  }

  // Place a bid on the OEV network.
  const bidAmount = getPercentageValue(bestLiquidation.profitEth, 20); // NOTE: This assumes the wallet is going to have enough deposit to cover the bid.
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const bidDetails: BidDetails = {
    oevProxyAddress: contractAddresses.api3OevEthUsdProxy,
    conditionType: BID_CONDITION.GTE,
    conditionValue: transmutationValue,
    updateSenderAddress: contractAddresses.multicall3, // NOTE: This needs to be the `msg.sender` for the update transaction, which in this case is Multicall3 contract.
    nonce,
  };
  const encodedBidDetails = encodeBidDetails(bidDetails);
  const bidId = deriveBidId(wallet.address, oevAuctioneerConfig.bidTopic, encodedBidDetails);
  const blockNumber = await oevNetworkProvider.getBlockNumber();
  const expirationTimestamp = Math.trunc(Date.now() / 1000) + OEV_BID_VALIDITY;
  logger.info('Placing bid', {
    ...bestLiquidation,
    maxBorrowRepay: formatEther(bestLiquidation.maxBorrowRepay),
    profitEth: formatEther(bestLiquidation.profitEth),
    profitUsd: formatEther(bestLiquidation.profitUsd),
    bidAmount: formatEther(bidAmount),
  });
  const placeBidTx = await oevAuctionHouse.connect(wallet.connect(oevNetworkProvider)).placeBidWithExpiration(
    oevAuctioneerConfig.bidTopic,
    blastNetwork.chainId,
    bidAmount,
    encodedBidDetails,
    bidAmount, // NOTE: The upper bound for the collateral slippage could be decreased.
    bidAmount, // NOTE: The upper bound for the collateral slippage could be decreased.
    expirationTimestamp
  );
  await placeBidTx.wait(1);
  const currentlyActiveBid = {
    bidId,
    bidAmount,
    bidDetails,
    expirationTimestamp,
    liquidationParameters: bestLiquidation,
    blockNumber,
  };
  updateStorage((draft) => {
    draft.currentlyActiveBid = currentlyActiveBid;
  });
  logger.info('Placed bid', {
    txHash: placeBidTx.hash,
    ...currentlyActiveBid,
    bidAmount: formatEther(bidAmount),
  });
};
