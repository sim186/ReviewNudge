/** Minimal server-rendered views: tagged templates, no engine, no client framework. */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Markup that is already safe to emit.
 *
 * `html` returns one of these rather than a plain string so that nesting works: a
 * fragment interpolated into another template — including one inside an array from
 * `.map()` — is inserted as markup, while anything else is escaped. Without the
 * distinction a nested fragment would be escaped and render as visible tag soup.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Marks a string as trusted markup. Accepts SafeHtml so it is safe to apply twice. */
export function raw(value: string | SafeHtml): SafeHtml {
  return value instanceof SafeHtml ? value : new SafeHtml(value);
}

function interpolate(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += interpolate(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

export interface NavItem {
  href: string;
  label: string;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/pending', label: 'Pending' },
  { href: '/recipients', label: 'Recipients' },
  { href: '/exclusions', label: 'Exclusions' },
  { href: '/silence', label: 'Silence' },
  { href: '/audit', label: 'Audit' },
  { href: '/settings', label: 'Settings' },
];

export interface PageOptions {
  title: string;
  active: string;
  flash?: { kind: 'ok' | 'error'; message: string } | null;
  paused?: boolean;
}

export function page(options: PageOptions, body: string | SafeHtml): string {
  const nav = NAV.map(
    (item) =>
      html`<a href="${item.href}" class="${item.href === options.active ? 'nav-link active' : 'nav-link'}"
        >${item.label}</a
      >`,
  );

  const banners = [
    options.paused
      ? html`<div class="banner warn">
          Notifications are paused — scans still run, nothing is delivered.
        </div>`
      : null,
    options.flash
      ? html`<div class="banner ${options.flash.kind === 'ok' ? 'ok' : 'error'}">
          ${options.flash.message}
        </div>`
      : null,
  ];

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${options.title} · MergeRequestAlarm</title>
        <link rel="stylesheet" href="/static/style.css" />
      </head>
      <body>
        <header class="topbar">
          <div class="brand">MergeRequestAlarm</div>
          <nav>${nav}</nav>
          <form method="post" action="/logout" class="logout">
            <button type="submit">Sign out</button>
          </form>
        </header>
        ${banners}
        <main>${raw(body)}</main>
      </body>
    </html>`.toString();
}

export function loginPage(error?: string): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Sign in · MergeRequestAlarm</title>
        <link rel="stylesheet" href="/static/style.css" />
      </head>
      <body class="centered">
        <form method="post" action="/login" class="card login">
          <h1>MergeRequestAlarm</h1>
          ${error ? html`<div class="banner error">${error}</div>` : null}
          <label for="password">Admin password</label>
          <input
            id="password"
            type="password"
            name="password"
            autocomplete="current-password"
            autofocus
            required
          />
          <button type="submit">Sign in</button>
        </form>
      </body>
    </html>`.toString();
}

/** Relative time such as "3 days ago", for run timestamps and audit rows. */
export function relativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  // Returned as plain text; escaping happens wherever it is interpolated.
  if (!Number.isFinite(parsed)) return iso;

  const seconds = Math.round((now.getTime() - parsed) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
