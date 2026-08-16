import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The running version, read from package.json.
 *
 * This module has to live at the top of `src/`, because that is the one depth where
 * `../package.json` resolves both from `src/version.ts` under tsx and from
 * `dist/version.js` in the built image — the Dockerfile copies package.json next to
 * dist/ for exactly this reason. Moving this file into a subdirectory breaks it.
 *
 * A missing or unreadable package.json yields "unknown" rather than throwing: the
 * version is for humans reading logs, and failing to start over it would be absurd.
 */
function readVersion(): string {
  try {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();

/**
 * What GitLab sees in its API logs. A self-hosted instance administrator looking at
 * unfamiliar traffic can find out what it is and which build is making it.
 */
export const USER_AGENT = `ReviewNudge/${VERSION}`;
