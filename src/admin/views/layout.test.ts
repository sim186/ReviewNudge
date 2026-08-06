import { describe, expect, it } from 'vitest';
import { esc, html, page, raw, relativeTime, SafeHtml } from './layout.js';

describe('html', () => {
  it('escapes interpolated values', () => {
    const out = html`<p>${'<script>alert(1)</script>'}</p>`.toString();
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('inserts a nested fragment as markup, not escaped text', () => {
    const inner = html`<span>hi</span>`;
    expect(html`<p>${inner}</p>`.toString()).toBe('<p><span>hi</span></p>');
  });

  it('inserts an array of fragments as markup', () => {
    // The bug this guards: `${rows.map((r) => html`<tr>…`)}` used to escape every row,
    // rendering visible tag soup instead of a table.
    const rows = ['a', 'b'].map((v) => html`<tr><td>${v}</td></tr>`);
    expect(html`<table>${rows}</table>`.toString()).toBe(
      '<table><tr><td>a</td></tr><tr><td>b</td></tr></table>',
    );
  });

  it('still escapes an array of plain strings', () => {
    expect(html`<p>${['<b>', '&']}</p>`.toString()).toBe('<p>&lt;b&gt;&amp;</p>');
  });

  it('renders null, undefined and false as nothing', () => {
    expect(html`<p>${null}${undefined}${false}</p>`.toString()).toBe('<p></p>');
    // Zero is a real value and must survive.
    expect(html`<p>${0}</p>`.toString()).toBe('<p>0</p>');
  });

  it('survives nesting several levels deep', () => {
    const leaf = html`<em>${'<x>'}</em>`;
    const mid = html`<span>${leaf}</span>`;
    expect(html`<p>${mid}</p>`.toString()).toBe('<p><span><em>&lt;x&gt;</em></span></p>');
  });

  it('returns SafeHtml so callers cannot confuse it with an escaped string', () => {
    expect(html`<p></p>`).toBeInstanceOf(SafeHtml);
  });
});

describe('raw', () => {
  it('marks a plain string as trusted markup', () => {
    expect(html`<p>${raw('<b>bold</b>')}</p>`.toString()).toBe('<p><b>bold</b></p>');
  });

  it('is idempotent, so double-wrapping does not double-escape', () => {
    const once = raw('<b>x</b>');
    expect(raw(once)).toBe(once);
    expect(html`${raw(raw('<b>x</b>'))}`.toString()).toBe('<b>x</b>');
  });
});

describe('page', () => {
  it('emits the body as markup and escapes the title', () => {
    const out = page({ title: '<evil>', active: '/' }, html`<div class="card">hello</div>`);
    expect(out).toContain('<div class="card">hello</div>');
    expect(out).toContain('&lt;evil&gt;');
    expect(out).not.toContain('[object Object]');
  });

  it('marks the active navigation item', () => {
    const out = page({ title: 'Pending', active: '/pending' }, html`<p></p>`);
    expect(out).toContain('href="/pending" class="nav-link active"');
    expect(out).toContain('href="/" class="nav-link"');
  });

  it('shows the paused banner and escapes a flash message', () => {
    const out = page(
      { title: 'x', active: '/', paused: true, flash: { kind: 'error', message: '<bad>' } },
      html`<p></p>`,
    );
    expect(out).toContain('Notifications are paused');
    expect(out).toContain('&lt;bad&gt;');
    expect(out).toContain('banner error');
  });

  it('omits both banners when there is nothing to say', () => {
    const out = page({ title: 'x', active: '/' }, html`<p></p>`);
    expect(out).not.toContain('class="banner');
  });
});

describe('esc and relativeTime', () => {
  it('escapes the five significant characters', () => {
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('describes recent times in words', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime('2026-08-10T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-08-10T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-08-10T06:00:00Z', now)).toBe('6h ago');
    expect(relativeTime('2026-08-09T12:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-08-01T12:00:00Z', now)).toBe('9 days ago');
  });

  it('accepts the SQLite datetime format', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    expect(relativeTime('2026-08-10 11:30:00', now)).toBe('30 min ago');
  });

  it('returns an unparseable value unchanged, for escaping at the call site', () => {
    expect(relativeTime('not a date')).toBe('not a date');
  });
});
