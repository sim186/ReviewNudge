import type { Digest, DigestItem } from '../domain/digest.js';
import type { ReasonKind } from '../domain/reasons.js';

export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
  /** The Workflows envelope, ready to POST to a Power Automate webhook. */
  card: TeamsMessage;
}

export interface TeamsMessage {
  type: 'message';
  /** Routing hints for the Flow; harmless if the Flow ignores them. */
  targetUpn: string | null;
  gitlabUsername: string;
  itemCount: number;
  attachments: {
    contentType: 'application/vnd.microsoft.card.adaptive';
    contentUrl: null;
    content: Record<string, unknown>;
  }[];
}

/** Teams rejects oversized cards; keep well under the documented 28 KB ceiling. */
const MAX_CARD_BYTES = 24_000;
const MAX_CARD_ACTIONS = 6;

const KIND_LABEL: Record<ReasonKind, string> = {
  REVIEW_REQUESTED: 'Review',
  ASSIGNEE_ACTION: 'Assignee',
  UNRESOLVED_THREAD: 'Thread',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Neutralises the markdown Teams renders inside a TextBlock. */
export function escapeCardText(value: string): string {
  return value.replace(/([[\]*_`~])/g, '\\$1');
}

export function waitingLabel(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

export function renderSubject(template: string, digest: Digest): string {
  const count = digest.totalItems;
  const rendered = template
    .replace(/\{count\}/g, String(count))
    .replace(/\{username\}/g, digest.username)
    .replace(/\{plural\}/g, count === 1 ? '' : 's');

  // The stock template reads awkwardly at exactly one item; fix that rather than
  // making every operator write a conditional into their config.
  if (count === 1 && rendered === '1 merge requests are waiting for you') {
    return '1 merge request is waiting for you';
  }
  return rendered;
}

function truncationNote(digest: Digest): string | null {
  if (digest.truncated <= 0) return null;
  return `${digest.truncated} more not shown (${digest.totalItems} in total).`;
}

// -------------------------------------------------------------------- text

function renderText(digest: Digest): string {
  const lines: string[] = [];
  lines.push(
    digest.totalItems === 1
      ? '1 merge request is waiting for your input:'
      : `${digest.totalItems} merge requests are waiting for your input:`,
  );
  lines.push('');

  for (const item of digest.items) {
    lines.push(`* ${item.mr.title}`);
    lines.push(`  ${item.mr.projectPath} !${item.mr.iid} — waiting ${waitingLabel(item.waitingDays)}`);
    lines.push(`  ${item.detail}`);
    lines.push(`  ${item.mr.url}`);
    lines.push('');
  }

  const note = truncationNote(digest);
  if (note) lines.push(note, '');

  lines.push('— MergeRequestAlarm');
  return lines.join('\n');
}

// -------------------------------------------------------------------- html

function renderRow(item: DigestItem): string {
  const chips = item.kinds
    .map(
      (k) =>
        `<span style="display:inline-block;padding:1px 6px;margin-right:4px;border-radius:9px;background:#eef1f5;color:#3a4a5e;font-size:11px;">${escapeHtml(
          KIND_LABEL[k],
        )}</span>`,
    )
    .join('');

  const urgent = item.waitingDays >= 7;

  return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e6e9ee;vertical-align:top;">
          <a href="${escapeHtml(item.mr.url)}" style="color:#1f6feb;text-decoration:none;font-weight:600;">${escapeHtml(
            item.mr.title,
          )}</a>
          <div style="color:#6b7684;font-size:12px;margin-top:2px;">${escapeHtml(
            item.mr.projectPath,
          )} !${escapeHtml(item.mr.iid)}</div>
          <div style="margin-top:6px;">${chips}</div>
          <div style="color:#3a4a5e;font-size:13px;margin-top:6px;">${escapeHtml(item.detail)}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e6e9ee;vertical-align:top;text-align:right;white-space:nowrap;color:${
          urgent ? '#b3261e' : '#6b7684'
        };font-size:13px;font-weight:${urgent ? '600' : '400'};">
          ${escapeHtml(waitingLabel(item.waitingDays))}
        </td>
      </tr>`;
}

function renderHtml(digest: Digest): string {
  const heading =
    digest.totalItems === 1
      ? '1 merge request is waiting for your input'
      : `${digest.totalItems} merge requests are waiting for your input`;

  const note = truncationNote(digest);

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b1f24;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6e9ee;border-radius:8px;">
      <tr>
        <td style="padding:16px 12px 8px 12px;">
          <div style="font-size:16px;font-weight:600;">${escapeHtml(heading)}</div>
          <div style="color:#6b7684;font-size:12px;margin-top:2px;">Sorted by how long they have been waiting.</div>
        </td>
      </tr>
      ${digest.items.map(renderRow).join('')}
      ${
        note
          ? `<tr><td colspan="2" style="padding:10px 12px;color:#6b7684;font-size:12px;">${escapeHtml(note)}</td></tr>`
          : ''
      }
      <tr>
        <td colspan="2" style="padding:12px;color:#8b95a1;font-size:11px;border-top:1px solid #e6e9ee;">
          Sent by MergeRequestAlarm. To stop these, snooze yourself or mute a merge request in the admin panel.
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// -------------------------------------------------------------------- card

function cardItemBlocks(item: DigestItem): Record<string, unknown>[] {
  const kinds = item.kinds.map((k) => KIND_LABEL[k]).join(' · ');
  return [
    {
      type: 'ColumnSet',
      separator: true,
      columns: [
        {
          type: 'Column',
          width: 'stretch',
          items: [
            {
              type: 'TextBlock',
              text: `[${escapeCardText(item.mr.title)}](${item.mr.url})`,
              wrap: true,
              weight: 'Bolder',
            },
            {
              type: 'TextBlock',
              text: `${escapeCardText(item.mr.projectPath)} !${item.mr.iid} · ${escapeCardText(kinds)}`,
              wrap: true,
              isSubtle: true,
              spacing: 'None',
              size: 'Small',
            },
            {
              type: 'TextBlock',
              text: escapeCardText(item.detail),
              wrap: true,
              size: 'Small',
            },
          ],
        },
        {
          type: 'Column',
          width: 'auto',
          items: [
            {
              type: 'TextBlock',
              text: waitingLabel(item.waitingDays),
              wrap: false,
              size: 'Small',
              color: item.waitingDays >= 7 ? 'Attention' : 'Default',
              weight: item.waitingDays >= 7 ? 'Bolder' : 'Default',
            },
          ],
        },
      ],
    },
  ];
}

function buildCard(digest: Digest, items: DigestItem[]): Record<string, unknown> {
  const heading =
    digest.totalItems === 1
      ? '1 merge request is waiting for your input'
      : `${digest.totalItems} merge requests are waiting for your input`;

  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', text: heading, weight: 'Bolder', size: 'Medium', wrap: true },
    ...items.flatMap(cardItemBlocks),
  ];

  const hidden = digest.totalItems - items.length;
  if (hidden > 0) {
    body.push({
      type: 'TextBlock',
      text: `_${hidden} more not shown._`,
      wrap: true,
      isSubtle: true,
      size: 'Small',
    });
  }

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body,
    // Buttons are capped: Teams renders only a handful well, and every item is
    // already a link in its own row.
    actions: items.slice(0, MAX_CARD_ACTIONS).map((item) => ({
      type: 'Action.OpenUrl',
      title: item.mr.title.length > 40 ? `${item.mr.title.slice(0, 39)}…` : item.mr.title,
      url: item.mr.url,
    })),
  };
}

function wrap(digest: Digest, card: Record<string, unknown>): TeamsMessage {
  return {
    type: 'message',
    targetUpn: digest.recipient.teams_upn,
    gitlabUsername: digest.username,
    itemCount: digest.totalItems,
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: card,
      },
    ],
  };
}

/**
 * Builds the Teams payload, shedding rows until it fits. A card Teams refuses to
 * render is worse than a card that says "12 more not shown".
 */
function renderCard(digest: Digest): TeamsMessage {
  let items = digest.items;
  for (;;) {
    const message = wrap(digest, buildCard(digest, items));
    if (Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_CARD_BYTES || items.length <= 1) {
      return message;
    }
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
  }
}

export function renderDigest(digest: Digest, subjectTemplate: string): RenderedDigest {
  return {
    subject: renderSubject(subjectTemplate, digest),
    text: renderText(digest),
    html: renderHtml(digest),
    card: renderCard(digest),
  };
}
