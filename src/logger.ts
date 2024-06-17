import { createLogger } from '@api3/commons';

import { loadEnv } from './env';
import { type BaseEnvConfig, baseEnvConfigSchema } from './schema';

// We need to load the environment variables before we can use the logger. Because we want the logger to always be
// available, we load the environment variables as a side effect during the module import.
const env = loadEnv<BaseEnvConfig>(baseEnvConfigSchema);

export const logger = createLogger({
  colorize: env.LOG_COLORIZE,
  enabled: env.LOGGER_ENABLED,
  minLevel: env.LOG_LEVEL,
  format: env.LOG_FORMAT,
});
