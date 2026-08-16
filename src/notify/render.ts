import type { Digest, DigestItem } from '../domain/digest.js';
import type { ReasonKind } from '../domain/reasons.js';

/** Links that let the recipient act on their own notifications. */
export interface SelfServiceLinks {
  /** Per merge request URL, the page that offers to mute it. */
  mute: (mrUrl: string) => string;
  /** The recipient's own notifications page. */
  manage: string;
}

export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
  /** The Workflows envelope, ready to POST to a Power Automate webhook. */
  card: TeamsMessage;
  /** Block Kit blocks for Slack's chat.postMessage. */
  slackBlocks: Record<string, unknown>[];
  /** Telegram-flavoured HTML, which supports only a small tag subset. */
  telegramHtml: string;
}

export interface TeamsMessage {
  type: 'message';
  /** Routing hints for the Flow; harmless if the Flow ignores them. */
  targetUpn: string | null;
  gitlabUsername: string;
  itemCount: number;
  /**
   * The same card as `attachments[0].content`, hoisted to the top level because
   * `triggerBody()?['card']` is far easier to write in a Power Automate expression than
   * reaching into the attachments array.
   */
  card: Record<string, unknown>;
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
  MR_WARNING: 'Unattended',
};

/**
 * The warning box is deliberately subordinate to the row it hangs off: it explains
 * something about the merge request, never a fresh demand on the reader. Rendering it
 * as a labelled aside rather than another bullet keeps "you are blocking three people"
 * visually louder than "this has no ticket".
 */
const WARNING_HEADING = 'Needs attention';

function warningDetails(item: DigestItem): string[] {
  return item.mr.warnings.map((w) => w.detail);
}

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

/** Standalone label for an age column, where "today" reads naturally on its own. */
export function waitingLabel(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/**
 * The same age inside a sentence, as in "waiting …".
 *
 * `waitingLabel` cannot be reused here: "waiting today" is not English. This stays a
 * duration rather than a point in time so the prefix always reads correctly.
 */
export function waitingPhrase(days: number): string {
  if (days <= 0) return 'less than a day';
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

function renderText(digest: Digest, links?: SelfServiceLinks | null): string {
  const lines: string[] = [];
  lines.push(
    digest.totalItems === 1
      ? '1 merge request is waiting for your input:'
      : `${digest.totalItems} merge requests are waiting for your input:`,
  );
  lines.push('');

  for (const item of digest.items) {
    lines.push(`* ${item.mr.title}`);
    lines.push(
      `  ${item.mr.projectPath} !${item.mr.iid} — waiting ${waitingPhrase(item.waitingDays)}`,
    );
    lines.push(`  ${item.detail}`);
    const warnings = warningDetails(item);
    if (warnings.length > 0) {
      lines.push(`  ${WARNING_HEADING}:`);
      for (const detail of warnings) lines.push(`    - ${detail}`);
    }
    lines.push(`  ${item.mr.url}`);
    if (links) lines.push(`  Mute this one: ${links.mute(item.mr.url)}`);
    lines.push('');
  }

  const note = truncationNote(digest);
  if (note) lines.push(note, '');

  if (links) {
    lines.push(`Mute one of these, or pause everything: ${links.manage}`);
    lines.push('');
  }
  lines.push('— ReviewNudge');
  return lines.join('\n');
}

// -------------------------------------------------------------------- html

/**
 * Inline styles rather than a class, because every mail client that matters strips or
 * ignores a stylesheet in the head — the rest of this template works the same way.
 */
function renderWarningBox(item: DigestItem): string {
  const warnings = warningDetails(item);
  if (warnings.length === 0) return '';

  const rows = warnings
    .map(
      (detail) =>
        `<div style="color:#7a4b00;font-size:12px;margin-top:2px;">• ${escapeHtml(detail)}</div>`,
    )
    .join('');

  return `<div style="margin-top:8px;padding:8px 10px;background:#fff8e6;border-left:3px solid #d9a300;border-radius:3px;">
            <div style="color:#7a4b00;font-size:12px;font-weight:600;">${escapeHtml(WARNING_HEADING)}</div>
            ${rows}
          </div>`;
}

function renderRow(item: DigestItem, links?: SelfServiceLinks | null): string {
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
          ${renderWarningBox(item)}
          ${
            links
              ? `<div style="margin-top:6px;"><a href="${escapeHtml(
                  links.mute(item.mr.url),
                )}" style="color:#6b7684;text-decoration:underline;font-size:12px;">Mute this one</a></div>`
              : ''
          }
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e6e9ee;vertical-align:top;text-align:right;white-space:nowrap;color:${
          urgent ? '#b3261e' : '#6b7684'
        };font-size:13px;font-weight:${urgent ? '600' : '400'};">
          ${escapeHtml(waitingLabel(item.waitingDays))}
        </td>
      </tr>`;
}

function renderHtml(digest: Digest, links?: SelfServiceLinks | null): string {
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
      ${digest.items.map((item) => renderRow(item, links)).join('')}
      ${
        note
          ? `<tr><td colspan="2" style="padding:10px 12px;color:#6b7684;font-size:12px;">${escapeHtml(note)}</td></tr>`
          : ''
      }
      <tr>
        <td colspan="2" style="padding:12px;color:#8b95a1;font-size:11px;border-top:1px solid #e6e9ee;">
          Sent by ReviewNudge.
          ${
            links
              ? `<a href="${escapeHtml(links.manage)}" style="color:#6b7684;">Mute one of these, or pause everything.</a>`
              : 'To stop these, ask an administrator to snooze you or mute a merge request.'
          }
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// -------------------------------------------------------------------- card

function cardItemBlocks(item: DigestItem, links?: SelfServiceLinks | null): Record<string, unknown>[] {
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
            ...(warningDetails(item).length > 0
              ? [
                  {
                    type: 'TextBlock',
                    text: `${escapeCardText(WARNING_HEADING)}: ${escapeCardText(
                      warningDetails(item).join('; '),
                    )}`,
                    wrap: true,
                    size: 'Small',
                    color: 'Warning',
                    spacing: 'Small',
                  },
                ]
              : []),
            ...(links
              ? [
                  {
                    type: 'TextBlock',
                    text: `[Mute this one](${links.mute(item.mr.url)})`,
                    wrap: true,
                    isSubtle: true,
                    spacing: 'None',
                    size: 'Small',
                  },
                ]
              : []),
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

function buildCard(
  digest: Digest,
  items: DigestItem[],
  links?: SelfServiceLinks | null,
): Record<string, unknown> {
  const heading =
    digest.totalItems === 1
      ? '1 merge request is waiting for your input'
      : `${digest.totalItems} merge requests are waiting for your input`;

  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', text: heading, weight: 'Bolder', size: 'Medium', wrap: true },
    ...items.flatMap((item) => cardItemBlocks(item, links)),
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
    actions: [
      ...items.slice(0, MAX_CARD_ACTIONS).map((item) => ({
        type: 'Action.OpenUrl',
        title: item.mr.title.length > 40 ? `${item.mr.title.slice(0, 39)}…` : item.mr.title,
        url: item.mr.url,
      })),
      ...(links
        ? [{ type: 'Action.OpenUrl', title: 'Mute or pause…', url: links.manage }]
        : []),
    ],
  };
}

function wrap(digest: Digest, card: Record<string, unknown>): TeamsMessage {
  return {
    type: 'message',
    targetUpn: digest.recipient.teams_upn,
    gitlabUsername: digest.username,
    itemCount: digest.totalItems,
    card,
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
function renderCard(digest: Digest, links?: SelfServiceLinks | null): TeamsMessage {
  let items = digest.items;
  for (;;) {
    const message = wrap(digest, buildCard(digest, items, links));
    if (Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_CARD_BYTES || items.length <= 1) {
      return message;
    }
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
  }
}

export function renderDigest(
  digest: Digest,
  subjectTemplate: string,
  links?: SelfServiceLinks | null,
): RenderedDigest {
  return {
    subject: renderSubject(subjectTemplate, digest),
    text: renderText(digest, links),
    html: renderHtml(digest, links),
    card: renderCard(digest, links),
    slackBlocks: renderSlackBlocks(digest, links),
    telegramHtml: renderTelegramHtml(digest, links),
  };
}

// ------------------------------------------------------------------- slack

/** Escapes the three characters Slack treats specially in message text. */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Slack link syntax is <url|label>, not markdown. */
function slackLink(url: string, label: string): string {
  return `<${url}|${escapeSlackText(label)}>`;
}

/** Block Kit caps a message at 50 blocks; stay clear of it. */
const MAX_SLACK_BLOCKS = 45;

function renderSlackBlocks(
  digest: Digest,
  links?: SelfServiceLinks | null,
): Record<string, unknown>[] {
  const heading =
    digest.totalItems === 1
      ? '1 merge request is waiting for your input'
      : `${digest.totalItems} merge requests are waiting for your input`;

  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: heading, emoji: false } },
  ];

  // Two blocks per item, minus the header and footer allowance.
  const room = Math.max(1, Math.floor((MAX_SLACK_BLOCKS - 3) / 2));
  const shown = digest.items.slice(0, room);

  for (const item of shown) {
    const kinds = item.kinds.map((k) => KIND_LABEL[k]).join(' · ');
    const muteSuffix = links ? ` · ${slackLink(links.mute(item.mr.url), 'mute this one')}` : '';

    const warnings = warningDetails(item);
    const warningLine =
      warnings.length > 0
        ? `\n> *${escapeSlackText(WARNING_HEADING)}:* ${escapeSlackText(warnings.join('; '))}`
        : '';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${slackLink(item.mr.url, item.mr.title)}*\n${escapeSlackText(item.detail)}${warningLine}`,
      },
    });
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${escapeSlackText(item.mr.projectPath)} !${escapeSlackText(item.mr.iid)} · ${escapeSlackText(kinds)} · waiting ${waitingPhrase(item.waitingDays)}${muteSuffix}`,
        },
      ],
    });
  }

  const hidden = digest.totalItems - shown.length;
  const footer: string[] = [];
  if (hidden > 0) footer.push(`_${hidden} more not shown._`);
  if (links) footer.push(slackLink(links.manage, 'Mute one of these, or pause everything'));
  if (footer.length > 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer.join(' · ') }] });
  }

  return blocks;
}

// ---------------------------------------------------------------- telegram

/**
 * Telegram's HTML mode understands a short tag list and requires the same three
 * escapes as Slack. Anything else in the text must be escaped or the send is rejected.
 */
export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderTelegramHtml(digest: Digest, links?: SelfServiceLinks | null): string {
  const heading =
    digest.totalItems === 1
      ? '<b>1 merge request is waiting for your input</b>'
      : `<b>${digest.totalItems} merge requests are waiting for your input</b>`;

  const lines: string[] = [heading, ''];

  for (const item of digest.items) {
    const kinds = item.kinds.map((k) => KIND_LABEL[k]).join(' · ');
    lines.push(
      `• <a href="${escapeTelegramHtml(item.mr.url)}">${escapeTelegramHtml(item.mr.title)}</a>`,
    );
    lines.push(
      `  <i>${escapeTelegramHtml(item.mr.projectPath)} !${escapeTelegramHtml(item.mr.iid)} · ${escapeTelegramHtml(kinds)} · waiting ${waitingPhrase(item.waitingDays)}</i>`,
    );
    lines.push(`  ${escapeTelegramHtml(item.detail)}`);
    const warnings = warningDetails(item);
    if (warnings.length > 0) {
      lines.push(
        `  <b>${escapeTelegramHtml(WARNING_HEADING)}:</b> ${escapeTelegramHtml(warnings.join('; '))}`,
      );
    }
    if (links) {
      lines.push(`  <a href="${escapeTelegramHtml(links.mute(item.mr.url))}">Mute this one</a>`);
    }
    lines.push('');
  }

  const note = truncationNote(digest);
  if (note) lines.push(`<i>${escapeTelegramHtml(note)}</i>`, '');
  if (links) {
    lines.push(
      `<a href="${escapeTelegramHtml(links.manage)}">Mute one of these, or pause everything</a>`,
    );
  }

  return lines.join('\n').trim();
}
