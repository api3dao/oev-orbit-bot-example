import type { TypedEventLog } from '@api3/contracts/dist/typechain-types/common';
import { type Draft, produce } from 'immer';

import type { oevAuctionHouse } from './commons';

export interface BidDetails {
  oevProxyAddress: string;
  conditionType: bigint;
  conditionValue: bigint;
  updateSenderAddress: string;
  nonce: string;
}

export interface AwardDetails {
  proxyAddress: string;
  dataFeedId: string;
  updateId: string;
  timestamp: bigint;
  encodedValue: string;
  value: bigint;
  signatures: string[];
}

export interface LiquidationParameters {
  borrowTokenAddress: string;
  borrower: string;
  collateralTokenAddress: string;
  maxBorrowRepay: bigint;
  profitEth: bigint;
  profitUsd: bigint;
}

export interface TargetChainData {
  borrowers: string[];
  lastBlock: number;
}

interface CurrentlyActiveBid {
  bidId: string;
  bidAmount: bigint;
  bidDetails: BidDetails;
  expirationTimestamp: number;
  liquidationParameters: LiquidationParameters;
  blockNumber: number;
}

export interface PlacedBidLog {
  eventName: 'PlacedBid';
  args: TypedEventLog<(typeof oevAuctionHouse)['filters']['PlacedBid']>['args'];
  bidDetails: BidDetails;
}

export interface AwardedBidLog {
  eventName: 'AwardedBid';
  args: TypedEventLog<(typeof oevAuctionHouse)['filters']['AwardedBid']>['args'];
  awardDetails: AwardDetails;
}

export interface ExpeditedBidExpirationLog {
  eventName: 'ExpeditedBidExpiration';
  args: TypedEventLog<(typeof oevAuctionHouse)['filters']['ExpeditedBidExpiration']>['args'];
}

export type OevNetworkLog = AwardedBidLog | ExpeditedBidExpirationLog | PlacedBidLog;

interface OevNetworkData {
  lastFetchedBlock: number;
  logs: OevNetworkLog[];
}

interface Storage {
  currentlyActiveBid: CurrentlyActiveBid | null;
  targetChainData: TargetChainData | null;
  oevNetworkData: OevNetworkData | null;
}

let storage: Storage = {
  currentlyActiveBid: null,
  targetChainData: null,
  oevNetworkData: null,
};

export const getStorage = () => storage;

export const updateStorage = (updater: (draft: Draft<Storage>) => void) => {
  storage = produce(storage, updater);
};
