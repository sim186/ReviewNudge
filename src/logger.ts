import { createRequire } from 'node:module';
import { pino } from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

// Pretty output when attached to a terminal; JSON lines when piped or in a container,
// where a log shipper is the likely reader.
const wantsPretty =
  process.env.LOG_FORMAT === 'pretty' || (process.stdout.isTTY && !process.env.LOG_FORMAT);

/**
 * pino-pretty is a development dependency, so it is absent from a pruned production
 * install such as the Docker image. Asking pino to load a missing transport throws at
 * startup, so check first and fall back to JSON rather than refusing to boot.
 */
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const usePretty = wantsPretty && prettyAvailable();

export const logger = pino({
  level,
  ...(usePretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
  redact: {
    paths: [
      'token',
      '*.token',
      'password',
      '*.password',
      'pass',
      '*.pass',
      'workflow_url',
      '*.workflow_url',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
