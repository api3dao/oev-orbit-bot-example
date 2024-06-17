import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatEther, parseEther } from 'ethers';

import packageJson from '../../package.json';
import { OrbitEtherLiquidator__factory as OrbitEtherLiquidatorFactory } from '../../typechain-types';
import { logger } from '../logger';

import { persistAccountsToWatch } from './accounts-to-watch';
import { blastProvider, contractAddresses, oEtherV2, oUsdb, orbitEtherLiquidator, wallet } from './commons';

const main = async () => {
  // Print the wallet and the liquidator contract balances.
  logger.info('Wallet ETH balance', {
    eth: formatEther(await blastProvider.getBalance(wallet.address)),
    oEth: formatEther(await oEtherV2.balanceOf(wallet.address)),
    ethInOEth: formatEther(await oEtherV2.balanceOfUnderlying.staticCall(wallet.address)),
  });
  logger.info('Wallet USDB balance', {
    oUsdb: formatEther(await oUsdb.balanceOf(wallet.address)),
    usdbInOUsdb: formatEther(await oUsdb.balanceOfUnderlying.staticCall(wallet.address)),
  });
  logger.info('OrbitEtherLiquidator ETH balance', {
    eth: formatEther(await blastProvider.getBalance(contractAddresses.orbitEtherLiquidator)),
    oEth: formatEther(await oEtherV2.balanceOf(contractAddresses.orbitEtherLiquidator)),
    ethInOEth: formatEther(await oEtherV2.balanceOfUnderlying.staticCall(contractAddresses.orbitEtherLiquidator)),
  });
  logger.info('OrbitEtherLiquidator USDB balance', {
    oUsdb: formatEther(await oUsdb.balanceOf(contractAddresses.orbitEtherLiquidator)),
    usdbInOUsdb: formatEther(await oUsdb.balanceOfUnderlying.staticCall(contractAddresses.orbitEtherLiquidator)),
  });

  // Expected usage is to call this script with the type of command to perform.
  // eslint-disable-next-line @typescript-eslint/prefer-destructuring
  const command = process.argv[2];
  switch (command) {
    case 'deploy': {
      logger.info('Deploying new OrbitEtherLiquidator contract');

      const deployTx = await new OrbitEtherLiquidatorFactory(wallet.connect(blastProvider)).deploy(
        contractAddresses.orbitSpaceStation
      );
      await deployTx.deploymentTransaction()?.wait(1);
      logger.info('Deployed OrbitEtherLiquidator', {
        txHash: deployTx.deploymentTransaction()!.hash,
        address: await deployTx.getAddress(),
      });
      return;
    }
    case 'deposit': {
      const ethToSend = process.argv[3]!;
      if (!ethToSend) throw new Error('ETH amount to deposit is required (e.g. 0.05)');
      logger.info('Depositing ETH to OrbitEtherLiquidator contract', {
        address: await orbitEtherLiquidator.getAddress(),
        ethToSend: parseEther(ethToSend),
      });

      const depositTx = await orbitEtherLiquidator
        .connect(wallet.connect(blastProvider))
        .deposit({ value: parseEther(ethToSend) });
      await depositTx.wait(1);
      logger.info('Deposited', { txHash: depositTx.hash });
      return;
    }
    case 'withdraw-all-eth': {
      logger.info('Withdrawing all ETH from OrbitEtherLiquidator contract', {
        address: await orbitEtherLiquidator.getAddress(),
      });

      const withdrawalTx = await orbitEtherLiquidator.connect(wallet.connect(blastProvider)).withdrawAllEth();
      await withdrawalTx.wait(1);
      logger.info('Withdrew', { txHash: withdrawalTx.hash });
      return;
    }
    case 'withdraw-all-token': {
      const tokenAddress = process.argv[3]!;
      if (!tokenAddress) throw new Error('Token address to withdraw is required');
      logger.info('Withdrawing all tokens from OrbitEtherLiquidator contract', {
        address: await orbitEtherLiquidator.getAddress(),
      });

      const withdrawalTx = await orbitEtherLiquidator
        .connect(wallet.connect(blastProvider))
        .withdrawAllToken(tokenAddress);
      await withdrawalTx.wait(1);
      logger.info('Withdrew', { txHash: withdrawalTx.hash });
      return;
    }
    case 'prepare-accounts-to-watch': {
      await persistAccountsToWatch();
      return;
    }
    case 'prepare-deployment': {
      logger.info('Preparing deployment');

      const template = readFileSync(join(__dirname, 'deployments/orbit-bots.template.json'), 'utf8');
      const deployment = template.replaceAll('<VERSION>', packageJson.version);
      writeFileSync(join(__dirname, 'deployments/orbit-bots.json'), deployment);
      return;
    }
    default: {
      logger.error('Unknown action', { command });
      return;
    }
  }
};

void main().catch((error) => {
  logger.error('Unexpected error', error);
  process.exit(1);
});
