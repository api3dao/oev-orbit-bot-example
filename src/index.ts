import { runBot } from './oev-bot';
import { join } from 'node:path';
import { configDotenv } from 'dotenv';

// Load env file
configDotenv({ path: join(__dirname, '../.env') });

// JSON.stringify doesn't natively handle BigInt values,
// https://github.com/GoogleChromeLabs/jsbi/issues/30#issuecomment-953187833
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

void runBot().catch((error) => {
  console.error('Unexpected error', error);
  process.exit(1);
});
