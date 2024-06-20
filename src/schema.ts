// We apply default values to make it convenient to omit certain environment variables. The default values should be
import { type LogFormat, logFormatOptions, logLevelOptions, type LogLevel } from '@api3/commons';
import { goSync } from '@api3/promise-utils';
import { getAddress } from 'ethers';
import { z } from 'zod';

export const evmAddressSchema = z.string().transform((val, ctx) => {
  const goChecksumAddress = goSync(() => getAddress(val));
  if (!goChecksumAddress.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid EVM address',
      path: [],
    });
    return '';
  }
  return goChecksumAddress.data;
});

export const evmIdSchema = z.string().regex(/^0x[\dA-Fa-f]{64}$/, 'Must be a valid EVM ID');

export const envBooleanSchema = z.union([z.literal('true'), z.literal('false')]).transform((val) => val === 'true');

// We apply default values to make it convenient to omit certain environment variables. The default values should be
// primarily focused on users and production usage.
export const baseEnvConfigSchema = z
  // Intentionally not using strictObject here because we want to allow other environment variables to be present.
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOGGER_ENABLED: envBooleanSchema.default('true'),
    LOG_COLORIZE: envBooleanSchema.default('false'),
    LOG_FORMAT: z
      .string()
      .transform((value, ctx) => {
        if (!logFormatOptions.includes(value as any)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid LOG_FORMAT',
            path: ['LOG_FORMAT'],
          });
          return;
        }

        return value as LogFormat;
      })
      .default('json'),
    LOG_LEVEL: z
      .string()
      .transform((value, ctx) => {
        if (!logLevelOptions.includes(value as any)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid LOG_LEVEL',
            path: ['LOG_LEVEL'],
          });
          return;
        }

        return value as LogLevel;
      })
      .default('info'),
  })
  .strip(); // We parse from ENV variables of the process which has many variables that we don't care about.

export type BaseEnvConfig = z.infer<typeof baseEnvConfigSchema>;

export const envConfigSchema = z
  // Intentionally not using strictObject here because we want to allow other environment variables to be present.
  .object({
    MNEMONIC: z.string().transform((value) => value.replaceAll('"', '')),
    ORBIT_BLAST_REBLOK_RPC_API_KEY: z.string().optional(),
    PERSIST_ACCOUNTS_TO_WATCH: z.string().optional(),
  })
  .merge(baseEnvConfigSchema)
  .strip(); // We parse from ENV variables of the process which has many variables that we don't care about.

export type EnvConfig = z.infer<typeof envConfigSchema>;
