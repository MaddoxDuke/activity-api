# CLAUDE.md — Personal Projects Platform

This file describes Maddox's personal VPS platform and its first tenant, the
activity monitoring system. It is written to be reused: copy it into new
project repos and keep the **Platform** section identical everywhere, updating
only the **This Project** section.

---

## Platform (shared across all projects)

### Infrastructure

- **Server:** RackNerd 2 GB KVM VPS (2 vCPU / 2 GB RAM / 35 GB SSD), Ubuntu 24.04 LTS
- **Access:** `ssh vps` (alias configured in `~/.ssh/config` on the Mac → user `maddox`, key auth only; root login and password auth are disabled)
- **Domain:** `maddox-duke.com`
- **Web server:** Caddy (`/etc/caddy/Caddyfile`), automatic HTTPS via Let's Encrypt
- **Process manager:** pm2 (`pm2 list` shows all services; processes persist via `pm2 startup`/`pm2 save`)
- **Database:** single PostgreSQL instance, localhost-only
- **Firewall:** UFW allows only SSH/80/443. Every Node app binds to `127.0.0.1` and is reachable only through Caddy.

### Architecture pattern (one box, many tenants)

Each project = one GitHub repo + one localhost port + one pm2 process + one
Caddy block + one dedicated Postgres user/database.

| Port | Project | Subdomain |
|------|---------|-----------|
| 3000 | activity-api | api.maddox-duke.com |
| —    | activity dashboard (static) | dash.maddox-duke.com |
| 3001 | (next project) | |

**When adding a new service:** claim the next port here, create a dedicated DB
user + database (`sudo -u postgres createuser --pwprompt <proj>_user && sudo -u postgres createdb -O <proj>_user <proj>`),
add a Caddy block, `sudo systemctl reload caddy`, start under pm2 with a clear
name, `pm2 save`. Never share database users between projects.

Static frontends need no port or process — build artifacts go to
`/var/www/<name>` served by a Caddy `file_server` block.

### Development workflow

- **All development happens on the Mac** (`~/dev/<repo>`). The VPS is a runtime,
  not a dev environment. Never author or edit code directly on the server.
- GitHub is the source of truth. The VPS only ever receives code via `git pull`.
- Secrets live in `.env` on the server only (gitignored). Every repo carries a
  `.env.example` with variable names and dummy values.
- Structured missions: work is scoped in mission briefs with explicit
  acceptance criteria. Update this file when conventions or decisions change.

### Deployment

Standard deploy for any Node service:

    ssh vps 'cd ~/apps/<repo> && git pull && npm ci --omit=dev && pm2 restart <name>'

- Verify after deploy: `ssh vps 'pm2 list'` and
  `ssh vps 'pm2 logs <name> --lines 20 --nostream'`
- First-ever start of a new service is manual on the server:
  create `.env`, `pm2 start app.js --name <name>`, `pm2 save`.
- Static frontends: build locally, `rsync` the build output to `/var/www/<name>/`.

### Hard rules for agents

- **Never run destructive commands over SSH** — no `rm -rf`, no `dropdb`, no
  `pm2 delete`, no `ufw`/`sshd` changes.
- **Never auto-apply schema changes against production.** Propose migrations
  and wait for explicit approval.
- Never commit `.env`, credentials, or API keys.
- Keep services small and single-purpose; new capability that isn't clearly
  part of an existing service gets its own repo and port.
- Backups: nightly `pg_dump` cron on the server, pulled off-box periodically.
  Any schema change should consider restore compatibility.

---

## This Project: Activity Monitoring System

### Purpose

Personal life-logging pipeline. iPhone geofence automations (iOS Shortcuts)
capture timestamped events — arriving/leaving work, gym, home, shop — and POST
them to a private API. The data answers questions like: how long are gym
sessions, how does shop time trade off against video editing time, what do
weekly patterns look like. Long-term this becomes a personal event bus that
other producers (editing PC, car projects, manual entries) also feed.

### Components

1. **activity-api** (this repo, port 3000, live at `https://api.maddox-duke.com`)
   - Node 22 / Fastify / pg
   - `POST /events` — accepts `{ts, event, source}`, requires `x-api-key` header
   - `GET /events?from=<iso date>` — returns rows ordered by ts, requires key
   - `GET /health` — unauthenticated, for monitoring
   - Validation: `ts` must parse as a date; `event` must be snake_case text
   - CORS: allows `https://dash.maddox-duke.com` and localhost dev origins
     (browser preflights pass; data routes still require the key)
   - Table: `events(id serial pk, ts timestamptz, event text, source text default 'unknown', received_at timestamptz default now())`

2. **iPhone capture layer** (iOS Shortcuts, not in any repo)
   - Six near-identical shortcuts (`Log left_gym`, `Log arrived_work`, …), each
     with a hardcoded event label, triggered by location automations set to Run Immediately
   - Each appends to a CSV in iCloud Drive **and** POSTs to the API (dual-write
     during trust-building period; CSV retires once the API has proven reliable)
   - Event vocabulary: `arrived_work`, `left_work`, `arrived_gym`, `left_gym`,
     `arrived_home`, `arrived_shop`, `left_shop` — snake_case verbs, stable forever

3. **Dashboard — "Whereabouts"** (built — repo `activity-dash`, static Angular 22
   app at `dash.maddox-duke.com`, deployed by rsync to `/var/www/dash`)
   - Key-gated in the client: the operator key is entered once, verified
     against the API, and kept in localStorage. `?demo=1` renders seeded
     specimen data with no key. The site itself carries no secrets.
   - Pairs arrive/leave events into stays client-side (`src/app/lib/derive.ts`,
     unit-tested): a next-arrival closes an open stay as *inferred*; stays
     over 16 h become *gaps*, never data. Journeys = explicit `left_X` →
     `arrived_Y` within 3 h.
   - Views: scrubbable 24 h day band with live needle and hour probe, week
     rhythm, gym session pins, weekly hours balance, journey passages
     (median per weekday), raw ledger tail.
   - Design language: nocturnal field-almanac — warm near-black paper, bone
     ink, brass fittings, Fraunces + IBM Plex Mono, engraved rules. No UI
     or chart libraries; keep it that way.

### Design principles

- **Events, not durations.** The log stores raw timestamped events; durations
  are always derived by pairing. A missed event is a gap, never corruption.
- **Generic ingest.** The API doesn't know or care what an event means. New
  producers (editing PC posting `editing_start`/`editing_stop`, car Bluetooth
  triggers, manual entries) just use new `event`/`source` values — no schema
  changes needed.
- **Analysis is downstream.** Interpretation (pairing, categorizing, weekly
  summaries) lives in the dashboard/analysis layer, never in the ingest path.

### Roadmap (rough order)

1. Harden ingest: rate limiting, better error responses, request logging
2. Duration-pairing endpoint(s): `GET /sessions?event_pair=arrived_gym,left_gym`
3. ~~Dashboard v1 at dash.maddox-duke.com~~ — shipped July 2026 ("Whereabouts")
4. Weekly automated summary (scheduled analysis producing a narrative digest)
5. Additional producers: editing-time events from desktop, drive-session events
6. Longer-term integrations with other personal projects (e.g., car telemetry
   summaries from RetroDash's Pi posting as `source: retrodash`)

### Adjacent personal projects (context, separate repos when built)

- **Video rough-cut tooling** — AI-assisted editing pipeline for the YouTube
  channel; any server-side pieces get their own port/repo; heavy compute
  (transcription, rendering) stays on local machines, never this VPS
- **RetroDash** — Raspberry Pi engine-vitals display for the S13; may
  eventually POST drive summaries to activity-api as a producer
- The VPS is the shared home for the web-facing pieces of all of these;
  the Platform section above governs how each one gets added.
