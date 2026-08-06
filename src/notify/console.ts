import type { Channel } from '../config/schema.js';
import type { Digest } from '../domain/digest.js';
import type { RenderedDigest } from './render.js';
import type { Notifier } from './types.js';

/**
 * Prints what would have been delivered. Used by `--dry-run`, which is the
 * recommended way to try a new configuration against a real GitLab instance.
 */
export class ConsoleNotifier implements Notifier {
  constructor(
    readonly channel: Channel,
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  async send(digest: Digest, rendered: RenderedDigest): Promise<void> {
    const target =
      this.channel === 'email' ? digest.recipient.email : digest.recipient.teams_upn;

    this.write('');
    this.write(`── ${this.channel} → ${digest.username} <${target ?? 'no address'}>`);
    this.write(`   ${rendered.subject}`);
    for (const item of digest.items) {
      this.write(`   • [${item.waitingDays}d] ${item.mr.projectPath}!${item.mr.iid} ${item.mr.title}`);
      this.write(`     ${item.detail}`);
      this.write(`     ${item.mr.url}`);
    }
    if (digest.truncated > 0) {
      this.write(`   … ${digest.truncated} more not shown`);
    }
  }
}
