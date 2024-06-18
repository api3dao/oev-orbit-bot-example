import { logger } from './logger';
import { runSeeker } from './orbit-bot/oev-seeker';

void runSeeker().catch((error) => {
  logger.error('Unexpected error', error);
  process.exit(1);
});
