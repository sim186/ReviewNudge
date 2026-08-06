import type { Config } from '../config/schema.js';
import type { Digest } from '../domain/digest.js';
import type { RenderedDigest } from './render.js';
import type { Notifier } from './types.js';

type TeamsConfig = NonNullable<Config['teams']>;

/**
 * Delivers through a Power Automate "When a Teams webhook request is received"
 * trigger. Office 365 connectors — the old `outlook.office.com/webhook` incoming
 * webhooks — were retired on 30 April 2026 and are not supported.
 *
 * One workflow URL serves everyone: the payload carries `targetUpn` so the Flow can
 * route the card to the right person.
 */
export class TeamsNotifier implements Notifier {
  readonly channel = 'teams' as const;

  constructor(
    private readonly config: TeamsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(digest: Digest, rendered: RenderedDigest): Promise<void> {
    if (!digest.recipient.teams_upn) {
      throw new Error(`recipient ${digest.username} has no Teams UPN`);
    }
    await this.post(rendered.card);
  }

  private async post(payload: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.workflow_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const message = (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      throw new Error(`Teams workflow request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    // Power Automate answers 202 Accepted for an asynchronous flow, and 200 for a
    // synchronous one. Anything else means the card did not reach Teams.
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Teams workflow returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
      );
    }
  }
}
