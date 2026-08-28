# Changelog

## What a version number means here

Nothing imports this project, so semver's promise about a public API does not apply. The
surface that can actually break an installation is **`config.yaml` and the SQLite
database**, and that is what these numbers describe:

| Bump | Means |
| --- | --- |
| **Major** | A config key was renamed or removed, or the database needs a step the application cannot take by itself. Upgrading needs you to do something |
| **Minor** | New rules, channels, panel pages, or config keys. Existing configuration keeps working untouched |
| **Patch** | Fixes and wording only |

While the number starts with `0.`, the config surface is still settling — read the notes
before upgrading rather than assuming a minor bump is free.

The database upgrades itself in place. `schema.sql` is written with `IF NOT EXISTS`
throughout and missing columns are added on startup, so moving between versions is a
matter of pulling and restarting. There is no downgrade path: an older build will ignore
columns and settings it does not know about rather than removing them.

---

## 0.2.1 — 2026-08-28

### Added

- **Every digest footer now invites feedback**, pointing at the GitHub issue tracker in
  all five channels. Recipients never chose to be nudged and mostly have no idea who to
  tell when it gets something wrong; this gives them somewhere to go. The address comes
  from `bugs.url` in package.json, so a fork changes it in one place.

### Fixed

- **Waiting time is counted from when a merge request left draft, not from when it was
  opened.** A merge request that sat as a draft for ten days and went ready two days ago
  told its reviewer they had kept people waiting for twelve, and crossed the seven-day
  urgent threshold on the strength of days nobody was waiting. The same anchor now
  applies to `min_age_hours`: since drafts are skipped, a creation-dated age let one go
  ready and land in the very next digest, straight past the quiet window the setting
  exists to provide. GitLab publishes no "left draft at" timestamp, so the transition is
  read from the system notes; a merge request that was never a draft, or whose ready note
  has aged out of the notes window, still counts from creation as before.
- **Digest email now says who sent it.** A `from` configured as a bare address left the
  sender name to the mail client, which shows the relay mailbox — recipients of the
  deployed instance saw "gitlab@topseven.cloud" and nothing identifying ReviewNudge. A
  `from` without a display name is now sent as `ReviewNudge <address>`; one that already
  has a display name is left exactly as the operator wrote it.
- **The recipients page no longer accepts delivery settings it will silently ignore.**
  Filling in a Telegram chat ID and selecting the channel saved cleanly, sent nothing and
  logged nothing, because a channel missing from `notifications.channels` is dropped
  before any notifier is consulted. Such channels are now marked `(off)` in the channel
  picker, and a recipient configured on one carries a warning chip.

### Notes

- Nothing to do when upgrading from 0.2.0. Deployments whose `email.from` is a bare
  address will start sending as `ReviewNudge <address>`; set a display name explicitly to
  override it.

---

## 0.2.0 — 2026-08-21

### Added

- **Email fallback via GitLab's public email.** When a username has no explicit recipient
  entry, the address is now looked up from GitLab (`users(usernames: …) → publicEmail`)
  before falling back to the `{username}@{domain}` guess. Usernames and email local parts
  do not always match ("lukaskoch" vs lukas.koch@…), which silently sent digests to a
  wrong address that SMTP accepted anyway — so nothing ever looked broken. The lookup
  only runs for unmapped usernames, costs one batched request per scan, and degrades to
  partial results if GitLab cannot answer; `nudge test-notify` uses the same fallback.
- **Warnings**: a second class of finding, describing the merge request rather than a
  person. Raised when a non-draft merge request has no reviewer, or when neither its
  title nor its description mentions an issue key. Warnings do not send messages of their
  own — they render as a box on rows people already receive.
- **Unattended merge requests reach their author.** A merge request with no reviewer, no
  assignee and no unresolved threads previously produced no reasons for anybody and
  appeared in nobody's digest. `rules.notify_author_of_warnings` (on by default) sends its
  warnings to the author instead.
- New rule keys: `warn_missing_reviewer`, `warn_missing_ticket`, `ticket_pattern`,
  `notify_author_of_warnings`, all editable in the panel under **Settings → Warnings**.
- **Projects page** in the admin panel: browse the groups and projects the token can see,
  manage which groups are scanned, and narrow the scan to individual projects with a
  per-project whitelist. Large groups collapse into accordions.
- `notifications.channels` and `default_recipient_domain`, so a deployment can derive
  recipient addresses as `{username}@{domain}` rather than listing everyone by hand.
- The running version is now visible: in the admin panel footer, in the first line of the
  boot log, in the `user-agent` sent to GitLab, and from `nudge version`.

### Notes

- Switching `warn_missing_ticket` on makes each scan fetch merge request descriptions,
  which are the largest field on the query. They are left out of the query entirely while
  the check is off.
- No configuration changes are required to upgrade from 0.1.0. Every new key has a default
  that preserves the previous behaviour, except that an unattended merge request now
  reaches its author — set `rules.notify_author_of_warnings: false` to keep the old
  silence.

---

## 0.1.0 — 2026-08-06

The first working version, never tagged. Everything below shipped under this number.

### Added

- Daily digests telling people which merge requests are waiting on them, as reviewer,
  assignee, or thread participant, with three independently switchable rules and a
  "how long it has been waiting" age on every row.
- GraphQL against GitLab, deliberately not REST, so approvals work on GitLab Free.
  Degrades gracefully on instances too old for `reviewState` or `commits(last: 1)`.
- Delivery over email, Microsoft Teams, Slack and Telegram, behind a channel registry.
- An admin panel: pause, snooze, exclusions, quiet hours, recipients, rule toggles, and an
  append-only audit log covering every change and every delivery attempt.
- Self-service links in each digest, letting recipients mute one merge request or pause
  themselves without an administrator.
- SQLite for operator state, kept separate from `config.yaml`, which holds infrastructure
  and secrets and is never written by the application.

### Changed

- **Renamed from MergeRequestAlarm to ReviewNudge.** `MRA_*` environment variables still
  work and lose to `NUDGE_*` where both are set; an existing `data/mra.db` is adopted when
  no `data/nudge.db` is present, so the rename cannot look like data loss.

### Fixed

- Nested template fragments in the admin panel rendered as escaped tag soup.
- "waiting today" appeared in prose bodies, which is not English.
