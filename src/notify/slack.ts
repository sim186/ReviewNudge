import type { Config } from '../config/schema.js';
import type { Digest } from '../domain/digest.js';
import type { RenderedDigest } from './render.js';
import type { Notifier } from './types.js';

type SlackConfig = NonNullable<Config['slack']>;

interface SlackResponse {
  ok: boolean;
  error?: string;
  warning?: string;
}

/**
 * Delivers through `chat.postMessage` with a bot token.
 *
 * A bot token rather than an incoming webhook, because webhooks are bound to one
 * channel and cannot open a direct message. Posting with a member ID (`U…`) as the
 * channel opens the bot's DM with that person, which is what a personal digest wants.
 * The bot needs the `chat:write` scope and must be installed in the workspace; it does
 * not need to be invited anywhere for direct messages.
 */
export class SlackNotifier implements Notifier {
  readonly channel = 'slack' as const;

  constructor(
    private readonly config: SlackConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(digest: Digest, rendered: RenderedDigest): Promise<void> {
    const target = digest.recipient.slack_id;
    if (!target) {
      throw new Error(`recipient ${digest.username} has no Slack member ID`);
    }

    await this.call('chat.postMessage', {
      channel: target,
      // Shown in notifications and by clients that cannot render blocks.
      text: rendered.subject,
      blocks: rendered.slackBlocks,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  /** Confirms the token is valid before anything is sent. */
  async verify(): Promise<void> {
    await this.call('auth.test', {});
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<SlackResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.api_url}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${this.config.bot_token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const message =
        (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      throw new Error(`Slack ${method} request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`Slack ${method} returned HTTP ${response.status}`);
    }

    // Slack answers 200 with ok:false for application errors, so the body is the
    // real result. `channel_not_found` here usually means an @handle was pasted
    // where a member ID belongs.
    const body = (await response.json()) as SlackResponse;
    if (!body.ok) {
      throw new Error(`Slack ${method} failed: ${body.error ?? 'unknown error'}`);
    }
    return body;
  }
}
