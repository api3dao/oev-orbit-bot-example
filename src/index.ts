import { logger } from './logger';
import { runBot } from './oev-bot';

void runBot().catch((error) => {
  logger.error('Unexpected error', error);
  process.exit(1);
});
