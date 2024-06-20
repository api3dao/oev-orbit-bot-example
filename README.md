# OEV Orbit Bot Example

This repository contains an example OEV Searcher bot implementation targeting [Orbit Lending](https://orbitlending.io/).
To understand how OEV works, visit [the OEV documentation](https://replace-me.com/todo).

Before running this application, be sure to read and understand the code.

## Process Overview

The OEV Seeker follows this flow to extract OEV from Orbit Lending:

- Initialisation
  - Get log events from the target chain and build a list of accounts to watch for possible liquidation opportunities
  - Get log events from the OEV Network to determine awarded/live/lost bids
- Main Loop
  - Continuously watch log events from Orbit to maintain a list of accounts to watch
  - Attempt liquidations when opportunities are detected

## Opportunity Detection and Value Extraction - In Depth

Given a list of accounts to watch, the app does the following: (Refer to `findOevLiquidation()`)

### Search for an OEV Liquidation Opportunity

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

### Attempt to Exploit the OEV Liquidation Opportunity

Refer to `attemptLiquidation()`

- Listen for the award, expiry or loss of the active bid
- If the bid is awarded, encode a multicall call set containing
  - Call #1: Call to the API3 Server with the awarded bid details as call data
  - Call #2: Call the Orbit Ether Liquidator contract with the liquidation parameters
- Simulate the liquidation multicall and determine the profitability - bail if the profit is below the minimum
- Execute the liquidation transaction
- Report the fulfilment on the OEV Network

## Run the OEV Seeker Locally

- Copy `accounts-to-watch.json.ignore.example` to `accounts-to-watch.json.ignore`
  - `cp src/accounts-to-watch.json.ignore.example src/accounts-to-watch.json.ignore`
- Copy `.env.example` to `.env` and populate it
  - `cp .env.example .env`
  - If this app is being run for the first time you'll need to deploy the EtherLiquidator contract:
    - Run `pnpm orbit-bot:cli-utils deploy`
    - Populate the `ETHER_LIQUIDATOR_ADDRESS` in .env with the address of the contract deployed above
- Ensure that the account on Blast, associated with the `MNEMONIC` you provided has some funds on the OEV Network and
  Blast.

Finally, run the app: `pnpm orbit-bot`

## Running the OEV Seeker in Docker

### Configuration

Ensure that the .env file has been populated, as described above. This is necessary for running the app, but not for
building the Docker image.

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

## Other notes

- To withdraw all Eth funds from the liquidator contract, run: `pnpm orbit-bot:cli-utils withdraw-all-eth`
- To withdraw all tokens from the liquidator contract, run: `pnpm orbit-bot:cli-utils withdraw-all-token`
