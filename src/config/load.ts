import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { readEnv } from '../env.js';
import { configSchema, type Config } from './schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replaces ${VAR} and ${VAR:-default} in every string of a parsed YAML tree.
 *
 * Interpolating after parsing rather than before means a secret containing YAML
 * metacharacters (`:`, `#`, a leading `*`) cannot corrupt the document structure.
 */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv, path: string[] = []): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (match, name: string, fallback: string | undefined) => {
      const found = env[name];
      if (found !== undefined && found !== '') return found;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(
        `${path.join('.') || '<root>'}: environment variable ${name} referenced as ${match} is not set`,
      );
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnv(item, env, [...path, String(i)]));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        interpolateEnv(v, env, [...path, k]),
      ]),
    );
  }
  return value;
}

function formatZodError(error: z.ZodError, file: string): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join('.') : '<root>';
    return `  - ${where}: ${issue.message}`;
  });
  return `${file} is not valid:\n${lines.join('\n')}`;
}

export function parseConfig(raw: string, file: string, env: NodeJS.ProcessEnv = process.env): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new ConfigError(`${file} is not valid YAML: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) {
    throw new ConfigError(`${file} is empty`);
  }

  const interpolated = interpolateEnv(doc, env);
  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error, file));
  }
  return result.data;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(readEnv('CONFIG', env) ?? 'config/config.yaml');
}

export function loadConfig(file?: string, env: NodeJS.ProcessEnv = process.env): Config {
  const path = file ? resolve(file) : defaultConfigPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(
        `config file not found at ${path}\n` +
          `Copy config/config.example.yaml to config/config.yaml, or point NUDGE_CONFIG at your file.`,
      );
    }
    throw new ConfigError(`could not read ${path}: ${(err as Error).message}`);
  }
  return parseConfig(raw, path, env);
}
