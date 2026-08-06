import { describe, expect, it, vi } from 'vitest';
import type { Digest } from '../domain/digest.js';
import { renderDigest } from './render.js';
import { TeamsNotifier } from './teams.js';

const config = { workflow_url: 'https://example.logic.azure.com/workflows/abc', timeout_ms: 5000 };

function digest(teamsUpn: string | null = 'alice@example.com'): Digest {
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
  };
  return {
    username: 'alice',
    recipient: {
      gitlab_username: 'alice',
      email: null,
      teams_upn: teamsUpn,
      channels: null,
      snooze_until: null,
      enabled: true,
    },
    channels: ['teams'],
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

describe('TeamsNotifier', () => {
  it('posts the Adaptive Card envelope to the workflow URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    const d = digest();
    await new TeamsNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(config.workflow_url);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('message');
    expect(body.targetUpn).toBe('alice@example.com');
    expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(body.attachments[0].content.type).toBe('AdaptiveCard');
    expect(body.attachments[0].content.version).toBe('1.4');
  });

  it('accepts 200 as well as 202', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const d = digest();
    await expect(
      new TeamsNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).resolves.toBeUndefined();
  });

  it('reports the status and body when the flow rejects the card', async () => {
    const fetchImpl = vi.fn(async () => new Response('Bad Request: invalid card', { status: 400 }));
    const d = digest();
    await expect(
      new TeamsNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/HTTP 400: Bad Request: invalid card/);
  });

  it('refuses to send to a recipient with no Teams identity', async () => {
    const fetchImpl = vi.fn();
    const d = digest(null);
    await expect(
      new TeamsNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/no Teams UPN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a network failure as a delivery error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('EAI_AGAIN'));
    const d = digest();
    await expect(
      new TeamsNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/Teams workflow request failed: EAI_AGAIN/);
  });

  it('reports a timeout distinctly', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn().mockRejectedValue(abortError);
    const d = digest();
    await expect(
      new TeamsNotifier(config, fetchImpl as unknown as typeof fetch).send(d, rendered(d)),
    ).rejects.toThrow(/request timed out/);
  });
});
