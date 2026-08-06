import { describe, expect, it } from 'vitest';
import { legacyEnvNames, readEnv, readEnvFlag } from './env.js';

describe('readEnv', () => {
  it('reads the current prefix', () => {
    expect(readEnv('CONFIG', { NUDGE_CONFIG: 'a.yaml' })).toBe('a.yaml');
  });

  it('falls back to the pre-rename prefix', () => {
    // An existing deployment has MRA_* in its unit file. A rename that stopped
    // reading those would look like the tool had simply stopped working.
    expect(readEnv('CONFIG', { MRA_CONFIG: 'old.yaml' })).toBe('old.yaml');
  });

  it('prefers the current prefix when both are set', () => {
    expect(readEnv('CONFIG', { NUDGE_CONFIG: 'new.yaml', MRA_CONFIG: 'old.yaml' })).toBe(
      'new.yaml',
    );
  });

  it('is undefined when neither is set', () => {
    expect(readEnv('DATA_DIR', {})).toBeUndefined();
  });

  it('does not treat an empty current value as absent', () => {
    // Explicitly blanking NUDGE_* is a way to override an inherited MRA_*.
    expect(readEnv('DATA_DIR', { NUDGE_DATA_DIR: '', MRA_DATA_DIR: '/old' })).toBe('');
  });
});

describe('readEnvFlag', () => {
  it('accepts 1 and true, under either prefix', () => {
    expect(readEnvFlag('DRY_RUN', { NUDGE_DRY_RUN: '1' })).toBe(true);
    expect(readEnvFlag('DRY_RUN', { NUDGE_DRY_RUN: 'true' })).toBe(true);
    expect(readEnvFlag('DRY_RUN', { MRA_DRY_RUN: '1' })).toBe(true);
  });

  it('treats anything else, including absent, as false', () => {
    expect(readEnvFlag('DRY_RUN', {})).toBe(false);
    expect(readEnvFlag('DRY_RUN', { NUDGE_DRY_RUN: '0' })).toBe(false);
    expect(readEnvFlag('DRY_RUN', { NUDGE_DRY_RUN: 'yes' })).toBe(false);
  });
});

describe('legacyEnvNames', () => {
  it('lists old-prefix names so startup can point them out', () => {
    const names = legacyEnvNames({ MRA_SILENCE: '1', NUDGE_CONFIG: 'x', MRA_CONFIG: 'y', PATH: '' });
    expect(names).toEqual(['MRA_CONFIG', 'MRA_SILENCE']);
  });

  it('is empty once everything has been renamed', () => {
    expect(legacyEnvNames({ NUDGE_CONFIG: 'x' })).toEqual([]);
  });
});
