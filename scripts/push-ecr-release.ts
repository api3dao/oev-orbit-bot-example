import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import isWsl from 'is-wsl';

import { type PackageJson, execSyncWithErrorHandling } from './common';

export const isMacOrWindows = () => {
  return process.platform === 'win32' || process.platform === 'darwin' || isWsl;
};

const main = () => {
  const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  const { version } = packageJson as PackageJson;
  console.info(`Building docker images with semantic version ${version}...`);

  if (isMacOrWindows()) {
    console.info('Detected Mac or Windows platform. Using Docker buildx...');
    execSyncWithErrorHandling(`pnpm run docker:build:amd64`);
  } else {
    console.info('Detected Linux platform. Using standard Docker build...');
    execSyncWithErrorHandling(`pnpm run docker:build`);
  }

  const registry = process.env.ECR_REGISTRY;

  const bots = ['oev-seeker'];
  for (const bot of bots) {
    const remoteBotImage = `${registry}/${bot}:${version}`;

    console.info(`Tagging image for ${bot} with ${version}...`);
    execSyncWithErrorHandling(`docker tag api3/${bot} ${remoteBotImage}`);

    console.info(`Pushing image for ${bot} with ${version}...`);
    execSyncWithErrorHandling(`docker push ${remoteBotImage}`);
  }

  console.info('Done!');
};

main();
