import { logger } from './logger';
import { runSeeker } from './oev-seeker';

void runSeeker().catch((error) => {
  logger.error('Unexpected error', error);
  process.exit(1);
});
