import { Contract, ContractFactory, ethers, formatEther, parseEther } from 'ethers';

import { blastProvider, oEtherV2, oUsdb, oevAuctionHouse, oevNetworkProvider, wallet } from './commons';
import { getOrbitLiquidatorArtifact, OrbitLiquidatorInterface } from './interfaces';
import { contractAddresses } from './constants';

const main = async () => {
  const { bytecode } = getOrbitLiquidatorArtifact();

  const orbitLiquidator = new Contract(
    contractAddresses.orbitLiquidator,
    OrbitLiquidatorInterface,
    wallet.connect(blastProvider)
  );

  // Expected usage is to call this script with the type of command to perform.
  const command = process.argv[2];
  switch (command) {
    case 'deploy': {
      console.info('Deploying new OrbitLiquidator contract');

      const deployTx = await new ContractFactory(
        OrbitLiquidatorInterface,
        bytecode,
        wallet.connect(blastProvider)
      ).deploy();

      await deployTx.deploymentTransaction()?.wait(1);
      const address = await deployTx.getAddress();
      console.info('Deployed OrbitLiquidator', {
        txHash: deployTx.deploymentTransaction()!.hash,
        address,
      });
      process.stdout.write([`Add the following to your .env:`, `ORBIT_LIQUIDATOR_ADDRESS=${address} `, ``].join('\n'));

      return;
    }
    case 'deposit': {
      const ethToSend = process.argv[3]!;
      if (!ethToSend) throw new Error('ETH amount to deposit is required (e.g. 0.05)');
      console.info('Depositing ETH to OrbitLiquidator contract', {
        address: await orbitLiquidator.getAddress(),
        ethToSend,
      });

      const depositTx = await wallet.connect(blastProvider).sendTransaction({
        value: parseEther(ethToSend),
        to: await orbitLiquidator.getAddress(),
      });
      await depositTx.wait(1);
      console.info('Deposited', { txHash: depositTx.hash });

      return;
    }
    case 'withdraw-all-eth': {
      console.info('Withdrawing all ETH from OrbitLiquidator contract', {
        address: await orbitLiquidator.getAddress(),
      });

      const withdrawalTx = await orbitLiquidator.withdrawAllEth!();
      await withdrawalTx.wait(1);
      console.info('Withdrew', { txHash: withdrawalTx.hash });
      return;
    }
    case 'withdraw-all-tokens': {
      const tokenAddress = process.argv[3]!;
      if (!tokenAddress) throw new Error('Token address to withdraw is required');
      console.info('Withdrawing all tokens from OrbitLiquidator contract', {
        address: await orbitLiquidator.getAddress(),
      });

      const withdrawalTx = await orbitLiquidator.withdrawAllTokens!(tokenAddress);
      await withdrawalTx.wait(1);
      console.info('Withdrew', { txHash: withdrawalTx.hash });
      return;
    }
    case 'wallet-balances': {
      // Print the wallet and the liquidator contract balances.
      console.info(`Wallet balance`, {
        address: wallet.address,
        eth: formatEther(await blastProvider.getBalance(wallet.address)),
        oEth: formatEther(await oEtherV2.balanceOf!(wallet.address)),
        ethInOEth: formatEther(await oEtherV2.balanceOfUnderlying!.staticCall(wallet.address)),
        oUsdb: formatEther(await oUsdb.balanceOf(wallet.address)),
        usdbInOUsdb: formatEther(await oUsdb.balanceOfUnderlying.staticCall(wallet.address)),
        oevNetworkEth: formatEther(await oevNetworkProvider.getBalance(wallet.address)),
        oevAuctionHouseEth: formatEther(await oevAuctionHouse.bidderToBalance(wallet.address)),
      });
      if (contractAddresses.orbitLiquidator !== ethers.ZeroAddress) {
        console.info('OrbitLiquidator balance', {
          eth: formatEther(await blastProvider.getBalance(contractAddresses.orbitLiquidator)),
          oEth: formatEther(await oEtherV2.balanceOf!(contractAddresses.orbitLiquidator)),
          ethInOEth: formatEther(await oEtherV2.balanceOfUnderlying!.staticCall(contractAddresses.orbitLiquidator)),
          oUsdb: formatEther(await oUsdb.balanceOf(contractAddresses.orbitLiquidator)),
          usdbInOUsdb: formatEther(await oUsdb.balanceOfUnderlying.staticCall(contractAddresses.orbitLiquidator)),
        });
      }
      return;
    }
    default: {
      console.error('Unknown action', { command });
      return;
    }
  }
};

void main().catch((error) => {
  console.error('Unexpected error', error);
  process.exit(1);
});
