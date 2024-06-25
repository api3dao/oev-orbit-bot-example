import * as fs from 'node:fs';
import { join } from 'node:path';

import { Contract, ContractFactory, formatEther, Interface, parseEther } from 'ethers';

import { blastProvider, oEtherV2, oUsdb, wallet } from './commons';
import { orbitEtherLiquidatorInterface } from './interfaces';
import { contractAddresses } from './constants';

const orbitEtherLiquidatorAddress = contractAddresses.orbitEtherLiquidator;

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
  console.info('OrbitEtherLiquidator ETH balance', {
    eth: formatEther(await blastProvider.getBalance(contractAddresses.orbitEtherLiquidator)),
    oEth: formatEther(await oEtherV2.balanceOf!(contractAddresses.orbitEtherLiquidator)),
    ethInOEth: formatEther(await oEtherV2.balanceOfUnderlying!.staticCall(contractAddresses.orbitEtherLiquidator)),
  });
  console.info('OrbitEtherLiquidator USDB balance', {
    oUsdb: formatEther(await oUsdb.balanceOf(contractAddresses.orbitEtherLiquidator)),
    usdbInOUsdb: formatEther(await oUsdb.balanceOfUnderlying.staticCall(contractAddresses.orbitEtherLiquidator)),
  });

  const { bytecode, abi } = JSON.parse(
    fs.readFileSync(join(__dirname, '..', 'OrbitEtherLiquidator.sol.json')).toString()
  ) as {
    bytecode: string;
    abi: any[];
  };

  const orbitEtherLiquidator = new Contract(
    orbitEtherLiquidatorAddress,
    Interface.from(abi),
    wallet.connect(blastProvider)
  );

  // Expected usage is to call this script with the type of command to perform.

  const command = process.argv[2];
  switch (command) {
    case 'deploy': {
      console.info('Deploying new OrbitEtherLiquidator contract');

      const deployTx = await new ContractFactory(
        orbitEtherLiquidatorInterface,
        bytecode,
        wallet.connect(blastProvider)
      ).deploy(contractAddresses.orbitSpaceStation);

      await deployTx.deploymentTransaction()?.wait(1);
      const address = await deployTx.getAddress();
      console.info('Deployed OrbitEtherLiquidator', {
        txHash: deployTx.deploymentTransaction()!.hash,
        address,
      });
      process.stdout.write([`Add the following to your .env:`, `ETHER_LIQUIDATOR_ADDRESS=${address} `, ``].join('\n'));

      return;
    }
    case 'deposit': {
      const ethToSend = process.argv[3]!;
      if (!ethToSend) throw new Error('ETH amount to deposit is required (e.g. 0.05)');
      console.info('Depositing ETH to OrbitEtherLiquidator contract', {
        address: await orbitEtherLiquidator.getAddress(),
        ethToSend: parseEther(ethToSend),
      });

      const depositTx = await orbitEtherLiquidator.deposit!({ value: parseEther(ethToSend) });
      await depositTx.wait(1);
      console.info('Deposited', { txHash: depositTx.hash });
      return;
    }
    case 'withdraw-all-eth': {
      console.info('Withdrawing all ETH from OrbitEtherLiquidator contract', {
        address: await orbitEtherLiquidator.getAddress(),
      });

      const withdrawalTx = await orbitEtherLiquidator.withdrawAllEth!();
      await withdrawalTx.wait(1);
      console.info('Withdrew', { txHash: withdrawalTx.hash });
      return;
    }
    case 'withdraw-all-tokens':
    case 'withdraw-all-token': {
      const tokenAddress = process.argv[3]!;
      if (!tokenAddress) throw new Error('Token address to withdraw is required');
      console.info('Withdrawing all tokens from OrbitEtherLiquidator contract', {
        address: await orbitEtherLiquidator.getAddress(),
      });

      const withdrawalTx = await orbitEtherLiquidator.withdrawAllToken!(tokenAddress);
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
