# OEV Orbit Bot Example

This repository contains an example OEV Searcher bot implementation targeting [Orbit Lending](https://orbitlending.io/).
To understand how OEV works, visit [the OEV documentation](https://docs.api3.org/reference/oev-network/).

Before running this application, be sure to read and understand the code.

## Process Overview

The OEV bot follows this flow to extract OEV from Orbit Lending:

1. **Initialisation**

- Get log events from the Blast chain and build a list of accounts to watch for possible liquidation opportunities
- Get log events from the OEV Network to determine awarded/live/lost bids

2. **Main Loop**

- Continuously watch log events from Orbit to maintain a list of accounts to watch
- Attempt liquidations when opportunities are detected

## Opportunity Detection and Value Extraction - In Depth

Given a list of accounts to watch, the app does the following: (Refer to `findOevLiquidation()`)

### Search for an OEV Liquidation Opportunity

- Simulate liquidation potential by [transmuting](#transmutation) the oracle's value for a feed
  - Refer to the [Transmutation section of this README](#transmutation) for more information.
  - Find Orbit's Price Oracle: `orbitSpaceStation.oracle()`
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
  [these OEV docs](https://docs.api3.org/reference/oev-network/overview/auction-cycle.html)

  - [Bid on an update for the feed](https://docs.api3.org/reference/oev-network/searchers/submit-bids.html#with-an-expiration-timestamp)

    ```typescript
    const bidDetails: BidDetails = {
      oevProxyAddress: contractAddresses.api3OevEthUsdProxy,
      conditionType: BID_CONDITION.GTE,
      conditionValue: transmutationValue,
      updateSenderAddress: contractAddresses.multicall3,
      nonce,
    };
    ```

- Store the active bid's parameters

### Attempt to Capture the OEV Liquidation Opportunity

Refer to `attemptLiquidation()`. See the
[OEV Network docs](https://docs.api3.org/reference/oev-network/searchers/submit-bids.html) for more information.

- Listen for the award, expiry or loss of the active bid
- If the bid is awarded, encode a multicall transaction containing
  - Call #1: Call to the API3 Server with the awarded bid details as call data with value corresponding to the bid
    amount
  - Call #2: Call the Orbit Ether Liquidator contract with the liquidation parameters
- Simulate the liquidation multicall and determine the profitability - bail if the profit is below the minimum
- Execute the liquidation transaction
- Report the fulfillment on the OEV Network

### Transmutation

In order to bid on an OEV update an application will need to determine
[the bid's parameters](https://docs.api3.org/reference/oev-network/searchers/submit-bids.html#arguments-for-placebidwithexpiration),
and in particular:

- The value of the bid (what will be paid for the bid in the Blast chain's native token)
- The conditions under which the bid will be considered (less-than or greater-than a specific dAPI value)

Determining these values would generally require re-implementing the business logic of the dApp being targeted,
something which is often very onerous. To make target dApp integration easier, API3 has built a contract that
facilitates the "transmutation" of a dAPI (from the concept of transmuting silver to gold).

**Purpose of Transmutation:**

- **Simulating Price Changes:** By transmuting the value of a data feed, we can simulate how changes in the price would
  affect account liquidity. This helps in identifying liquidation opportunities without altering the actual market
  conditions.
- **Efficient Testing:** It allows for the efficient testing of various scenarios to find the most profitable
  liquidation opportunities.
- **Non-Intrusive:** This process is non-intrusive and does not affect the actual state of the blockchain since it's
  done within a simulated environment.

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

See the full `ExternalMulticallSimulator` contract implementation
[here](https://github.com/api3dao/contracts/blob/7fb41c09953be41f1fab91affb2f75bc31368f65/contracts/utils/ExternalMulticallSimulator.sol).

This function can only be called with a signer address of zero, valid only for non-write operations like a simulated RPC
contract call. This can be executed via the [eth_call](https://www.quicknode.com/docs/ethereum/eth_call) RPC method. The
deployed contract instance has the
[DAPI_NAME_SETTER_ROLE on the Api3ServerV1](https://github.com/api3dao/contracts/blob/d3c7dc6683445df14bf5f43b07e6ad9cc2813cc5/contracts/api3-server-v1/DapiServer.sol#L66),
allowing it to change the datafeed a dAPI name points to in a non-writing and/or simulated transaction.

Within a simulated contract call, the app can:

1. **Create and Sign a new Datafeed data point:**

   - [Create and sign a new datafeed data point](https://github.com/api3dao/contracts/blob/d3c7dc6683445df14bf5f43b07e6ad9cc2813cc5/test/api3-server-v1/Api3ServerV1.sol.ts#L22)
     (value and timestamp).

2. **Simulate the Multicall Transaction:**
   - Use the data feed update created earlier to initialize a datafeed our app controls, with a specified value (e.g.
     the current target data feed's value + 1%).
   - Set the target datafeed of the dApp's dAPI to the newly-initialized datafeed.
   - Read the necessary functions on the target dApp to determine OEV opportunities and the profitability of a
     liquidation.

For the implementation in this project, refer to the `getDapiTransmutationCalls` function for the transmutation
component. Also, refer to `simulateTransmutationMulticall` for the actual transmutation simulation.

## Run the OEV Bot Locally

1. **Setup Environment:**

Copy `.env.example` to `.env` and populate it

```sh
cp .env.example .env
```

3. **Generate Wallet for the bot**

A new mnemonic can be generated using the
[API3 Airnode CLI](https://docs.api3.org/reference/airnode/latest/packages/admin-cli.html#generate-mnemonic) if required

```sh
pnpm dlx @api3/airnode-admin generate-mnemonic
```

4. **Fund the wallet with Blast ETH**

The wallet will be capturing liquidations on the Blast network, so it needs to have some small ETH balance. The
liquidations happen through a helper contract, which also requires some ETH deposit.

5. **Deploy and Fund the OrbitLiquidator Contract (First-time setup)**

```sh
# Install the dependencies
pnpm i

# Build the project and contract
pnpm build

# Deploy the OrbitLiquidator contract
pnpm orbit-bot:cli-utils deploy
```

4. **Fund the OrbitLiquidator contract**

```sh
pnpm orbit-bot:cli-utils deposit 0.01 # for 0.01 ETH
```

5. **Bridge funds to the OEV network**

The wallet will be interacting with the OEV network for which it needs to have an ETH balance. You can use the official
[OEV bridge](https://docs.api3.org/reference/oev-network/overview/bridge-oev-network.html) to bridge funds from the
Ethereum network to the OEV network.

1. **Deposit funds to the OevAuctionHouse**

You can use the
[OEV network explorer](https://oev.explorer.api3.org/address/0x34f13A5C0AD750d212267bcBc230c87AEFD35CC5?tab=write_contract)
to call `deposit` with your wallet. Be sure to leave some ETH in the wallet as well to cover gas costs for the OEV
network transactions.

7. **Run the Bot**

```sh
pnpm orbit-bot
```

### Additional commands

#### Withdraw all ETH from the OrbitLiquidator

```sh
pnpm orbit-bot:cli-utils withdraw-all-eth
```

#### Withdraw all tokens from the OrbitLiquidator

```sh
# The token address must be provided for the tokens to be withdrawn
pnpm orbit-bot:cli-utils withdraw-all-token [token-address]
```

## Running the OEV Bot in Docker

### Configuration

Ensure that the `.env` file has been populated as described in the "Run the OEV Bot Locally" section. This is necessary
for running the app but not for building the Docker image.

### Build Docker image

Build and run the OEV bot docker image locally using the following commands:

```bash
# Using the host machine's native CPU architecture
pnpm docker:build

# Run the bot
pnpm docker:run
```
