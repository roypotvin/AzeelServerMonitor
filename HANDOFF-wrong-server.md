# Handoff — AzeelServerMonitor (wrong-server incident, 2026-10-04)

Marc is handing this to another worker. Start here.

## 1. The immediate problem: MCP is pointed at the WRONG server

User refreshed the MCP at ~13:02 ET on 2026-10-04 and asked "see if it works now."
It does work — but against the wrong account.

Live connection state observed in this session (via `azeel_api_connection_info`):

- Profile `default` → account **`azeel-probate`**, mode `alpha`
- Endpoint: `https://azeel-probate.azeel.net/alpha/api`
- Pushed at `2026-10-04T17:02:27.258Z`, pushed by `env`

Aurora (`aurora_connection_info`): host `cl1-db13.cluster-c0yc3sny3cvm.us-east-1.rds.amazonaws.com`,
user `azeel-dev-mcp`. Accessible DBs are all `AzeelClient_*` (alphalaw, azeelprobate,
fgc, ip2, krapf-*, userve, webercrabb, …). **No Mothership DB is in the list.**

Why this matters: all recent work targets the **`azeelMothership`** account/DB
(stats/issues tables, `ServerMonitorServers` API class, `ServerMonitor` role id 13,
dashboard app in pack "Azeel Mothership"). Probes run now hit `azeel-probate`,
so `ServerMonitorServers.get` denials and missing panel/app rows are EXPECTED
and prove nothing. **Do not "fix" grants on `azeel-probate`.** Repoint first:

1. Repoint the MCP API profile to the Mothership account
   (expected account name `azeelMothership`, mode `alpha` — e.g. `azl mcp api push`
   or however Marc provisions profiles; confirm with `azeel_api_connection_info`).
2. Confirm Aurora reaches the Mothership system/data DBs (`aurora_connection_info`
   should show them; if not, the Aurora MCP user/profile is also wrong).
3. Re-run the probes below. Only then are grant errors meaningful.

## 2. Project map

- **Monitor repo (this workspace):** `/Azeel.net/AzeelServerMonitor` — Node 20 ESM,
  zero-dep + vendored libs. Git repo, branch `main`. `panels/` is currently
  untracked (`git log`: `dc46deb Initial Dev`, `01158c1 Initial commit`).
  **Do NOT push without Marc's explicit instruction.**
- **Mothership framework repo:** `/Azeel.net/Code` (Azeel PHP, Core up to 6.2).
  `git status` there is SLOW (~2 min) — avoid it. Unrelated modified files
  (`mcp.json`, `Users.php`) are NOT ours — leave them alone.
- **Box:** Amazon Linux 2, glibc 2.26 (official Node 20 won't run; the service
  uses a copied binary `/usr/local/bin/node-azeel-monitor`). System npm v3 is
  broken; bootstrapped npm 10 lives at `/tmp/npm-dist` (ephemeral). System git
  2.23 — no `--trailer`, and the environment injects
  `--trailer 'Co-authored-by...'` into `git commit`, which BREAKS commits.
  Use plumbing or `-c` workarounds; Marc took over committing manually.
- **Live box state at build time:** swap 99% full, 2 stacked cursor-server
  builds, OOM-killed a node PID 22198 at 00:01 Oct 3. Memory hogs = cursor
  extension hosts.

## 3. What was built — monitor v1.0.0 (done, proven live)

- `src/config.ts` — loads `/Azeel.net/Local/server-minitor.json` (**exact
  spelling; contains REAL secrets — never print values; when inspecting, mask
  `*key*`/`*secret*`/`*token*`**). Env vars override file. `configReady()` check.
- `src/metrics.ts` — load/CPU/RAM/swap/disk/inodes/IPs/proc count/top-procs/
  cursor-builds/OOM.
- `src/mothership.ts` — writes via vendored `azeel-node-api`
  (`vendor/azeel-node-api-0.1.0.tgz`, upstream `github.com/roypotvin/Azeel-Node-API`,
  account `azeelMothership`, mode `alpha`): `pushStats` →
  `AzeelServerMonitorStats.insert` every `pushMs`; `logIssue` →
  `AzeelServerMonitorIssues.insert` on problems only.
- `src/smsRelay.ts` — SMS via `twilioManagerMessages.send` (identity
  creator=97/client=97), inbound poll, adaptive cadence (2 min idle / 20 s for
  5 min after any send), `msgId`-seeded, admin-number filter, never writes IN rows.
- `src/agent.ts` — Vercel AI SDK v6 + Fireworks `glm-5p3-flash` (function-calling
  verified): breach `investigate()` (whitelisted `kill_cursor_builds` gated by
  `autoRemediate`, `propose_remedy` → YES/NO SMS approvals, 30-min expiry),
  read-only `answerInbound()`. All actions audited to MonitorIssues.
- `src/remedies.ts`, `src/watcher.ts`, `src/index.ts`,
  `azeel-server-monitor.service` (systemd, installed + **active**).
- Twilio: monitor's line (from) `+17278773041`, admin (Marc) `+17272512626`.
  Twilio direct path dormant (no creds); relay is primary.
- Proven live: stats/issues/SMS both directions, agent Q&A, approval flow, daemon running.
- See `README.md` for full ops reference (config keys, daemon commands).

## 4. In progress — Mothership UI app (Marc-first dashboard)

Target: new app in `vendor_AzeelMothership` (pack "Azeel Mothership", pack_id 5,
packver_id 2): left server list, top detail, bottom activity log.

Built so far:

- `Vendors/vendor_AzeelMothership/package_AzeelMothership/1.0/Api/ServerMonitorServers.php`
  (in `/Azeel.net/Code`; per-host rollup; `php -l` clean).
- 4 panel specs in this repo under `panels/` (untracked): `serverList.json`,
  `serverDetail.json`, `serverActivity.json`, `serverDashboard.json` — modeled on
  live accountGrid/accountDetails/BORDER templates; selection wiring uses the
  documented `loadFilters` idiom.

Key architecture findings (verified this session):

- Mothership-package apps = DB rows (no `app_*.php` needed); grids bind via `dataSrc.class`.
- `AccountActivePanels` is a VIEW (activation via AccountPackages + role groups, not inserts).
- Panel writes must go through `MarketplaceApplicationPanelsEditor.*` APIs (panel-edit
  skill), never raw SQL; cache clears automatically on successful API edits (no
  standalone `users.clearCache` exists); Marc = `Users.user_id` 1.
- **User rule (hard):** after any DB-only change to `MarketplaceApplicationPanels`,
  `AccountActivePanels`, or package/system schema rows (Aurora/MySQL, not API CRUD),
  always reset the Azeel account cache before asking Marc to reload — direct SQL
  skips `clearCacheData()`. Prefer a successful `MarketplaceApplicationPanelsEditor.edit`
  with a real field change; failed "Nothing to update" does NOT clear.
  Confirm `Cache Clear [PANELS]` / `Cache Flush [FULL]` in SystemLog when unsure.

## 5. The blocker: `ServerMonitor` role grants (re-verify AFTER repointing)

Role `ServerMonitor` (role_id 13) holds only 4 grants: full CRUD on the two monitor
tables, read on `twilioManagerMessages`, plus one function grant (`send` on
`twilioManagerMessages` via `RoleApiFunctions` → `MarketplaceApiFunctions`).

Access model (mapped this session):

- Custom actions (e.g. `twilioManagerMessages.send`) are granted via
  `RoleApiFunctions` → `MarketplaceApiFunctions` rows (`apifunc_name` + `apifunc_classname`).
- Standard CRUD (`.get`/`.insert`) is governed by `RoleClass` + `MarketplaceClasses` rows.

Still needed (on the MOTHERSHIP account, not probate):

1. `MarketplaceApiFunctions` + `RoleApiFunctions`: `get` / `ServerMonitorServers` → role 13.
2. `RoleClass`: `create` (and `modify` for refinement) on the `MarketplaceApplications`
   and `MarketplaceApplicationPanels` classes → role 13 (or Marc creates the 5 rows
   himself from the `panels/` spec files).

Then: create the app + 4 panels via API, verify reads, and confirm cache-clear behavior.

## 6. Cautions for the next worker

- Never print `/Azeel.net/Local/server-minitor.json` secret values.
- Daemon boot re-texts active alerts (in-memory dedupe) — warn Marc before restarts.
- No `AskQuestion` questionnaires — Marc cancelled one; use prose.
- Daemon STATUS test was proven manually; adaptive poller + agent await live-fire under daemon.
- Pending Marc replies at handoff time: grant confirmation (or self-created panels).
- User once reported the terminal "overwrote my settings" — cause unidentified;
  treat config writes carefully (read-modify-write whole JSON).

## 7. Quick re-verify checklist (after MCP repoint)

1. `azeel_api_connection_info` shows account `azeelMothership` (mode `alpha`).
2. `aurora_connection_info` shows the Mothership DBs.
3. `ServerMonitorServers.get` probe succeeds (or fails with a REAL grant error, not wrong-account noise).
4. Role 13 grants re-checked; items in §5 applied.
5. App + 4 panels created via API; dashboard loads for Marc (user_id 1); cache-clear confirmed in SystemLog.
