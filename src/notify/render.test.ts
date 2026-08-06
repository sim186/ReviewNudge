import { describe, expect, it } from 'vitest';
import type { Digest, DigestItem } from '../domain/digest.js';
import type { ReasonKind } from '../domain/reasons.js';
import {
  escapeCardText,
  escapeHtml,
  renderDigest,
  renderSubject,
  waitingLabel,
  waitingPhrase,
} from './render.js';

function item(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    mr: {
      url: 'https://gitlab.example.com/a/b/-/merge_requests/1',
      title: 'Fix the thing',
      projectPath: 'a/b',
      iid: '1',
      author: 'author',
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-05T00:00:00Z',
      lastPushAt: '2026-08-05T00:00:00Z',
      labels: [],
      notesCount: 0,
    },
    kinds: ['REVIEW_REQUESTED'] as ReasonKind[],
    waitingSince: '2026-08-05T00:00:00Z',
    waitingDays: 3,
    detail: 'Review requested — you have not approved yet',
    ...overrides,
  };
}

function digest(overrides: Partial<Digest> = {}): Digest {
  const items = overrides.items ?? [item()];
  return {
    username: 'alice',
    recipient: {
      gitlab_username: 'alice',
      email: 'alice@example.com',
      teams_upn: 'alice@example.com',
      channels: null,
      snooze_until: null,
      enabled: true,
    },
    channels: ['email', 'teams'],
    items,
    totalItems: items.length,
    truncated: 0,
    ...overrides,
  };
}

const TEMPLATE = '{count} merge requests are waiting for you';

describe('helpers', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;',
    );
  });

  it('escapes the markdown Teams renders in a TextBlock', () => {
    expect(escapeCardText('a [link](x) *bold* _em_')).toBe('a \\[link\\](x) \\*bold\\* \\_em\\_');
  });

  it('describes waiting time in plain words', () => {
    expect(waitingLabel(0)).toBe('today');
    expect(waitingLabel(1)).toBe('1 day');
    expect(waitingLabel(9)).toBe('9 days');
  });

  it('uses a duration, not a day, when the age sits inside a sentence', () => {
    // "waiting today" is not English, which is why this differs from waitingLabel.
    expect(waitingPhrase(0)).toBe('less than a day');
    expect(waitingPhrase(1)).toBe('1 day');
    expect(waitingPhrase(9)).toBe('9 days');
  });

  it('never emits "waiting today" in any prose body', () => {
    const fresh = item({ waitingDays: 0 });
    const links = { mute: () => 'https://x/m', manage: 'https://x/me' };
    const out = renderDigest(digest({ items: [fresh] }), TEMPLATE, links);

    expect(out.text).toContain('waiting less than a day');
    expect(out.text).not.toContain('waiting today');
    expect(out.telegramHtml).not.toContain('waiting today');
    expect(JSON.stringify(out.slackBlocks)).not.toContain('waiting today');
    // The standalone HTML age column still reads "today", which is correct there.
    expect(out.html).toContain('today');
  });
});

describe('renderSubject', () => {
  it('substitutes the placeholders', () => {
    expect(renderSubject('{count} for {username}', digest())).toBe('1 for alice');
  });

  it('fixes the stock template at exactly one item', () => {
    expect(renderSubject(TEMPLATE, digest())).toBe('1 merge request is waiting for you');
  });

  it('leaves a custom template alone', () => {
    expect(renderSubject('You have {count} MR{plural}', digest())).toBe('You have 1 MR');
  });

  it('counts the uncapped total, not the shown items', () => {
    const d = digest({ items: [item()], totalItems: 30, truncated: 29 });
    expect(renderSubject(TEMPLATE, d)).toBe('30 merge requests are waiting for you');
  });
});

describe('renderDigest', () => {
  it('produces all three representations', () => {
    const out = renderDigest(digest(), TEMPLATE);
    expect(out.subject).toContain('1 merge request');
    expect(out.text).toContain('https://gitlab.example.com/a/b/-/merge_requests/1');
    expect(out.html).toContain('<a href="https://gitlab.example.com/a/b/-/merge_requests/1"');
    expect(out.card.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('escapes a hostile merge request title in the HTML body', () => {
    const evil = item({ mr: { ...item().mr, title: '<script>alert(1)</script>' } });
    const out = renderDigest(digest({ items: [evil] }), TEMPLATE);
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('mentions the truncated remainder in every representation', () => {
    const d = digest({ items: [item()], totalItems: 5, truncated: 4 });
    const out = renderDigest(d, TEMPLATE);
    expect(out.text).toContain('4 more not shown');
    expect(out.html).toContain('4 more not shown');
    expect(JSON.stringify(out.card)).toContain('4 more not shown');
  });

  it('carries routing hints on the Teams envelope', () => {
    const out = renderDigest(digest(), TEMPLATE);
    expect(out.card.targetUpn).toBe('alice@example.com');
    expect(out.card.gitlabUsername).toBe('alice');
    expect(out.card.itemCount).toBe(1);
    expect(out.card.type).toBe('message');
  });

  it('exposes the card at the top level as well as inside attachments', () => {
    // triggerBody()?['card'] is much easier to write in Power Automate than
    // reaching into the attachments array, so both are offered.
    const out = renderDigest(digest(), TEMPLATE);
    expect(out.card.card).toBe(out.card.attachments[0]!.content);
    expect(out.card.card).toMatchObject({ type: 'AdaptiveCard', version: '1.4' });
  });

  it('addresses one person per message, never a broadcast', () => {
    const bob = renderDigest(
      digest({
        username: 'bob',
        recipient: {
          gitlab_username: 'bob',
          email: null,
          teams_upn: 'bob@example.com',
          channels: null,
          snooze_until: null,
          enabled: true,
        },
      }),
      TEMPLATE,
    );
    expect(bob.card.targetUpn).toBe('bob@example.com');
    expect(bob.card.gitlabUsername).toBe('bob');
    // Nothing in the payload references anyone else.
    expect(JSON.stringify(bob.card)).not.toContain('alice');
  });

  it('caps Adaptive Card actions at six', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item({ mr: { ...item().mr, iid: String(i), title: `MR ${i}` } }),
    );
    const out = renderDigest(digest({ items, totalItems: 10 }), TEMPLATE);
    const actions = (out.card.attachments[0]!.content as { actions: unknown[] }).actions;
    expect(actions).toHaveLength(6);
  });

  it('shortens an over-long action title', () => {
    const long = item({ mr: { ...item().mr, title: 'x'.repeat(80) } });
    const out = renderDigest(digest({ items: [long] }), TEMPLATE);
    const actions = (out.card.attachments[0]!.content as { actions: { title: string }[] }).actions;
    expect(actions[0]!.title).toHaveLength(40);
    expect(actions[0]!.title.endsWith('…')).toBe(true);
  });

  it('sheds rows so a huge digest still fits the Teams size limit', () => {
    const items = Array.from({ length: 200 }, (_, i) =>
      item({
        mr: { ...item().mr, iid: String(i), title: `A fairly long merge request title number ${i}` },
        detail: 'Review requested — you have not approved yet; 3 unresolved threads from reviewers',
      }),
    );
    const out = renderDigest(digest({ items, totalItems: 200 }), TEMPLATE);
    const bytes = Buffer.byteLength(JSON.stringify(out.card), 'utf8');

    expect(bytes).toBeLessThanOrEqual(24_000);
    // The subject and heading still report the true total.
    expect(out.card.itemCount).toBe(200);
    expect(JSON.stringify(out.card)).toContain('more not shown');
  });

  it('marks a long wait as urgent in both HTML and card', () => {
    const stale = item({ waitingDays: 12 });
    const out = renderDigest(digest({ items: [stale] }), TEMPLATE);
    expect(out.html).toContain('#b3261e');
    expect(JSON.stringify(out.card)).toContain('Attention');
  });

  it('leaves self-service links out when none are supplied', () => {
    const out = renderDigest(digest(), TEMPLATE);
    expect(out.text).not.toContain('Mute this one');
    expect(out.html).not.toContain('Mute this one');
    expect(out.html).toContain('ask an administrator');
    expect(JSON.stringify(out.card)).not.toContain('Mute or pause');
  });

  it('carries a per-item mute link and a manage link in all three formats', () => {
    const links = {
      mute: (mrUrl: string) => `https://nudge.example.com/me/tok/mute?mr=${encodeURIComponent(mrUrl)}`,
      manage: 'https://nudge.example.com/me/tok',
    };
    const out = renderDigest(digest(), TEMPLATE, links);

    expect(out.text).toContain('Mute this one: https://nudge.example.com/me/tok/mute?mr=');
    expect(out.text).toContain('pause everything: https://nudge.example.com/me/tok');

    expect(out.html).toContain('Mute this one');
    expect(out.html).toContain('https://nudge.example.com/me/tok');

    const card = JSON.stringify(out.card);
    expect(card).toContain('Mute this one');
    expect(card).toContain('Mute or pause');
  });

  it('escapes a hostile title in the mute link row', () => {
    const evil = item({ mr: { ...item().mr, title: '"><script>x</script>' } });
    const links = { mute: () => 'https://nudge.example.com/m', manage: 'https://nudge.example.com/me' };
    const out = renderDigest(digest({ items: [evil] }), TEMPLATE, links);
    expect(out.html).not.toContain('<script>x</script>');
  });

  it('still fits the Teams size limit with links attached', () => {
    const items = Array.from({ length: 200 }, (_, i) =>
      item({ mr: { ...item().mr, iid: String(i), title: `A fairly long merge request title ${i}` } }),
    );
    const links = {
      mute: (mrUrl: string) => `https://nudge.example.com/me/tok/mute?mr=${encodeURIComponent(mrUrl)}`,
      manage: 'https://nudge.example.com/me/tok',
    };
    const out = renderDigest(digest({ items, totalItems: 200 }), TEMPLATE, links);
    expect(Buffer.byteLength(JSON.stringify(out.card), 'utf8')).toBeLessThanOrEqual(24_000);
  });

  it('lists every reason kind on a merged row', () => {
    const merged = item({ kinds: ['ASSIGNEE_ACTION', 'UNRESOLVED_THREAD'] as ReasonKind[] });
    const out = renderDigest(digest({ items: [merged] }), TEMPLATE);
    expect(out.html).toContain('Assignee');
    expect(out.html).toContain('Thread');
    expect(JSON.stringify(out.card)).toContain('Assignee · Thread');
  });
});
