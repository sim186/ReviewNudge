import { esc, html, raw, type SafeHtml } from './layout.js';

/**
 * Pages a recipient sees. Deliberately separate from the admin layout: no navigation,
 * no sign-out, nothing that hints at an admin panel behind the same host.
 */
export function recipientPage(title: string, body: SafeHtml | string): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>${title} · MergeRequestAlarm</title>
        <link rel="stylesheet" href="/static/style.css" />
      </head>
      <body>
        <header class="topbar">
          <div class="brand">MergeRequestAlarm</div>
        </header>
        <main class="narrow">${raw(body)}</main>
      </body>
    </html>`.toString();
}

export function expiredLinkPage(): string {
  return recipientPage(
    'Link no longer valid',
    html`<div class="card">
      <h2>This link no longer works</h2>
      <p class="hint">
        It was either mistyped, or the server's signing secret has been rotated, which
        invalidates every link sent before the change. The next digest you receive will
        contain fresh links.
      </p>
    </div>`,
  );
}

export function disabledPage(): string {
  return recipientPage(
    'Not available',
    html`<div class="card">
      <h2>Self-service is switched off</h2>
      <p class="hint">
        Ask whoever runs MergeRequestAlarm to set a stable admin session secret; without one,
        these links cannot be signed. In the meantime they can mute merge requests for you in
        the admin panel.
      </p>
    </div>`,
  );
}

/** Escaped inline so the confirmation copy can quote a merge request title safely. */
export function quoted(value: string): string {
  return esc(value);
}
