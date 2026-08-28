import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * package.json, read once at startup.
 *
 * This module has to live at the top of `src/`, because that is the one depth where
 * `../package.json` resolves both from `src/version.ts` under tsx and from
 * `dist/version.js` in the built image — the Dockerfile copies package.json next to
 * dist/ for exactly this reason. Moving this file into a subdirectory breaks it.
 *
 * An unreadable package.json falls back rather than throwing: everything read here
 * is for humans reading logs and message footers, and failing to start over it would
 * be absurd.
 */
function readPackage(): { version?: unknown; bugs?: unknown } {
  try {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
    return JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; bugs?: unknown };
  } catch {
    return {};
  }
}

const pkg = readPackage();

/** npm allows `bugs` as either a bare string or an object with a url. */
function bugsUrl(bugs: unknown): string | null {
  if (typeof bugs === 'string' && bugs.length > 0) return bugs;
  const url = (bugs as { url?: unknown } | null | undefined)?.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

export const VERSION =
  typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';

/**
 * Where the footer of every digest sends people who hit a bug or want something
 * changed. Most recipients never chose to run this and have no idea who to tell.
 */
export const ISSUES_URL = bugsUrl(pkg.bugs) ?? 'https://github.com/sim186/ReviewNudge/issues';

/**
 * What GitLab sees in its API logs. A self-hosted instance administrator looking at
 * unfamiliar traffic can find out what it is and which build is making it.
 */
export const USER_AGENT = `ReviewNudge/${VERSION}`;
