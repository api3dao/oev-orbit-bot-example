# oev-seeker

This repository contains an OEV Seeker bot implementation targeting [Orbit Lending](https://orbitlending.io/). To
understand how OEV works, visit [the OEV documentation](https://replace-me.com/todo).

## Process Overview

The OEV Seeker follows the following process to extract OEV:

- Initialisation
  - Get log events from the target chain and build a list of accounts to watch for possible liquidation opportunities
  - Get log events from the OEV Network to determine awarded/live/lost bids
- Main Loop
  - Continuously watch log events from Orbit to maintain a list of accounts to watch
  - Attempt liquidations when opportunities are detected

## Opportunity Detection and Value Extraction - In Depth

Given a list of accounts to watch, the app does the following:

Refer to `findOevLiquidation()`.

### Search for an OEV liquidation opportunity

- Simulate liquidation potential by _transmuting_ the oracle's value for a feed
  - Find Orbit's Price Oracle: `orbitSpaceStation.oracle`
    - Read the current value of the oracle for the target feed: `priceOracle.getUnderlyingPrice(oEtherV2)`
  - Apply a transmutation value to the read price: `getPercentageValue(currentEthUsdPrice, 100.2)`
  - Create a set of calls that can be used to transmute the value of the oracle temporarily
    - Set the dAPI Name to a beacon we control:
      `api3ServerV1Interface.encodeFunctionData('setDapiName', [dapiName, beaconId])`
    - Set the value of the target beacon to our transmuted value: `updateBeaconWithSignedData`
  - In a single call, apply the transmutation call data and retrieve account liquidity for all accounts
    - refer to
      [ExternalMulticallSimulator.sol](https://github.com/api3dao/oev-searcher/blob/main/contracts/api3-contracts/utils/ExternalMulticallSimulator.sol)
- For all accounts assessed using a transmuted oracle value sort by the biggest shortfall.
- For all shortfall accounts, re-simulate the transmutation call, simulate a liquidation and determine the profit.
- Find the most profitable liquidation (using ETH and USD components).
- Bid on an update for the feed
  - ```typescript
    const bidDetails: BidDetails = {
      oevProxyAddress: contractAddresses.api3OevEthUsdProxy,
      conditionType: BID_CONDITION.GTE,
      conditionValue: transmutationValue,
      updateSenderAddress: contractAddresses.multicall3,
      nonce,
    };
    ```
- Store the active bid's parameters

### Attempt to exploit the OEV liquidation opportunity

Refer to `attemptLiquidation()`

- Listen for the award, expiry or loss of the active bid
- If the bid is awarded, encode a multicall call set containing
  - Call #1: Call to the API3 Server with the awarded bid details as call data
  - Call #2: Call the Orbit Ether Liquidator contract with the liquidation parameters
- Simulate the liquidation multicall and determine the profitability - bail if the profit is below the minimum
- Execute the liquidation transaction
- Report the fulfilment on the OEV Network

## Running the OEV Seeker in Docker

### Configuration

Refer to `.env.example` for the .env configuration. Ensure this file has been copied to `.env` and has been configured.

### Build Docker image

Build the docker images locally using any of the following commands (as per your requirements):

```bash
# Builds all three bots using the host machine's CPU architecture
pnpm docker:build

# Builds all three bots using the x86_64 (aka amd64) CPU architecture
pnpm docker:build:amd64

# Run the bot
pnpm docker:run
```

## Release

### Background

Bots for each dApps are deployed on AWS as versioned Docker images. Config version numbers follow
[Semver](https://semver.org/) and match the version specified in the `package.json`. To bump the version run:

```sh
# supported arguments: 'major', 'minor', 'patch'
pnpm version major
```

After the version commit is merged to `main` branch and all CI checks are passing, the matching Docker images are pushed
to AWS ECR in `us-east-1` region. The CI automation compares the current version with the available tags. If there is no
tag for the version, it releases the current contents of the branch with that tag.

### Process

The process can be summarized using the following steps:

1. `git checkout main && git pull` - Ensure you are on the main branch and have latest changes.
2. `pnpm version <version-bump>` - Bump the version in `package.json`.
3. `git push` - Push directly to the main branch.
4. Wait until the CI tests complete and a new release is created. You can inspect the CI job for the main branch for
   progress.

### AWS deployments

The bots are deployed via CloudFormation. Check the directory for the respective bot for the CloudFormation template in
the `deployments` directory. The template is used to create the actual CloudFormation file that can be used to deploy on
AWS via the AWS console. The deployments are done in the `us-east-1` region.

## Ideal searcher bot design

Let's start with a common set of properties for the OEV bot, independent of the dApp:

1. **Not using external state** - There is no external DB. The bot only uses the blockchain and can cache data in
   memory, but it should treat the data as ephemeral as it won't be available at start-up. This results in a much
   simpler deployment process. The bot can also be restarted when there is a fatal error or run locally. When started,
   the bot should expedite all active bids.
2. **Long running** - The bot should be able to run for a long time without issues. This also makes it possible to cache
   data in memory. It can be deployed as a Docker container on AWS or other cloud.
3. **Staticcalling > querying events > real-time listeners** - Listening to real-time events is often unreliable.
   Querying past events is better, but still worse then staticcalling the chain. The real-timeness of events is not
   critical for the OEV bot as it should be able to filter opportunities beforehand. On the other hand, real-time
   blockchain state is necessary when reasoning about the positions being liquidateable. Similarly, when waiting for
   transaction confirmation it's better to poll for transaction confirmation instead of fetching events from logs.
4. **Handle finality issues on target chain** - To make sure we have accurate events history, fetch events from the last
   fetched block minus some number of blocks for potential reorgs. For already placed bids, the bot should periodically
   query the chain and cancel the bid if it's no longer applicable.
5. **Assume resilient OEV network** - For OEV network, there is only a single RPC provider. Also, assume the chain does
   not have re-orgs.
6. **Use high quality RPC for the target chain** - Use a private RPC for the bot. Optimize for small RPC overhead by
   decreasing the number of positions to track. Having multiple providers on the target chain is complex, because of the
   interaction with OEV network. Using a fallback provider as backup can be useful.
7. **Filtering positions** - In general, expect the dApp to have many positions. The bot will not be able to scale for
   all of them and thus needs to filter the "most interesting positions". This needs to be a heuristic based on the
   position volume and the health factor - or something very dApp specific. A reasonable number of positions to focus on
   is ~20.
8. **Handle both LTE and GTE positions** - The bot can treat LTE and GTE positions independently and have separate loops
   for them, depending what's simpler to implement.
9. **Reporting fulfillment** - The bot should wait reasonable amount of time, depending on the target chain. Waiting 10
   minutes seems good in general. In the meantime, it should look for other liquidation opportunities.
10. **Focus on a single OEV opportunity** - For now, Auctioneer awards only a single bid, which makes it complex to bid
    for multiple positions at the same time because searchers need to sum up their bid amounts for subsequent bids.
    Because of this, the bot should focus on a single position at a time and persist what position it is for. When
    awarded, do staticcall to make sure the position is still valid.
11. **Bid for the position, not the value** - There are two ways how to bid. Either pick some value and check each
    position with it. Alternatively, take each position and compute the first value that causes liquidation. The latter
    is more suitable, because computing the first liquidation value is something that needs to be done anyway when
    reasoning about the already placed bid. The bid should be placed for the first liquidation value from all positions
    (i.e. the smallest when the bids are for GTE condition). The bid should also have a small buffer for the condition
    value to account for liquidation target moving through time.
12. **Manage placed bid** - Bot should place indefinite bid and check periodically if the bid is not lost and can still
    liquidate the OEV opportunity. Otherwise, the bid should be expedited.
13. **Liquidation retries** - The liquidation transaction needs to be submitted with a higher gas price to ensure it's
    mined. If it's pending for longer period, it needs to be scaled with a higher gas price. In case of a market crash,
    the searcher has 60s for the tx to be mined otherwise there will likely be an update from signed data bot or
    Airseeker.

### Signed data bot

The signed data bot is much simpler. It treats LTE and GTE positions independently and has separate loops for them. It
computes the minimum/maximum value that can be computed, and liquidates all the "interesting positions".
