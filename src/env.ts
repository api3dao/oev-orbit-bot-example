// Copied with mods from api3dao/signed-api
import { join } from 'node:path';

import dotenv from 'dotenv';
import type { z } from 'zod';

let envLoaded = false;

export const loadEnv = <T = unknown>(configSchema: z.Schema): T => {
  if (!envLoaded) {
    dotenv.config({ path: join(__dirname, '../.env') });
    envLoaded = true;
  }

  const parseResult = configSchema.safeParse(process.env);
  if (!parseResult.success) {
    throw new Error(`Invalid environment variables:\n, ${JSON.stringify(parseResult.error.format())}`);
  }

  return parseResult.data;
};
