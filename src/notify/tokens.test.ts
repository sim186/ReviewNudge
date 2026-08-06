import { describe, expect, it } from 'vitest';
import {
  isReachableHost,
  manageLink,
  mintRecipientToken,
  muteLink,
  selfServiceBaseUrl,
  verifyRecipientToken,
} from './tokens.js';

const SECRET = 'a-stable-secret-for-signing';

describe('recipient tokens', () => {
  it('round-trips a username', () => {
    const token = mintRecipientToken('alice', SECRET);
    expect(verifyRecipientToken(token, SECRET)).toBe('alice');
  });

  it('handles usernames with characters that are awkward in a URL', () => {
    for (const name of ['a.b-c_d', 'Ünïcode', 'user+tag']) {
      const token = mintRecipientToken(name, SECRET);
      expect(verifyRecipientToken(token, SECRET)).toBe(name);
      expect(token).not.toContain('/');
      expect(token).not.toContain('+');
    }
  });

  it('rejects a token signed with a different secret', () => {
    const token = mintRecipientToken('alice', SECRET);
    expect(verifyRecipientToken(token, 'another-secret')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = mintRecipientToken('alice', SECRET);
    const forged = `${Buffer.from('bob', 'utf8').toString('base64url')}.${token.split('.')[1]}`;
    expect(verifyRecipientToken(forged, SECRET)).toBeNull();
  });

  it('rejects malformed input rather than throwing', () => {
    for (const bad of ['', 'nodot', '.', '.sig', 'payload.']) {
      expect(verifyRecipientToken(bad, SECRET)).toBeNull();
    }
  });

  it('rejects everything when no secret is configured', () => {
    const token = mintRecipientToken('alice', SECRET);
    expect(verifyRecipientToken(token, '')).toBeNull();
  });

  it('gives each person a distinct token', () => {
    expect(mintRecipientToken('alice', SECRET)).not.toBe(mintRecipientToken('bob', SECRET));
  });
});

describe('selfServiceBaseUrl', () => {
  it('builds a base URL from the admin binding', () => {
    expect(selfServiceBaseUrl({ enabled: true, host: 'mra.example.com', port: 8080 })).toBe(
      'http://mra.example.com:8080',
    );
  });

  it('returns null for a binding a recipient could never reach', () => {
    // Emitting a link to 127.0.0.1 in an email would be worse than emitting none.
    for (const host of ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '::', '']) {
      expect(selfServiceBaseUrl({ enabled: true, host, port: 8080 })).toBeNull();
    }
  });

  it('returns null when the panel is switched off', () => {
    expect(selfServiceBaseUrl({ enabled: false, host: 'mra.example.com', port: 8080 })).toBeNull();
  });

  it('recognises reachable hosts', () => {
    expect(isReachableHost('mra.example.com')).toBe(true);
    expect(isReachableHost('10.0.0.5')).toBe(true);
    expect(isReachableHost(' LOCALHOST ')).toBe(false);
  });
});

describe('links', () => {
  const base = 'http://mra.example.com:8080';
  const token = mintRecipientToken('alice', SECRET);

  it('encodes the merge request URL as a query parameter', () => {
    const link = muteLink(base, token, 'https://gitlab.example.com/a/b/-/merge_requests/1');
    expect(link).toContain('/me/');
    expect(link).toContain('mr=https%3A%2F%2Fgitlab.example.com%2Fa%2Fb%2F-%2Fmerge_requests%2F1');
  });

  it('builds a manage link', () => {
    expect(manageLink(base, token)).toBe(`${base}/me/${token}`);
  });
});
