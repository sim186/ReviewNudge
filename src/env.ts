/**
 * Environment variables, read under the current prefix with the old one as a fallback.
 *
 * The project was renamed from MergeRequestAlarm to ReviewNudge. Anything already
 * deployed has `MRA_*` in its unit file, compose file or CI config, and a rename that
 * silently stopped reading those would look like the tool had simply stopped working.
 * `NUDGE_*` wins where both are set; `MRA_*` keeps working until you get round to it.
 */
const PREFIX = 'NUDGE_';
const LEGACY_PREFIX = 'MRA_';

export type EnvName =
  | 'CONFIG'
  | 'DATA_DIR'
  | 'DRY_RUN'
  | 'SILENCE'
  | 'ADMIN_HOST'
  | 'ADMIN_PASSWORD'
  | 'SESSION_SECRET';

export function readEnv(name: EnvName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`${PREFIX}${name}`] ?? env[`${LEGACY_PREFIX}${name}`];
}

/** True for "1" or "true"; anything else, including absent, is false. */
export function readEnvFlag(name: EnvName, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = readEnv(name, env);
  return value === '1' || value === 'true';
}

/** Names still set with the old prefix, so startup can point them out once. */
export function legacyEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith(LEGACY_PREFIX))
    .sort();
}
