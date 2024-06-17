// We apply default values to make it convenient to omit certain environment variables. The default values should be

import { z } from 'zod';

import { baseEnvConfigSchema } from '../schema';

export const envConfigSchema = z
  // Intentionally not using strictObject here because we want to allow other environment variables to be present.
  .object({
    ORBIT_BOT_WALLET_PRIVATE_KEY: z.string(),
    ORBIT_BLAST_REBLOK_RPC_API_KEY: z.string().optional(),
  })
  .merge(baseEnvConfigSchema)
  .strip(); // We parse from ENV variables of the process which has many variables that we don't care about.

export type EnvConfig = z.infer<typeof envConfigSchema>;
