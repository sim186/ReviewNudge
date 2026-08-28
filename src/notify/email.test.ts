import { describe, expect, it } from 'vitest';
import { fromHeader } from './email.js';

describe('fromHeader', () => {
  it('names the product when the operator configured a bare address', () => {
    // The deployed relay mailbox is called gitlab@, which is what recipients saw.
    expect(fromHeader('gitlab@topseven.cloud')).toBe('ReviewNudge <gitlab@topseven.cloud>');
  });

  it('leaves a display name the operator chose alone', () => {
    expect(fromHeader('Merge Robot <gitlab@topseven.cloud>')).toBe(
      'Merge Robot <gitlab@topseven.cloud>',
    );
    expect(fromHeader('"Review, Nudge" <a@b.c>')).toBe('"Review, Nudge" <a@b.c>');
  });

  it('tolerates stray whitespace around a configured value', () => {
    expect(fromHeader('  gitlab@topseven.cloud  ')).toBe('ReviewNudge <gitlab@topseven.cloud>');
  });
});
