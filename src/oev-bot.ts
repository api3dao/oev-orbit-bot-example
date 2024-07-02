import type { AwardedBidEvent } from '@api3/contracts/dist/typechain-types/api3-server-v1/OevAuctionHouse';
import type { TypedEventLog } from '@api3/contracts/dist/typechain-types/common';
import { Contract, ethers, formatEther, parseEther } from 'ethers';
import { chunk, range, uniq } from 'lodash';

import { getAccountsToWatch } from './accounts-to-watch';
import {
  externalMulticallSimulator,
  getDapiTransmutationCalls,
  getPercentageValue,
  min,
  oEtherV2,
  oUsdb,
  OrbitLiquidator,
  orbitSpaceStation,
  blastProvider,
  simulateTransmutationMulticall,
  sleep,
  wallet,
  oevAuctionHouse,
  oevNetworkProvider,
  multicall3,
  blastNetwork,
  api3ServerV1,
  REPORT_FULFILLMENT_DELAY_MS,
  MAX_COLLATERAL_REPAY_PERCENTAGE,
} from './commons';
import {
  decodeBidDetails,
  deriveBidId,
  encodeBidDetails,
  multicall3Interface,
  priceOracleInterface,
} from './interfaces';
import {
  type AwardDetails,
  type AwardedBidLog,
  type BidDetails,
  type ExpeditedBidExpirationLog,
  type LiquidationParameters,
  type OevNetworkLog,
  type PlacedBidLog,
  Storage,
} from './types';
import {
  BID_CONDITION,
  contractAddresses,
  MIN_LIQUIDATION_PROFIT_USD,
  OEV_BID_VALIDITY,
  oevAuctioneerConfig,
  oTokenAddresses,
  SIMULATION_PERCENTAGE,
} from './constants';

const expediteBid = async (bidId: string, encodedBidDetails: string) => {
  try {
    console.debug('Expediting bid', { bidId });

    const tx = await oevAuctionHouse
      .connect(wallet.connect(oevNetworkProvider))
      .expediteBidExpirationMaximally(oevAuctioneerConfig.bidTopic, ethers.keccak256(encodedBidDetails));
    await tx.wait(1);

    console.info('Expedited bid', { bidId, txHash: tx.hash });
  } catch (e) {
    console.error('Attempt to expedite bid failed', { bidId, e });
  }
};

/**
 * The bot's main coordinator function.
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
 */
export const runBot = async () => {
  // If the development.ts file is present, import it
  void import('./development');

  const sleepTime = process.env.MAIN_LOOP_SLEEP_TIME ? parseInt(process.env.MAIN_LOOP_SLEEP_TIME, 10) : 5_000;

  if (storage.oevNetworkData.logs.length === 0) {
    const { logs, lastFetchedBlock } = await getInitialOevNetworkLogs();
    storage.oevNetworkData = {
      lastFetchedBlock,
      logs,
    };
  }

  while (true) {
    const startBlock = storage.oevNetworkData.lastFetchedBlock + 1;
    const endBlock = await oevNetworkProvider.getBlockNumber();
    const logs = await getOevNetworkLogs(startBlock, endBlock);

    console.info('Fetched OEV network logs', { count: logs.length, startBlock, endBlock });

    storage.oevNetworkData = {
      lastFetchedBlock: endBlock,
      logs: [...storage.oevNetworkData.logs, ...logs],
    };

    if (logs.length > 0) {
      storage.oevNetworkData.logs = pruneLogs(storage.oevNetworkData.logs);
    }

    if (storage.currentlyActiveBid && storage.targetChainData.lastBlock === targetChainDataInitialBlock) {
      await expediteActiveBids(); // NOTE: We want to expedite the active bids, so that the bot can start fresh.
    }

    const { targetChainData } = storage;
    const { borrowers, lastBlock } = await getAccountsToWatch(targetChainData.lastBlock);

    targetChainData.borrowers = uniq([...targetChainData.borrowers, ...borrowers]);
    targetChainData.lastBlock = lastBlock;
    storage.targetChainData = targetChainData;

    try {
      const { currentlyActiveBid } = storage;

      if (currentlyActiveBid) {
        await attemptLiquidation();
      } else {
        await findOevLiquidation();
      }
    } catch (e) {
      console.error(`Encountered an error while attempting a liquidation: `, e);
    }

    await sleep(sleepTime);
  }
};

export const pruneLogs = (logs: OevNetworkLog[]) => {
  const oldestLogEntryTimestamp = Date.now() / 1000 - 25 * 60 * 60;
  const possibleOldLog = logs
    .map((log, idx) => ({
      ...log,
      idx,
    }))
    .find((log) => log.eventName === 'AwardedBid' && log.awardDetails.timestamp < oldestLogEntryTimestamp);

  if (!possibleOldLog) {
    return logs;
  }

  return logs.slice(possibleOldLog.idx);
};

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

export const getInitialOevNetworkLogs = async () => {
  const allLogs: OevNetworkLog[] = [];
  let latestBlock = await oevNetworkProvider.getBlockNumber();
  const networkLatestBlock = latestBlock;
  const oldestAllowedTimestamp = Date.now() - 25 * 60 * 60 * 1000; // Auctioneer only considers the last 24 hours
  let currentTimestamp = Date.now();

  console.log(`Doing initial fetch of OEV Network logs`);
  while (currentTimestamp > oldestAllowedTimestamp) {
    const fromBlock = Math.max(latestBlock - 10_000, 0);
    const logs = await oevNetworkProvider.getLogs({
      fromBlock,
      toBlock: latestBlock,
      address: oevAuctionHouse.getAddress(),
      topics: [oevEventTopics, ethers.zeroPadValue(wallet.address, 32), oevAuctioneerConfig.bidTopic],
    });
    const decodedLogs = logs.map((log) => decodeOevNetworkLog(oevAuctionHouse.interface.parseLog(log)!));
    allLogs.unshift(...decodedLogs);

    const fromBlockContents = (await oevNetworkProvider.getBlock(fromBlock))!;
    currentTimestamp = fromBlockContents.timestamp * 1000;

    latestBlock = fromBlock;
  }

  console.log(`Fetched ${allLogs.length} logs, from block ${latestBlock} to ${networkLatestBlock}`);

  return { logs: allLogs, lastFetchedBlock: networkLatestBlock };
};

const getOevNetworkLogs = async (startBlock: number, endBlock: number) => {
  if (startBlock > endBlock) {
    console.info('OEV network logs up to date');
    return [];
  }

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
  const { oevNetworkData } = storage;

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

/**
 * Expedites bids - functionally equivalent to cancelling a bid by making it expire as quickly as possible.
 * This is useful for clearing the on-chain state as far as this app is concerned, so it can start fresh.
 *
 * See https://github.com/api3dao/oev-auction-house/blob/ca81dcbb1e773bd50caa7b577b49cd63b3d5ebe7/contracts/OevAuctionHouse.sol#L594
 */
const expediteActiveBids = async () => {
  const bids = buildOevNetworkState();
  const activeBids = bids.filter((bid) => bid.status === 'active');

  // NOTE: Currently, the bot only makes a single bid at a time, so in case there is a crash, there should be at most
  // one active bid. The logic will iterate over all active bids just to make sure all are expedited.
  if (activeBids.length > 1) console.warn('More than one active bid to expedite', { count: activeBids.length });

  for (const bid of activeBids) {
    const { log } = bid;
    const { bidId, bidTopic, bidDetails } = log.args;

    console.info('Expediting bid', { bidId });
    const tx = await oevAuctionHouse
      .connect(wallet.connect(oevNetworkProvider))
      .expediteBidExpirationMaximally(bidTopic, ethers.keccak256(bidDetails));
    await tx.wait(1);

    console.info('Expedited bid', { bidId, txHash: tx.hash });
  }
};

/**
 * Attempts to liquidate a currently active bid using an awarded bid.
 */
const attemptLiquidation = async () => {
  const { currentlyActiveBid } = storage;
  if (!currentlyActiveBid) throw new Error('No currently active bid.');
  const { bidId, expirationTimestamp, blockNumber, bidDetails } = currentlyActiveBid;

  // Check if the bid is still active.
  const timestampNow = Math.trunc(Date.now() / 1000); // NOTE: We need to use off-chain time, because the chain may not produce blocks.
  if (timestampNow >= expirationTimestamp) {
    console.info('Bid expired or lost the auction to another bid', { bidId });
    storage.currentlyActiveBid = null;

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
    console.info('Bid not yet awarded', { bidId });
    return;
  }
  const { awardDetails } = bidAwardEvent.args;

  storage.currentlyActiveBid = null;

  console.info('Bid awarded', { bidId, awardDetails });

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
      target: contractAddresses.OrbitLiquidator,
      allowFailure: false,
      value: 0,
      callData: OrbitLiquidator.interface.encodeFunctionData('liquidate', [
        liquidationParameters.borrowTokenAddress,
        liquidationParameters.borrower,
        liquidationParameters.collateralTokenAddress,
        liquidationParameters.maxBorrowRepay,
      ]),
    },
  ];

  const [_blockNumber, returndata] = await multicall3.aggregate3Value!.staticCall(calls, { value: bidAmount });
  const [profitEth, profitUsd] = OrbitLiquidator.interface.decodeFunctionResult('liquidate', returndata!.at(-1));
  if (profitUsd <= MIN_LIQUIDATION_PROFIT_USD) {
    console.info('Liquidation still possible, but profit is now too low', {
      eth: formatEther(profitEth),
      usd: formatEther(profitUsd),
    });
    return;
  }

  const walletConnectedMulticall3 = new Contract(
    contractAddresses.multicall3,
    multicall3Interface,
    wallet.connect(blastProvider)
  );
  const tx = await walletConnectedMulticall3.aggregate3Value!(calls, { value: bidAmount });
  await tx.wait(1);
  console.info('Liquidation transaction', { txHash: tx.hash });

  console.info(`Waiting before reporting fulfillment`);
  setTimeout(async () => reportFulfillment(bidDetails, tx.hash, bidId), REPORT_FULFILLMENT_DELAY_MS);
};

const reportFulfillment = async (bidDetails: BidDetails, oevUpdateTxHash: string, bidId: string) => {
  console.info('Reporting fulfillment', { bidId });

  const encodedBidDetails = encodeBidDetails(bidDetails);
  const bidDetailsHash = ethers.keccak256(encodedBidDetails);
  const fulfillmentDetails = ethers.getBytes(oevUpdateTxHash);

  const tx = await oevAuctionHouse
    .connect(wallet.connect(oevNetworkProvider))
    .reportFulfillment(oevAuctioneerConfig.bidTopic, bidDetailsHash, fulfillmentDetails);
  await tx.wait(1);

  console.info(`Reported fulfillment`, { bidId, oevUpdateTxHash, fulfillmentTxHash: tx.hash });
};

/**
 * Finds and processes liquidations for accounts with a shortfall.
 * Retrieves account balances and details, calculates potential liquidation opportunities,
 * and determines the most profitable potential liquidation.
 *
 * Once a potential opportunity has been found, the app places a bid on the OEV network for that feed.
 */
const findOevLiquidation = async () => {
  // Print the wallet and the liquidator contract balances.
  console.info('Wallet ETH balance', {
    eth: formatEther(await blastProvider.getBalance(wallet.address)),
    oEth: formatEther(await oEtherV2.balanceOf!(wallet.address)),
    ethInOEth: formatEther(await oEtherV2.balanceOfUnderlying!.staticCall(wallet.address)),
  });
  console.info('Wallet USDB balance', {
    oUsdb: formatEther(await oUsdb.balanceOf(wallet.address)),
    usdbInOUsdb: formatEther(await oUsdb.balanceOfUnderlying.staticCall(wallet.address)),
  });
  console.info('OrbitLiquidator ETH balance', {
    eth: formatEther(await blastProvider.getBalance(contractAddresses.OrbitLiquidator)),
    oEth: formatEther(await oEtherV2.balanceOf!(contractAddresses.OrbitLiquidator)),
    ethInOEth: formatEther(await oEtherV2.balanceOfUnderlying!.staticCall(contractAddresses.OrbitLiquidator)),
  });
  console.info('OrbitLiquidator USDB balance', {
    oUsdb: formatEther(await oUsdb.balanceOf(contractAddresses.OrbitLiquidator)),
    usdbInOUsdb: formatEther(await oUsdb.balanceOfUnderlying.staticCall(contractAddresses.OrbitLiquidator)),
  });

  // Print out the close factor. Currently, the value is set to 0.5, so we can only liquidate 50% of the borrowed asset.
  const closeFactor = await orbitSpaceStation.closeFactorMantissa!();
  console.info('Close factor', { closeFactor: formatEther(closeFactor) });

  // Transmutation data.
  const priceOracleAddress = await orbitSpaceStation.oracle!();
  const priceOracle = new Contract(priceOracleAddress, priceOracleInterface, blastProvider); // PriceOracleFactory.connect(priceOracleAddress, blastProvider);
  const currentEthUsdPrice = await priceOracle.getUnderlyingPrice!(oTokenAddresses.oEtherV2);
  console.info('Current ETH/USD price', { price: formatEther(currentEthUsdPrice) });
  // NOTE: The data feed is configured with 1% deviation threshold and will be automatically updated after 60s delay.
  // This means that the OEV bot will be on timer to get its bid awarded and to capture the liquidation opportunity.
  // Higher percentage gives more time the bot, but the downside is the accuracy of profit calculation, because it
  // assumes the collateral price remains the same from the bid time to the liquidation capture.
  const transmutationValue = getPercentageValue(currentEthUsdPrice, 100 + SIMULATION_PERCENTAGE);
  const ethUsdDapiName = ethers.encodeBytes32String('ETH/USD');
  const dapiTransmutationCalls = await getDapiTransmutationCalls(
    contractAddresses.api3ServerV1,
    ethUsdDapiName,
    transmutationValue
  );

  const { targetChainData } = storage;
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
    console.info('Fetching account liquidity for accounts', { count: batch.length });

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
  console.info('Accounts with shortfall', { count: accountsWithShortfall.length });
  if (accountsWithShortfall.length === 0) {
    console.info('No accounts with shortfall', {
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
        target: contractAddresses.OrbitLiquidator,
        data: OrbitLiquidator.interface.encodeFunctionData('getAccountDetails', [borrower]),
      },
    ];
    const returndata = await simulateTransmutationMulticall(externalMulticallSimulator, transmutationCalls);
    const [getAccountDetailsEncoded] = returndata.slice(-1);
    const [oTokenAddressesInAccount, borrowBalanceEth, tokenBalanceEth] =
      OrbitLiquidator.interface.decodeFunctionResult('getAccountDetails', getAccountDetailsEncoded);
    const assetsInAccount = range(oTokenAddressesInAccount.length).map((i) => ({
      oToken: oTokenAddressesInAccount[i],
      borrowBalance: borrowBalanceEth[i]!,
      tokenBalance: tokenBalanceEth[i]!,
    }));

    const ethBorrowAsset = assetsInAccount.find((assetObj) => assetObj.oToken === oTokenAddresses.oEtherV2); // Only oEtherV2 uses API3 proxy. The oEther (v1) uses Pyth.
    if (!ethBorrowAsset) {
      console.warn('There is no ETH borrow.');
      continue;
    }
    const maxTokenBalanceAsset = assetsInAccount.reduce((acc, curr) =>
      acc.tokenBalance > curr.tokenBalance ? acc : curr
    );

    const orbitLiquidatorBalance = await blastProvider.getBalance(contractAddresses.OrbitLiquidator);
    const maxBorrowRepay = min(
      (((ethBorrowAsset.borrowBalance * 10n ** 18n) / transmutationValue) * closeFactor) / 10n ** 18n,
      orbitLiquidatorBalance,
      getPercentageValue(
        (maxTokenBalanceAsset.tokenBalance * 10n ** 18n) / transmutationValue,
        MAX_COLLATERAL_REPAY_PERCENTAGE
      )
    );
    console.debug('Potential liquidation', {
      borrower,
      assetsInAccount,
      shortfall: formatEther(liquidity[2]),
      ethBorrowAsset,
      borrowBalance: formatEther(ethBorrowAsset.borrowBalance),
      maxBorrowRepay: formatEther(maxBorrowRepay),
      tokenBalance: formatEther(maxTokenBalanceAsset.tokenBalance),
    });

    const liquidateBorrowCalls = [
      ...dapiTransmutationCalls,
      {
        target: contractAddresses.OrbitLiquidator,
        data: OrbitLiquidator.interface.encodeFunctionData('liquidate', [
          ethBorrowAsset.oToken,
          borrower,
          maxTokenBalanceAsset.oToken,
          maxBorrowRepay,
        ]),
      },
    ];
    const liquidateResult = await simulateTransmutationMulticall(externalMulticallSimulator, liquidateBorrowCalls);

    console.log(liquidateResult);
    const liquidateReturndata = liquidateResult.at(-1);
    const [profitUsd] = OrbitLiquidator.interface.decodeFunctionResult('liquidate', liquidateReturndata);
    if (profitUsd <= MIN_LIQUIDATION_PROFIT_USD) {
      console.info('Liquidation possible, but profit is too low', {
        borrower,
        usd: formatEther(profitUsd),
      });
      continue;
    }
    console.info('Possible liquidation profit', {
      borrower,
      maxBorrowRepay: formatEther(maxBorrowRepay),
      usd: formatEther(profitUsd),
    });

    if (!bestLiquidation || profitUsd > bestLiquidation.profitUsd) {
      bestLiquidation = {
        borrowTokenAddress: ethBorrowAsset.oToken,
        borrower,
        collateralTokenAddress: maxTokenBalanceAsset.oToken,
        maxBorrowRepay,
        profitUsd,
      };
    }
  }

  if (!bestLiquidation) {
    console.info('No liquidation opportunity found.');
    return;
  }

  // Place a bid on the OEV network.
  const bidAmount =
    parseEther('0.0000000000001') ??
    getPercentageValue((bestLiquidation.profitUsd * 10n ** 18n) / transmutationValue, SIMULATION_PERCENTAGE); // NOTE: This assumes the wallet is going to have enough deposit to cover the bid.
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
  console.info('Placing bid', {
    ...bestLiquidation,
    maxBorrowRepay: formatEther(bestLiquidation.maxBorrowRepay),
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

  storage.currentlyActiveBid = currentlyActiveBid;

  console.info('Placed bid', {
    txHash: placeBidTx.hash,
    ...currentlyActiveBid,
    bidAmount: formatEther(bidAmount),
  });
};

export const targetChainDataInitialBlock = 657_831;

export let storage: Storage = {
  currentlyActiveBid: null,
  targetChainData: {
    borrowers: [],
    lastBlock: targetChainDataInitialBlock,
  },
  oevNetworkData: {
    lastFetchedBlock: 0,
    logs: [],
  },
};
