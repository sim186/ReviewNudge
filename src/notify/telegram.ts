import type { Config } from '../config/schema.js';
import type { Digest } from '../domain/digest.js';
import type { RenderedDigest } from './render.js';
import type { Notifier } from './types.js';

type TelegramConfig = NonNullable<Config['telegram']>;

interface TelegramResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
}

/** Telegram rejects messages over 4096 characters. */
const MAX_MESSAGE_CHARS = 4096;

/**
 * Delivers through the Bot API's `sendMessage`.
 *
 * Telegram bots cannot start a conversation: the person must message the bot once, and
 * the resulting chat ID is what we store. That is why the recipient field is a numeric
 * chat ID rather than an @handle.
 *
 * HTML is used rather than MarkdownV2 because MarkdownV2 requires escaping a long list
 * of characters that appear constantly in merge request titles, and one missed escape
 * fails the whole send.
 */
export class TelegramNotifier implements Notifier {
  readonly channel = 'telegram' as const;

  constructor(
    private readonly config: TelegramConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(digest: Digest, rendered: RenderedDigest): Promise<void> {
    const chatId = digest.recipient.telegram_chat_id;
    if (!chatId) {
      throw new Error(`recipient ${digest.username} has no Telegram chat ID`);
    }

    await this.call('sendMessage', {
      chat_id: chatId,
      text: truncate(rendered.telegramHtml),
      parse_mode: 'HTML',
      // Digests are full of merge request links; previews would bury the text.
      link_preview_options: { is_disabled: true },
      disable_notification: this.config.disable_notification,
    });
  }

  /** Confirms the bot token is valid before anything is sent. */
  async verify(): Promise<void> {
    await this.call('getMe', {});
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<TelegramResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.api_url}/bot${this.config.bot_token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const message =
        (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      throw new Error(`Telegram ${method} request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    // Telegram reports application errors with a non-2xx status *and* a description,
    // which is far more useful than the status alone.
    const body = (await response.json().catch(() => null)) as TelegramResponse | null;
    if (!body?.ok) {
      const detail = body?.description ?? `HTTP ${response.status}`;
      throw new Error(`Telegram ${method} failed: ${detail}`);
    }
    return body;
  }
}

/** Trims to the API limit on a line boundary, so no HTML tag is cut in half. */
export function truncate(text: string, limit = MAX_MESSAGE_CHARS): string {
  if (text.length <= limit) return text;

  const notice = '\n\n<i>…truncated.</i>';
  const room = limit - notice.length;
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf('\n');

  return `${lastBreak > room / 2 ? cut.slice(0, lastBreak) : cut}${notice}`;
}
