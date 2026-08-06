import { describe, expect, it, vi } from 'vitest';
import type { Digest } from '../domain/digest.js';
import { renderDigest } from './render.js';
import { SlackNotifier } from './slack.js';

const config = {
  bot_token: 'xoxb-test',
  api_url: 'https://slack.example.com/api',
  timeout_ms: 5000,
};

function digest(slackId: string | null = 'U012ABCDEF'): Digest {
  const mr = {
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
  };
  return {
    username: 'alice',
    recipient: {
      gitlab_username: 'alice',
      email: null,
      teams_upn: null,
      slack_id: slackId,
      telegram_chat_id: null,
      channels: null,
      snooze_until: null,
      enabled: true,
    },
    channels: ['slack'],
    items: [
      {
        mr,
        kinds: ['REVIEW_REQUESTED'],
        waitingSince: '2026-08-05T00:00:00Z',
        waitingDays: 3,
        detail: 'Review requested',
      },
    ],
    totalItems: 1,
    truncated: 0,
  };
}

const rendered = (d: Digest) => renderDigest(d, '{count} waiting');
const ok = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('SlackNotifier', () => {
  it('posts to chat.postMessage addressed at the member ID', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const d = digest();
    await new SlackNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://slack.example.com/api/chat.postMessage');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer xoxb-test');

    const body = JSON.parse(init.body as string);
    // A member ID as the channel is what opens a direct message.
    expect(body.channel).toBe('U012ABCDEF');
    expect(body.text).toContain('waiting');
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.unfurl_links).toBe(false);
  });

  it('treats ok:false as a failure even though the status is 200', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const d = digest();
    await expect(
      new SlackNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/chat\.postMessage failed: channel_not_found/);
  });

  it('reports a transport failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const d = digest();
    await expect(
      new SlackNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('reports a timeout distinctly', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn().mockRejectedValue(abort);
    const d = digest();
    await expect(
      new SlackNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/request timed out/);
  });

  it('refuses to send to someone with no member ID', async () => {
    const fetchImpl = vi.fn();
    const d = digest(null);
    await expect(
      new SlackNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/no Slack member ID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks the token with auth.test', async () => {
    const fetchImpl = vi.fn(async () => ok());
    await new SlackNotifier(config, fetchImpl as unknown as typeof fetch).verify();
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://slack.example.com/api/auth.test',
    );
  });
});
