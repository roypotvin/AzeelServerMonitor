# AzeelServerMonitor v1
Lightweight server monitor. Watches the box, writes stats + issues to the
mothership, texts Marc via Twilio, and consults Fireworks AI when things look bad.

## What it does
1. **Metrics** (`src/metrics.ts`) — load, CPU (model/count/usage%), RAM
   (total/used/avail), swap, disk + inode usage, local + public IPs, process
   count, top procs, stacked cursor-server builds, recent OOM-killer events.
2. **Watch loop** (`src/watcher.ts`) — evaluates thresholds every `pollMs`.
   Auto-remediation runs **only if `autoRemediate: true`** (default `false` =
   alert only). Issues are logged to the mothership; healthy states never are.
3. **Mothership writes** (`src/mothership.ts`) — via the vendored
   `azeel-node-api` client (account `azeelMothership`, mode `alpha`):
   stats row every `pushMs` (`AzeelServerMonitorStats.insert`), issue rows on problems
   only (`AzeelServerMonitorIssues.insert`). No "everything is fine" messages.
4. **Twilio / SMS** — primary path is the **mothership relay** (`src/smsRelay.ts`):
   outbound alerts are queued as `twilioManagerMessages` OUT/SEND_START rows
   (the mothership's worker delivers them), and inbound admin commands are
   picked up by polling new IN rows — no inbound ports needed. Direct Twilio
   API (`src/twilio.ts`) remains as fallback. Text `STATUS` to get an instant
   snapshot back.
5. **Fireworks** (`src/fireworks.ts`) — second-opinion assessment on critical states.

## Ops agent (AI SDK + Fireworks glm-5p3-flash)
`src/agent.ts` + `src/remedies.ts`. On a **new critical alert** the agent
investigates with read-only tools, runs **whitelisted** remedies directly
(`kill_cursor_builds`, gated by `autoRemediate`), and **proposes** anything
else (`propose_remedy` → currently `clear_swap`). Proposals text you a
`YES <id>` / `NO <id>` ask; approval executes against fresh metrics with
guards re-checked, everything audited to `MonitorIssues`. Free-text replies
get conversational answers from live data (read-only). No reply within
`approvalExpiryMs` (30 min) = no action, ever.

## Config
Everything lives in `/Azeel.net/Local/server-minitor.json` (that exact
spelling). Override the path with `MONITOR_CONFIG=/path/to.json`. Env vars
override the file (env wins):

| JSON key | Env override | Default |
|---|---|---|
| `pollMs` | `MONITOR_POLL_MS` | 60000 |
| `pushMs` | `MONITOR_PUSH_MS` | 300000 |
| `smsPort` / `smsEnabled` | `MONITOR_SMS_PORT` / `MONITOR_SMS_ENABLED` | 8787 / true |
| `autoRemediate` | `MONITOR_AUTOREMEDIATE` | false |
| `fireworksModel` / `fireworksApiKey` | `FIREWORKS_MODEL` / `FIREWORKS_API_KEY` | — |
| `thresholds.*` | `MONITOR_MAX_*` | see file |
| `twilio.*` | `TWILIO_*` / `ADMINISTRATOR_NUMBER` (`MARC_NUMBER` also works) | — |
| `smsRelay.enabled` | `MONITOR_RELAY_ENABLED` | true |
| `smsRelay.fromNumber` | `MONITOR_RELAY_FROM` | twilio.fromNumber |
| `smsRelay.creator` / `client` | `MONITOR_RELAY_CREATOR` / `MONITOR_RELAY_CLIENT` | 97 / 97 |
| `smsRelay.pollMs` (idle) | `MONITOR_RELAY_POLL_MS` | 120000 (2 min) |
| `smsRelay.activePollMs` | `MONITOR_RELAY_ACTIVE_POLL_MS` | 20000 (20s) |
| `smsRelay.activeWindowMs` | `MONITOR_RELAY_ACTIVE_WINDOW_MS` | 300000 (5 min) |
| `agent.enabled` | `MONITOR_AGENT_ENABLED` | true |
| `agent.maxSteps` | `MONITOR_AGENT_MAX_STEPS` | 5 |
| `agent.approvalExpiryMs` | `MONITOR_AGENT_APPROVAL_MS` | 1800000 (30 min) |
| `mothership.accountName` | `MOTHERSHIP_ACCOUNT` | — |
| `mothership.apiKey` / `apiKey2` | `MOTHERSHIP_API_KEY` / `MOTHERSHIP_API_KEY2` | — |
| `mothership.mode` | `MOTHERSHIP_MODE` | alpha |
| `mothership.baseUrl` | `MOTHERSHIP_URL` | (derived from account+mode) |

On startup the monitor logs which keys are still placeholders; the related
feature is skipped until filled.

## Mothership tables (provision once)
Run `sql/001_monitor_tables.sql` on the mothership DB, then grant the
`ServerMonitor` role INSERT on `AzeelServerMonitorStats` + `AzeelServerMonitorIssues`. Until then
pushes fail with `Invalid role permissions ... (action:insert)` — expected.

## Run
```sh
npm install
npm run build
npm start                       # foreground (logs to console)
```

## Daemon (systemd — the normal way to run it)
```sh
npm run daemon:install          # install + enable + start the service
npm run daemon:status           # check it's running
npm run daemon:logs             # tail journal logs
npm run daemon:restart          # restart after editing the JSON config
npm run daemon:stop             # stop it
```
The unit file is `azeel-server-monitor.service` in this repo. After editing
`/Azeel.net/Local/server-minitor.json`, run `npm run daemon:restart` to pick
up the new config.

Twilio messaging webhook → `http://<host>:8787/sms` (configure `smsPort` /
`TWILIO_*` first, and terminate TLS in front of it before exposing publicly).
