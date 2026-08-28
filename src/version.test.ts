import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ISSUES_URL, USER_AGENT, VERSION } from './version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('VERSION', () => {
  it('matches package.json, which is the single source of truth', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it('resolved to a real version rather than falling back', () => {
    // "unknown" here means ../package.json did not resolve, which is what breaks if
    // this module is ever moved out of the top of src/.
    expect(VERSION).not.toBe('unknown');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('ISSUES_URL', () => {
  it('matches package.json, which is the single source of truth', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      bugs: { url: string };
    };
    expect(ISSUES_URL).toBe(pkg.bugs.url);
  });

  it('is a real link, since it goes out in every digest footer', () => {
    expect(() => new URL(ISSUES_URL)).not.toThrow();
    expect(ISSUES_URL).toMatch(/^https:/);
  });
});

describe('USER_AGENT', () => {
  it('identifies the product and the build to whoever reads the GitLab logs', () => {
    expect(USER_AGENT).toBe(`ReviewNudge/${VERSION}`);
  });
});
