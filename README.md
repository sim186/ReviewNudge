# ReviewNudge

Tells people which merge requests on your self-hosted GitLab are waiting for **them** — as
reviewer, assignee, or thread participant — as one digest per person, by email, Microsoft
Teams, Slack, or Telegram.

GitLab's own to-do list is easy to ignore and its notification emails arrive per event, so
they get filtered away. This sends one message a day that says exactly what is blocked on
you and for how long.

- **Runs anywhere** — from a laptop, as a Docker container, or as a one-shot job under
  cron, a systemd timer, or a Kubernetes CronJob.
- **Works on GitLab Free.** It uses the GraphQL API, because the REST approvals endpoint is
  Premium/Ultimate only.
- **Has an admin panel** for the day-to-day knobs: pause, snooze, exclusions, and an
  append-only audit log — no SSH-and-edit-YAML.

---

## Contents

- [How it decides who is blocking](#how-it-decides-who-is-blocking)
- [Warnings](#warnings)
- [Quick start](#quick-start)
- [Token permissions](#token-permissions)
- [Docker](#docker)
- [Configuration](#configuration)
- [Silencing](#silencing)
- [The admin panel](#the-admin-panel)
- [Notification channels](#notification-channels)
- [Setting up the Teams workflow](#setting-up-the-teams-workflow)
- [Commands](#commands)
- [Running as a scheduled job instead](#running-as-a-scheduled-job-instead)
- [Upgrading from MergeRequestAlarm](#upgrading-from-mergerequestalarm)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## How it decides who is blocking

For every open, non-draft merge request in the configured groups, three rules run. Each can
be switched off independently.

| Rule | Someone is notified when |
| --- | --- |
| **Reviewer has not approved** | They are a reviewer, are not in `approvedBy`, and their review state is `UNREVIEWED`, `REVIEW_STARTED`, or `UNAPPROVED`. |
| **Assignee has something to do** | They are an assignee and either a reviewer requested changes, or the merge request is fully approved and nobody merged it, or there are unresolved threads they did not open. |
| **Unresolved threads** | They opened a thread that is still unresolved and somebody else had the last word, or they were @-mentioned and have not replied since. |

Two deliberate refinements:

- A reviewer who has already **commented or requested changes** is *not* chased. The ball
  is with the author until new commits land — and then the reviewer is chased again, with
  the wait measured from that push.
- **`require_activity_since_push`** (on by default) drops anyone who has already acted since
  the most recent push, so people are not nagged about work they have just done.

Merge requests younger than `min_age_hours` are ignored, so nothing fires minutes after an
MR is opened. Several reasons against the same merge request collapse into one row, and
each row shows how long it has been waiting.

## Warnings

The three rules above answer "who is blocking this?". Warnings answer a different
question — "is this merge request set up properly?" — and they are about the merge
request, not about a person.

| Warning | Raised when | Default |
| --- | --- | --- |
| **No reviewer** | The merge request is not a draft and has no reviewer anyone could be waiting on | on |
| **No issue key** | Neither the title nor the description matches `ticket_pattern` | off |

Because a warning is not a demand on the reader, it does **not** produce a message of its
own. It renders as a small box on the rows people already receive, so a reviewer who is
being chased about an MR also learns that it has no ticket — without a second email
arriving to say so.

**Bots do not count as reviewers.** A merge request whose only reviewer is a service
account still reads as unattended, which is usually what you want.

**Drafts are never warned about.** An unfinished merge request is expected to have no
reviewer and no ticket yet, and saying so every morning is exactly the noise this tool
exists to remove.

### The unattended merge request

There is one case the three rules cannot see. An open merge request with no reviewer, no
assignee, no unresolved threads and no approvals produces no reasons for anybody, so it
appears in nobody's digest and sits there indefinitely.

`notify_author_of_warnings` (on by default) closes that hole: when a merge request
produces **no reasons at all**, its warnings go to the author. When somebody *is* on the
hook, their row already carries the warnings and the author is left alone — so this never
turns into a second notification about the same merge request.

```yaml
rules:
  warn_missing_reviewer: true
  warn_missing_ticket: false
  ticket_pattern: '[A-Z][A-Z0-9]+-\d+'   # case-insensitive; matches PROJ-1234
  notify_author_of_warnings: true
```

`ticket_pattern` is an ordinary regular expression, so it is not Jira-specific — `#\d+`
matches GitHub-style issue references, and anything else you use will have a pattern too.
A pattern that does not compile is rejected when `config.yaml` loads and when the panel
saves it; one that somehow reaches a run anyway disables the check rather than failing it.

> Switching `warn_missing_ticket` on makes each scan fetch merge request **descriptions**,
> which are by far the largest field on the query. Nothing else reads them, so they are
> left out entirely while the check is off.

## Quick start

Requires Node.js 22 or newer.

```bash
git clone <this repo> && cd review-nudge
npm ci

cp .env.example .env                               # fill in GITLAB_TOKEN and NUDGE_ADMIN_PASSWORD
cp config/config.example.yaml config/config.yaml   # set your URL and groups

npm run build
node dist/cli.js check-config --remote     # validates config and talks to GitLab
node dist/cli.js run --once --dry-run      # prints what it would send, sends nothing
```

Once the dry run looks right:

```bash
npm start        # scheduler + admin panel on http://127.0.0.1:8080
```

**The GitLab token** needs the `read_api` scope only. See
[Token permissions](#token-permissions) for the role that user also needs.

## Token permissions

Every credential here is deliberately narrow. Nothing needs admin rights on any system.

| Token | Permission | Why no more |
| --- | --- | --- |
| **GitLab** personal access token | `read_api` scope | Only reads merge requests, reviewers and discussions. It never writes to GitLab |
| **Slack** bot token (`xoxb-…`) | `chat:write` bot scope | Only posts messages. Needs no read scopes and no channel invitation to send direct messages |
| **Telegram** bot token | *not scoped* | Telegram tokens grant full control of that bot; treat the token as the secret it is |
| **SMTP** credentials | Whatever your relay requires to send | Only sends mail |

### The GitLab role, not just the scope

The scope decides *what kind* of API calls are allowed; the token user's **role on each
project** decides what they can actually see. Getting this wrong is quiet — scans simply
come back empty rather than failing — so it is worth being exact.

| Project visibility | Minimum role for the token's user |
| --- | --- |
| **Private** | **Reporter** — the Guest role cannot view merge requests on private projects |
| Internal | Guest is enough |
| Public | Guest is enough |

Most self-hosted projects are private, so **Reporter is the safe answer**. One extra
wrinkle: a user flagged as an [external user](https://docs.gitlab.com/user/permissions/)
needs at least Reporter granted explicitly, *even on internal projects*.

Add the token's user to each group under `gitlab.groups` at Reporter, or use a group
access token with the Reporter role, and it will see everything it needs across the
subgroups beneath.

**No admin token is required.** That is a deliberate design consequence: recipient
addresses come from your configuration rather than from GitLab's users API, which is the
only thing that would have needed an admin credential.

## Docker

```bash
cp .env.example .env                       # required; compose reads it
cp config/config.example.yaml config/config.yaml
docker compose up --build
```

The panel is published to `127.0.0.1:8080` only; put a reverse proxy in front of it to
expose it further. `config.yaml` is mounted read-only — the application never writes it —
and the SQLite database lives in the `nudge-data` volume, which must persist.

Set `NUDGE_DRY_RUN=1` in `.env` for the first run to scan and record without delivering.

> The image has not been built in this environment (no Docker daemon available), so the
> `Dockerfile` and `compose.yaml` are unverified beyond `docker compose config`. Everything
> else in this README has been exercised end to end.

## Configuration

Configuration lives in two places, and the split matters:

| | `config/config.yaml` | SQLite (`data/nudge.db`) |
| --- | --- | --- |
| Holds | infrastructure and secrets: GitLab URL and token, SMTP, Teams URL, admin password | operator changes: exclusions, recipients, snoozes, the pause switch, quiet hours, rule toggles |
| Written by | you | the admin panel |
| Also holds | defaults for everything in the right-hand column | run history, the last scan, the audit log |

Database values win over file values, per key. The file is **never** written by the
application, so secrets never reach the database or the panel — the Settings page shows
them redacted. Anything you changed in the panel can be reverted with **Reset all
overrides**.

`${VAR}` in the YAML reads an environment variable; `${VAR:-fallback}` supplies a default.
Interpolation happens *after* the YAML is parsed, so a secret containing `:` or `#` cannot
corrupt the document.

See [`config/config.example.yaml`](config/config.example.yaml) for the fully commented
reference. The essentials:

```yaml
gitlab:
  url: https://gitlab.example.com
  token: ${GITLAB_TOKEN}                 # read_api scope
  groups: [engineering, platform/infra]  # scanned recursively, subgroups included

schedule:
  cron: '0 9 * * 1-5'                    # 09:00, Monday to Friday
  timezone: Europe/Zurich

notifications:
  channels: [email, teams]

recipients:
  - gitlab_username: alice
    email: alice@example.com
    teams_upn: alice@example.com
```

Recipients in the file are copied into the database on first start only, so the file
populates a fresh deployment but never clobbers later panel edits. People who show up on
merge requests but have no mapping are skipped, logged, and listed at the top of the
panel's Recipients page.

### Exclusions

`exclude.projects` and `exclude.users` accept globs: `*` matches one path segment, `**`
matches any depth. A trailing `/**` also matches the prefix itself, so `sandbox/**` covers
the `sandbox` group *and* everything beneath it. `exclude.bots: true` skips GitLab bot
accounts and conventionally named ones such as `renovate-bot`.

## Silencing

Five independent mechanisms, applied in this order:

| # | Mechanism | Effect | Still scans? |
| --- | --- | --- | --- |
| 1 | **Global pause** (`silence.enabled`, the panel toggle, or `NUDGE_SILENCE=1`) | Nothing is delivered to anyone | **Yes** — so Pending stays accurate and the audit log records what was withheld |
| 2 | **Holiday**, then **non-working day**, then **quiet hours** | The whole run is skipped | No |
| 3 | **Per-recipient snooze** (`snooze_until`, or the recipient pausing themselves) | That person's digest is dropped | Yes |
| 4 | **Personal mutes** set by a recipient | That merge request is dropped from *that person's* digest only | Yes |
| 5 | **Muted merge requests** and **excluded labels** set by an admin | Those merge requests never enter *anyone's* digest | Yes |

Levels 4 and 5 are deliberately distinct. A recipient going quiet about a merge request
must never silence it for their colleagues; only an administrator can do that.

Quiet hours may wrap midnight (`18:00` → `08:00`) and are evaluated in
`schedule.timezone`, so they follow wall-clock time across daylight-saving changes. Setting
start equal to end is treated as *no* restriction rather than an all-day blackout, so a
half-finished edit cannot silently stop every notification.

A snooze runs to the *start* of its date: snoozed until `2026-09-01` means quiet through 31
August, and a digest again on 1 September.

`NUDGE_SILENCE=1` can force silence **on** but never off, so it cannot quietly defeat the
panel toggle.

## Muting things yourself

Recipients do not need the admin panel, or an account, to quieten their own reminders.
Every digest carries a **Mute this one** link per merge request and a **Mute one of these,
or pause everything** link at the bottom.

- **Mute one merge request** — until something changes (new commits or comments), for 1
  day, 3 days, 1 week or 2 weeks, until a date you pick, or permanently.
- **Pause everything** — for a period or until a date, for when you are away. There is no
  indefinite option on purpose: a pause that never ends is how people quietly stop hearing
  about work forever.
- **Undo** — the "your notifications" page lists everything you have muted, with an
  un-mute button, and shows when each mute lapses.

Clicking a mute link opens a confirmation page; the mute only happens when you press the
button. That matters because mail scanners such as Outlook Safe Links follow links
automatically, and a one-click GET would let them mute things on your behalf.

Personal mutes affect **you alone**. Your colleagues keep getting their own reminders, the
merge request is untouched in GitLab, and the item still appears on the admin Pending page
flagged as *muted by recipient*, so nothing silently disappears. Every mute, un-mute and
self-service pause lands in the audit log with the actor `recipient`.

### Setting it up

Two things must be true for the links to appear:

1. **A stable signing secret.** Set `NUDGE_SESSION_SECRET` (or `admin.session_secret`). The
   links are signed with it; without one, digests go out with no links rather than links
   that break on the next restart. Rotating the secret invalidates every outstanding link,
   which is how you revoke them.
2. **An address recipients can reach.** Links are built from `admin.host` and `admin.port`.
   With the default `127.0.0.1` binding they would point at the recipient's own machine, so
   no links are emitted and a warning is logged. Set `admin.host` to the hostname people
   will actually use.

A recipient token grants exactly three things — mute, un-mute, and pause yourself — for one
person. It never reaches the admin panel, which keeps its own password.

> Because links come from `admin.host`, that one value is both the bind address and the
> public hostname. If you need to bind to `0.0.0.0` while linking to a real hostname (in
> Docker, for instance), that combination is not currently expressible; a separate
> `public_url` setting would be a small addition.

## The admin panel

`npm start` serves it on `http://127.0.0.1:8080`. One shared password
(`NUDGE_ADMIN_PASSWORD`, minimum 8 characters) gates a login form that sets a signed,
httpOnly session cookie. Set `NUDGE_SESSION_SECRET` to a random 32-byte hex string so
sessions survive a restart:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

It binds to loopback by default, so exposing it is a deliberate act — put a reverse proxy
in front, or set `NUDGE_ADMIN_HOST`.

| Page | What it is for |
| --- | --- |
| **Dashboard** | Last run, next run, current silence state; pause toggle; **Run now** and **Run now (dry run)** |
| **Pending** | Who is waiting on what, from the last scan, with reason chips and age. One-click **Mute** per merge request |
| **Recipients** | Map GitLab usernames to addresses. Unmapped people who are blocking work are listed first, with a prefilled form |
| **Exclusions** | Add or remove project globs, users, labels, and muted merge requests. Entries from `config.yaml` are shown but can only be changed there |
| **Silence** | Quiet hours, working days, holidays, and the precedence order |
| **Audit** | Every configuration change and delivery attempt, append-only, filterable by actor, action, and date |
| **Settings** | Schedule, rule toggles, thresholds, warning checks and the issue key pattern; `config.yaml` values shown read-only and redacted |

Every mutating action follows the same path — validate, write, record an audit row,
redirect — so no configuration change escapes the audit log, and each row carries the
before and after values.

## Notification channels

Four are built in. Every channel sends **one message per person**, containing only that
person's merge requests.

| Channel | Delivers as | Needs | Per-person identifier |
| --- | --- | --- | --- |
| **Email** | HTML mail with a plaintext alternative | SMTP host, and credentials if your relay wants them | Email address |
| **Teams** | Adaptive Card via a Power Automate flow | One workflow URL | UPN, which your flow routes on |
| **Slack** | Block Kit message, delivered as a DM from the bot | Bot token (`xoxb-…`) with `chat:write` | Member ID (`U…`) |
| **Telegram** | HTML message from your bot | Bot token from @BotFather | Numeric chat ID |

Switch a channel on by adding it to `notifications.channels` and filling in its config
section. A person is only sent on a channel they have an address for, so a half-filled
recipient silently narrows rather than erroring — the admin panel shows which addresses
are missing.

### Slack

Uses `chat.postMessage` with a **bot token**, not an incoming webhook. Webhooks are bound
to a single channel and cannot open a direct message; posting with a member ID as the
`channel` opens the bot's DM with that person, which is what a personal digest wants.

1. Create a Slack app, add the **`chat:write`** bot scope, install it to the workspace.
2. Put the bot token (`xoxb-…`) in `SLACK_BOT_TOKEN`.
3. For each person, copy their **member ID** from their Slack profile → *More* →
   *Copy member ID*. It looks like `U012ABCDEF` — the `@handle` will not work.

The bot does not need to be invited to any channel to send direct messages.

### Telegram

Telegram bots **cannot start a conversation**. Each person must message the bot once
before a chat ID exists for them — that is the one bit of setup you cannot do centrally.

1. Create a bot with [@BotFather](https://t.me/BotFather), put the token in
   `TELEGRAM_BOT_TOKEN`.
2. Ask each person to send the bot any message.
3. Read their chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates` and put it in
   their recipient entry.

Messages use HTML rather than MarkdownV2, because MarkdownV2 requires escaping a long list
of characters that appear constantly in merge request titles, and a single missed escape
rejects the whole message. Anything over Telegram's 4096-character limit is cut on a line
boundary with a note.

### Adding another channel

Channel-specific behaviour lives in two files: `src/notify/channels.ts` (address field,
label, form metadata) and `src/notify/factory.ts` (how to build the notifier). Add an entry
to each, a `Notifier` implementation, and a renderer in `src/notify/render.ts`. The
recipients page, the address resolution, the dry-run printer and the config validation are
all driven from that registry, so they need no edit.

## Setting up the Teams workflow

Office 365 connectors (the old `outlook.office.com/webhook` incoming webhooks) were retired
on **30 April 2026** and no longer work. Use Power Automate.

### Does each person get a private message?

**The content is already per-person; where it lands is decided by your flow.**

ReviewNudge sends **one HTTP POST per recipient**, each containing only that person's
merge requests and their own identity. If five people are blocking work, that is five
separate POSTs to the same workflow URL. Nothing is broadcast, and nobody's payload
contains anybody else's list. A recipient with no `teams_upn` is skipped rather than
posted somewhere unroutable.

What ReviewNudge cannot do is decide whether that becomes a direct message or a
channel post — that is the action you choose inside the flow. Both are supported by the
same payload:

| You want | Configure the flow's **Post card in a chat or channel** action as |
| --- | --- |
| **A private message to each person** (recommended) | *Post as*: **Flow bot** · *Post in*: **Chat with Flow bot** · *Recipient*: the payload's `targetUpn` |
| **One channel post, @-mentioning the person** | *Post as*: Flow bot · *Post in*: **Channel** · pick the channel, and use `targetUpn` to build the mention |

The private-message route is the one that matches how these digests are built: each is a
personal to-do list, and posting them all into a shared channel means everyone reads
everyone else's.

### Building the flow

1. In Teams, open the channel menu → **Workflows** → **Create a new flow**.
2. Start from the **"When a Teams webhook request is received"** trigger.
3. Add **Post card in a chat or channel** and fill it in per the table above. The two
   expressions you need are:
   - Recipient — `triggerBody()?['targetUpn']`
   - Adaptive Card — `triggerBody()?['card']`
4. Save, copy the generated `https://…logic.azure.com/workflows/…` URL, and put it in
   `TEAMS_WORKFLOW_URL`.

### The payload

One URL serves everyone. Each POST is an Adaptive Card 1.4, sent both in the Workflows
envelope and as a top-level `card` field — the two are the same object, and `card` exists
purely because it is far easier to reference in a Power Automate expression than
`attachments[0].content`. Use whichever your flow finds convenient.

```json
{
  "type": "message",
  "targetUpn": "alice@example.com",
  "gitlabUsername": "alice",
  "itemCount": 3,
  "card": { "type": "AdaptiveCard", "version": "1.4", "body": [] },
  "attachments": [
    { "contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": null, "content": {} }
  ]
}
```

| Field | Use |
| --- | --- |
| `targetUpn` | Who this digest is for. Route the direct message, or build the @-mention |
| `gitlabUsername` | The same person's GitLab handle, for logging or branching |
| `itemCount` | How many merge requests are waiting, before the display cap |
| `card` | The Adaptive Card. Identical to `attachments[0].content` |

Cards are capped at six link buttons and shed rows if they would exceed the Teams size
limit — the heading always reports the true total. When self-service links are enabled,
each row also carries a **Mute this one** link and the card gains a **Mute or pause…**
button.

Check it works with `node dist/cli.js test-notify --recipient alice`.

> **Not verified against a live tenant.** The `TeamsNotifier` is covered by tests against a
> stubbed endpoint, so the request shape, timeouts and error handling are known-good, but
> no Microsoft tenant was available to confirm that a direct message actually arrives. The
> flow recipe above follows Microsoft's documentation. Run `test-notify` once before
> relying on it.

## Commands

| Command | What it does |
| --- | --- |
| `nudge serve` | Scheduler plus admin panel. The default for `npm start` and the container |
| `nudge run --once` | One cycle now. `--dry-run` prints instead of delivering |
| `nudge check-config` | Validates the config file offline. `--remote` also contacts GitLab and reads each group |
| `nudge test-notify --recipient <user>` | Sends one sample digest over every configured channel |

Common flags: `-c, --config <path>`, `--dry-run`.

Environment: `NUDGE_CONFIG`, `NUDGE_DATA_DIR`, `NUDGE_DRY_RUN`, `NUDGE_SILENCE`,
`NUDGE_ADMIN_HOST`, `NUDGE_ADMIN_PASSWORD`, `NUDGE_SESSION_SECRET`, `LOG_LEVEL`, `LOG_FORMAT`.

The pre-rename `MRA_*` names are still read as a fallback — see
[Upgrading from MergeRequestAlarm](#upgrading-from-mergerequestalarm).

## Running as a scheduled job instead

`run --once` is a clean one-shot, so you can skip the built-in scheduler entirely. Set
`admin.enabled: false` and drive it externally:

```cron
0 9 * * 1-5  cd /opt/review-nudge && node dist/cli.js run --once >> /var/log/nudge.log 2>&1
```

Or as a Kubernetes CronJob using the same image with `args: ["run", "--once"]`. The exit
code is non-zero when every delivery failed, so your scheduler can alert on it. The SQLite
database still needs to persist between runs.

## Upgrading from MergeRequestAlarm

The project used to be called MergeRequestAlarm and its environment variables were prefixed
`MRA_`. Nothing you already have breaks: `MRA_*` is still read wherever `NUDGE_*` is, and
`NUDGE_*` wins if both are set. Startup logs a warning listing any old names it finds, so
you can see at a glance what is left to rename.

Two things do need a look:

**The database file.** It is now `data/nudge.db`. If only `data/mra.db` exists, that file is
opened as-is — an upgrade never silently starts from an empty database. Rename it at your
leisure while the service is stopped, taking the `-wal` and `-shm` files with it:

```bash
cd data && for f in mra.db*; do mv "$f" "nudge.db${f#mra.db}"; done
```

**The Compose volume.** `compose.yaml` now declares `nudge-data` where it declared
`mra-data`. Compose would treat that as a brand-new empty volume, so either keep the old
name in your own file, or move the data across before the first `docker compose up`:

```bash
docker compose down
docker volume create <project>_nudge-data
docker run --rm -v <project>_mra-data:/from -v <project>_nudge-data:/to alpine \
  sh -c 'cp -a /from/. /to/'
```

`<project>` is the Compose project name — the directory name unless you set one.

The admin session cookie was also renamed, so everyone logged into the panel is asked to log
in once more. Config files are untouched: `${MRA_ADMIN_PASSWORD}` in your own `config.yaml`
names your own variable and keeps working, whatever you call it.

## Troubleshooting

**"GitLab rejected the token (HTTP 401)"** — the token is wrong or expired. It needs the
`read_api` scope; see [Token permissions](#token-permissions).

**Scans come back empty, or a project is silently missing.** Usually the token's user has
the Guest role on a private project, which cannot view merge requests at all. Reporter is
the minimum there — see [Token permissions](#token-permissions). `check-config --remote`
reports the open merge request count per group, which makes this visible quickly.

**"group X was not found, or the token cannot see it"** — check the path is the full group
path (`platform/infra`, not `infra`) and that the token's user is a member.

**Someone is not getting notified.** Check, in order: are they on the Pending page at all?
If they appear with a red badge, the reason is on the badge (no mapping, snoozed, disabled,
no channel). If they are absent entirely, the merge request is probably excluded — a draft,
too new, an excluded project or label, muted — or they have already acted since the last
push.

**Everyone stopped getting notified.** Check the Dashboard for the pause banner, then the
Silence page. Remember quiet hours are evaluated in `schedule.timezone`, not UTC.

**"Query has complexity of N, which exceeds max complexity"** — lower `gitlab.page_size`.

**Reviewer states look wrong on an older GitLab.** `reviewState` arrived in GitLab 17.0. On
older instances the client detects this, logs a warning, and falls back to `approvedBy`
membership. `commits(last: 1)` degrades the same way, using `updatedAt` as the push time.

**Teams returns HTTP 400.** The flow is not using the "When a Teams webhook request is
received" trigger, or the card action is not reading the posted payload. Retry with
`test-notify` after fixing the flow.

## Development

```bash
npm test          # 337 tests
npm run typecheck
npm run lint
npm run dev       # tsx watch, serve mode
```

Tests use Vitest. The rule engine (`src/domain/reasons.ts`) is the product, so it carries
the heaviest coverage; `src/admin/server.test.ts` drives the panel through Fastify's
`inject`, and `src/run.test.ts` covers orchestration with a stubbed GitLab.

```
src/
  config/    schema, YAML loading, file-plus-database merge
  db/        SQLite schema, repository, audit log
  gitlab/    GraphQL client and queries
  domain/    filters, the rule engine, digest building, silencing
  notify/    rendering, email, Teams, Slack, Telegram, console
  admin/     Fastify server, auth, pages
  run.ts     one full cycle
  scheduler.ts  cron loop
  cli.ts     commands
```
