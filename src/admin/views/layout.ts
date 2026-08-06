/** Minimal server-rendered views: tagged templates, no engine, no client framework. */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Interpolates with escaping; wrap a value in `raw()` to opt out. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, str, i) => {
    if (i === 0) return str;
    const value = values[i - 1];
    const rendered = Array.isArray(value)
      ? value.map((v) => (isRaw(v) ? v.value : esc(v))).join('')
      : isRaw(value)
        ? value.value
        : esc(value);
    return out + rendered + str;
  }, '');
}

interface Raw {
  __raw: true;
  value: string;
}

export function raw(value: string): Raw {
  return { __raw: true, value };
}

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && (value as Raw).__raw === true;
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

export function page(options: PageOptions, body: string): string {
  const nav = NAV.map(
    (item) =>
      html`<a href="${item.href}" class="${item.href === options.active ? 'nav-link active' : 'nav-link'}"
        >${item.label}</a
      >`,
  ).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(options.title)} · MergeRequestAlarm</title>
    <link rel="stylesheet" href="/static/style.css" />
  </head>
  <body>
    <header class="topbar">
      <div class="brand">MergeRequestAlarm</div>
      <nav>${nav}</nav>
      <form method="post" action="/logout" class="logout"><button type="submit">Sign out</button></form>
    </header>
    ${options.paused ? '<div class="banner warn">Notifications are paused — scans still run, nothing is delivered.</div>' : ''}
    ${
      options.flash
        ? html`<div class="banner ${options.flash.kind === 'ok' ? 'ok' : 'error'}">${options.flash.message}</div>`
        : ''
    }
    <main>${body}</main>
  </body>
</html>`;
}

export function loginPage(error?: string): string {
  return `<!doctype html>
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
      ${error ? html`<div class="banner error">${error}</div>` : ''}
      <label for="password">Admin password</label>
      <input id="password" type="password" name="password" autocomplete="current-password" autofocus required />
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>`;
}

/** Relative time such as "3 days ago", for run timestamps and audit rows. */
export function relativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed)) return esc(iso);

  const seconds = Math.round((now.getTime() - parsed) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
