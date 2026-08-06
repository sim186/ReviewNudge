import { describe, expect, it, vi } from 'vitest';
import type { Digest } from '../domain/digest.js';
import { renderDigest } from './render.js';
import { TelegramNotifier, truncate } from './telegram.js';

const config = {
  bot_token: '123:ABC',
  api_url: 'https://telegram.example.com',
  timeout_ms: 5000,
  disable_notification: false,
};

function digest(chatId: string | null = '987654321', title = 'Fix the thing'): Digest {
  const mr = {
    url: 'https://gitlab.example.com/a/b/-/merge_requests/1',
    title,
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
      slack_id: null,
      telegram_chat_id: chatId,
      channels: null,
      snooze_until: null,
      enabled: true,
    },
    channels: ['telegram'],
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

describe('TelegramNotifier', () => {
  it('posts sendMessage to the person chat ID with HTML parsing', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const d = digest();
    await new TelegramNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://telegram.example.com/bot123:ABC/sendMessage');

    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe('987654321');
    expect(body.parse_mode).toBe('HTML');
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    expect(body.text).toContain('Fix the thing');
  });

  it('escapes a title that would otherwise break the HTML parse', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const d = digest('987654321', '<script> & "quotes"');
    await new TelegramNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d));

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.text).toContain('&lt;script&gt; &amp; "quotes"');
    expect(body.text).not.toContain('<script>');
  });

  it('surfaces the API description rather than just the status', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error_code: 400, description: 'chat not found' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const d = digest();
    await expect(
      new TelegramNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/sendMessage failed: chat not found/);
  });

  it('falls back to the status when there is no parseable body', async () => {
    const fetchImpl = vi.fn(async () => new Response('gateway error', { status: 502 }));
    const d = digest();
    await expect(
      new TelegramNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/HTTP 502/);
  });

  it('refuses to send to someone with no chat ID', async () => {
    const fetchImpl = vi.fn();
    const d = digest(null);
    await expect(
      new TelegramNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/no Telegram chat ID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honours disable_notification', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const d = digest();
    await new TelegramNotifier(
      { ...config, disable_notification: true },
      fetchImpl as unknown as typeof fetch,
    ).send(d, rendered(d));

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.disable_notification).toBe(true);
  });

  it('checks the token with getMe', async () => {
    const fetchImpl = vi.fn(async () => ok());
    await new TelegramNotifier(config, fetchImpl as unknown as typeof fetch).verify();
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain('/getMe');
  });
});

describe('truncate', () => {
  it('leaves a short message alone', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('cuts on a line boundary and says it was truncated', () => {
    // 62 characters against a 50 limit, so the cut genuinely has to happen.
    const text = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)].join('\n');
    const out = truncate(text, 50);

    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toContain('truncated');
    // The whole first line survives and no later line is left half-written.
    expect(out).toContain('a'.repeat(20));
    expect(out).not.toContain('b');
  });

  it('still fits the limit when there is no usable line break', () => {
    const out = truncate('x'.repeat(500), 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toContain('truncated');
  });
});
