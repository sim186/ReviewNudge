import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, interpolateEnv, parseConfig } from './load.js';

const minimal = `
gitlab:
  url: https://gitlab.example.com
  token: \${GITLAB_TOKEN}
  groups: [engineering]
admin:
  enabled: false
notifications:
  channels: [email]
email:
  smtp: { host: smtp.example.com }
  from: nudge@example.com
`;

describe('interpolateEnv', () => {
  it('substitutes plain references', () => {
    expect(interpolateEnv({ a: '${FOO}' }, { FOO: 'bar' })).toEqual({ a: 'bar' });
  });

  it('substitutes inside arrays and nested objects', () => {
    const out = interpolateEnv({ a: [{ b: 'x-${FOO}-y' }] }, { FOO: 'bar' });
    expect(out).toEqual({ a: [{ b: 'x-bar-y' }] });
  });

  it('uses the :- fallback when the variable is unset or empty', () => {
    expect(interpolateEnv('${NOPE:-fallback}', {})).toBe('fallback');
    expect(interpolateEnv('${EMPTY:-fallback}', { EMPTY: '' })).toBe('fallback');
    expect(interpolateEnv('${SET:-fallback}', { SET: 'real' })).toBe('real');
  });

  it('throws with the config path when a variable is missing and has no fallback', () => {
    expect(() => interpolateEnv({ gitlab: { token: '${MISSING}' } }, {})).toThrow(
      /gitlab\.token: environment variable MISSING/,
    );
  });

  it('leaves non-string leaves untouched', () => {
    expect(interpolateEnv({ n: 5, b: true, z: null }, {})).toEqual({ n: 5, b: true, z: null });
  });

  it('does not treat a substituted value as a further reference', () => {
    // A token that happens to contain ${...} must not be expanded again.
    expect(interpolateEnv('${A}', { A: '${B}', B: 'leaked' })).toBe('${B}');
  });
});

describe('parseConfig', () => {
  const env = { GITLAB_TOKEN: 'glpat-test' };

  it('applies defaults for omitted sections', () => {
    const cfg = parseConfig(minimal, 'test.yaml', env);
    expect(cfg.gitlab.token).toBe('glpat-test');
    expect(cfg.schedule.cron).toBe('0 9 * * 1-5');
    expect(cfg.rules.min_age_hours).toBe(12);
    expect(cfg.exclude.bots).toBe(true);
    expect(cfg.silence.working_days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
  });

  it('rejects a channel that has no matching configuration section', () => {
    const raw = minimal.replace('channels: [email]', 'channels: [email, teams]');
    expect(() => parseConfig(raw, 'test.yaml', env)).toThrow(/teams.*section is missing/s);
  });

  it('rejects a weak admin password when the panel is enabled', () => {
    const raw = minimal.replace('enabled: false', 'enabled: true\n  password: short');
    expect(() => parseConfig(raw, 'test.yaml', env)).toThrow(/admin\.password/);
  });

  it('rejects duplicate recipients', () => {
    const raw = `${minimal}
recipients:
  - gitlab_username: alice
    email: alice@example.com
  - gitlab_username: alice
    email: other@example.com
`;
    expect(() => parseConfig(raw, 'test.yaml', env)).toThrow(/duplicate recipient "alice"/);
  });

  it('rejects a malformed quiet-hours time', () => {
    const raw = `${minimal}
silence:
  quiet_hours: { start: "6pm", end: "08:00" }
`;
    expect(() => parseConfig(raw, 'test.yaml', env)).toThrow(/24-hour time/);
  });

  it('reports invalid YAML as a ConfigError', () => {
    expect(() => parseConfig('a:\n  - b\n c: [', 'test.yaml', env)).toThrow(ConfigError);
  });

  it('accepts the shipped example config', () => {
    const raw = readFileSync('config/config.example.yaml', 'utf8');
    const cfg = parseConfig(raw, 'config.example.yaml', {
      GITLAB_TOKEN: 'glpat-test',
      NUDGE_ADMIN_PASSWORD: 'a-long-enough-password',
      SMTP_PASS: 'secret',
      TEAMS_WORKFLOW_URL: 'https://example.logic.azure.com/workflows/abc',
    });
    expect(cfg.gitlab.groups).toEqual(['engineering', 'platform/infra']);
    expect(cfg.notifications.channels).toEqual(['email', 'teams']);
    expect(cfg.recipients.map((r) => r.gitlab_username)).toEqual(['alice', 'bob']);
    // session_secret uses the empty-fallback form, so an unset variable is fine.
    expect(cfg.admin.session_secret).toBe('');
  });
});
