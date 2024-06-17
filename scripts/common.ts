import { execSync } from 'node:child_process';
import process from 'node:process';

export interface PackageJson {
  version: string;
}

export const execSyncWithErrorHandling = (command: string) => {
  // eslint-disable-next-line functional/no-try-statements
  try {
    return execSync(command, { stdio: 'pipe' }).toString();
  } catch (error_) {
    const error = error_ as Error & { stdout: Buffer; stderr: Buffer };
    console.error(error.message); // eslint-disable-line no-console
    console.info('STDOUT', error.stdout.toString());
    console.info('STDERR', error.stderr.toString());
    process.exit(1);
  }
};
