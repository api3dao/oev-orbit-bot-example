# OEV Orbit Bot Example

This repository contains an example OEV Searcher bot implementation targeting [Orbit Lending](https://orbitlending.io/).
To understand how OEV works, visit
[the OEV documentation](https://oev-docs--pr12-new-oev-docs-0y2wddya.web.app/reference/oev-network/overview/oev-network.html).

Before running this application, be sure to read and understand the code.

## Process Overview

The OEV Bot follows this flow to extract OEV from Orbit Lending:

- Initialisation
  - Get log events from the target chain and build a list of accounts to watch for possible liquidation opportunities
  - Get log events from the OEV Network to determine awarded/live/lost bids
- Main Loop
  - Continuously watch log events from Orbit to maintain a list of accounts to watch
  - Attempt liquidations when opportunities are detected

## Opportunity Detection and Value Extraction - In Depth

Given a list of accounts to watch, the app does the following: (Refer to `findOevLiquidation()`)

### Search for an OEV Liquidation Opportunity

- Simulate liquidation potential by [transmuting](#transmutation) the oracle's value for a feed
  - Refer to the [Transmutation section of this README](#transmutation) for more information.
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
- At this point, the OEV bidding process begins. To understand the OEV bidding lifecycle refer to
  [these OEV docs](https://oev-docs--pr12-new-oev-docs-0y2wddya.web.app/reference/oev-network/overview/auction-cycle.html)

  - [Bid on an update for the feed](https://oev-docs--pr12-new-oev-docs-0y2wddya.web.app/reference/oev-network/searchers/submit-bids.html#with-an-expiration-timestamp)

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

- [Listen for the award, expiry or loss of the active bid](https://oev-docs--pr12-new-oev-docs-0y2wddya.web.app/reference/oev-network/searchers/submit-bids.html#checking-bid-status-and-listening-for-awarded-bids)
- If the bid is awarded, encode a multicall call set containing
  - Call #1: Call to the API3 Server with the awarded bid details as call data
  - Call #2: Call the Orbit Ether Liquidator contract with the liquidation parameters
- Simulate the liquidation multicall and determine the profitability - bail if the profit is below the minimum
- [Execute the liquidation transaction](https://oev-docs--pr12-new-oev-docs-0y2wddya.web.app/reference/oev-network/searchers/submit-bids.html#performing-the-oracle-update-using-the-awarded-bid)
- Report the fulfilment on the OEV Network #TODO there's no page for this in the OEV docs
  https://github.com/api3dao/oev-docs/pull/12#issuecomment-2186092191

### Transmutation

In order to bid on an OEV update an application will need to determine
[the bid's parameters](https://oev-docs--pr12-new-oev-docs-0y2wddya.web.app/reference/oev-network/searchers/submit-bids.html#arguments-for-placebid),
and in particular:

- The value of the bid (what will be paid for the bid in the target chain's native token)
- The conditions under which the bid will be considered (less-than or greater-than a specific dAPI value)

Determining these values would generally require re-implementing the mathematical logic of the dApp being targeted,
something which is often very onerous. To make integrating into a target dApp easier, API3 has built a contract that
facilitates the "transmutation" of a dAPI (from the concept of transmuting silver to gold).

The contract's relevant function is quoted below:

```solidity
/// @notice eth_call'ed while impersonating address-zero with zero gas
/// price to simulate an external call
/// @param target Target address of the external call
/// @param data Calldata of the external call
/// @return Returndata of the external call
    function functionCall(
        address target,
        bytes memory data
    ) external override returns (bytes memory) {
        require(msg.sender == address(0), "Sender address not zero");
        require(tx.gasprice == 0, "Tx gas price not zero");
        return Address.functionCall(target, data);
    }
```

[//]: # 'TODO add a link to the actual contract'

The function can only be called with a signer address of zero, and such a signer is only valid for non-write operations,
like a simulated RPC contract call. This can be executed via the
[eth_call](https://www.quicknode.com/docs/ethereum/eth_call) RPC method. The deployed contract instance this function
belongs to has been granted the
[DAPI_NAME_SETTER_ROLE on the Api3ServerV1](https://github.com/api3dao/contracts/blob/d3c7dc6683445df14bf5f43b07e6ad9cc2813cc5/contracts/api3-server-v1/DapiServer.sol#L66).
This allows this contract to change the datafeed a dApi name points to - but there is no risk to anyone as this can only
be called inside a non-writing and/or simulated transaction.

Therefore, within a simulated contract call, the app can do the following (via an intermediate contract):

- [Create and sign a new datafeed data point](https://github.com/api3dao/contracts/blob/d3c7dc6683445df14bf5f43b07e6ad9cc2813cc5/test/api3-server-v1/Api3ServerV1.sol.ts#L22)
  (value and timestamp)
- Within a multicall transaction
  - Use the data feed update created earlier to initialise a datafeed our app controls, with a value we have specified
    - As an example, this could be the current target data feed's value + 1%
  - Set the target datafeed of the dApp's dApi to the newly-initialised datafeed
  - Read the necessary functions on the target dApp to determine OEV opportunities and profitability of a liquidation

For the implementation in this project, refer to the `getDapiTransmutationCalls` function for the transmutation
component. Also refer to `simulateTransmutationMulticall` for the actual transmutation simulation.

## Run the OEV Bot Locally

- Copy `.env.example` to `.env` and populate it
  - `cp .env.example .env`
  - If this app is being run for the first time you'll need to deploy and fund the OrbitLiquidator contract:
    - Build everything, including the contract: `pnpm build`
    - Deploy the contract: Run `pnpm orbit-bot:cli-utils deploy`
    - Populate the `ETHER_LIQUIDATOR_ADDRESS` in .env with the address of the contract deployed above
    - Fund the contract: `pnpm orbit-bot:cli-utils deposit 1` (for 1 ETH)
      - Note that you can withdraw ETH and tokens with:
        - `pnpm orbit-bot:cli-utils withdraw-all-eth`
        - `pnpm orbit-bot:cli-utils withdraw-all-token`
- Ensure that the account on Blast, associated with the `MNEMONIC` you provided has some funds on the OEV Network and
  Blast.

Finally, run the app: `pnpm orbit-bot`

## Running the OEV Bot in Docker

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
