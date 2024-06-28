import * as fs from 'node:fs';
import { join } from 'node:path';

import { Contract, ContractFactory, formatEther, Interface, parseEther } from 'ethers';

import { blastProvider, oEtherV2, oUsdb, wallet } from './commons';
import { getOrbitLiquidatorArtifact, OrbitLiquidatorInterface } from './interfaces';
import { contractAddresses } from './constants';

const OrbitLiquidatorAddress = contractAddresses.OrbitLiquidator;

const main = async () => {
  // Print the wallet and the liquidator contract balances.
  console.info(`Wallet ETH balance (${wallet.address}) `, {
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

  const { bytecode } = getOrbitLiquidatorArtifact();

  const OrbitLiquidator = new Contract(OrbitLiquidatorAddress, OrbitLiquidatorInterface, wallet.connect(blastProvider));

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
      process.stdout.write([`Add the following to your .env:`, `ETHER_LIQUIDATOR_ADDRESS=${address} `, ``].join('\n'));

      return;
    }
    case 'deposit': {
      const ethToSend = process.argv[3]!;
      if (!ethToSend) throw new Error('ETH amount to deposit is required (e.g. 0.05)');
      console.info('Depositing ETH to OrbitLiquidator contract', {
        address: await OrbitLiquidator.getAddress(),
        ethToSend: parseEther(ethToSend),
      });

      const depositTx = await wallet.connect(blastProvider).sendTransaction({
        value: parseEther(ethToSend),
        to: await OrbitLiquidator.getAddress(),
      });
      await depositTx.wait(1);
      console.info('Deposited', { txHash: depositTx.hash });

      return;
    }
    case 'withdraw-all-eth': {
      console.info('Withdrawing all ETH from OrbitLiquidator contract', {
        address: await OrbitLiquidator.getAddress(),
      });

      const withdrawalTx = await OrbitLiquidator.withdrawAllEth!();
      await withdrawalTx.wait(1);
      console.info('Withdrew', { txHash: withdrawalTx.hash });
      return;
    }
    case 'withdraw-all-tokens':
    case 'withdraw-all-token': {
      const tokenAddress = process.argv[3]!;
      if (!tokenAddress) throw new Error('Token address to withdraw is required');
      console.info('Withdrawing all tokens from OrbitLiquidator contract', {
        address: await OrbitLiquidator.getAddress(),
      });

      const withdrawalTx = await OrbitLiquidator.withdrawAllToken!(tokenAddress);
      await withdrawalTx.wait(1);
      console.info('Withdrew', { txHash: withdrawalTx.hash });
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
