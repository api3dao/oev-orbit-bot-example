import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { go } from '@api3/promise-utils';
import { Octokit } from '@octokit/rest';

import { type PackageJson, execSyncWithErrorHandling } from './common';

const createGithubRelease = async (tagName: `v${string}`) => {
  if (!process.env.GH_ACCESS_TOKEN) {
    console.info(`GH_ACCESS_TOKEN not set. Skipping release creation`);
    return null;
  }
  // Ensure the GH_ACCESS_TOKEN secret is set on Github and has the relevant permissions
  const octokit = new Octokit({ auth: process.env.GH_ACCESS_TOKEN });
  const createRelease = async () =>
    octokit.rest.repos.createRelease({
      owner: 'api3dao',
      repo: 'oev-searcher',
      tag_name: tagName, // eslint-disable-line camelcase
      generate_release_notes: true, // eslint-disable-line camelcase
    });
  console.info(`Creating Github release...`);
  const goRes = await go(createRelease, { totalTimeoutMs: 15_000 });
  if (!goRes.success) {
    // We don't want to fail CI if the release fails to create. This can be done manually through Github's UI
    console.info(`Unable to create Github release`);
    console.info(goRes.error.message);
    return null;
  }
  return goRes.data;
};

const main = async () => {
  console.info('Ensuring working directory is clean...');
  const gitStatus = execSyncWithErrorHandling('git status --porcelain');
  if (gitStatus !== '') throw new Error('Working directory is not clean');

  console.info('Ensuring we are on the main branch...');
  const branch = execSyncWithErrorHandling('git branch --show-current');
  if (branch !== 'main\n') throw new Error('Not on the main branch');

  console.info('Ensuring we are up to date with the remote...');
  execSyncWithErrorHandling('git fetch');

  const gitDiff = execSyncWithErrorHandling('git diff origin/main');
  if (gitDiff !== '') throw new Error('Not up to date with the remote');

  const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  const { version } = packageJson as PackageJson;
  console.info(`Version set to ${version}...`);

  const gitTag = execSyncWithErrorHandling(`git tag -l '*v${version}*'`);
  if (gitTag !== '') throw new Error(`git tag v${version} already exists`);

  console.info('Creating new annotated git tag...');
  execSyncWithErrorHandling(`git tag -a v${version} -m "v${version}"`);

  console.info('Pushing git tag...');
  // NOTE: in order to push, a valid access token is expected as GH_ACCESS_TOKEN
  execSyncWithErrorHandling(`git push origin v${version} --no-verify`);

  await createGithubRelease(`v${version}`);

  console.info(`Done!`);
};

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.info(error);
    process.exitCode = 1;
  });
