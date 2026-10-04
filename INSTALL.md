# AzeelServerMonitor — Install & Run

Monitor daemon: watches the box, pushes stats + issues to the Mothership,
texts the admin via the mothership SMS relay, and consults the Fireworks
ops agent on critical states. One Mothership serves many monitored boxes —
each box pushes under its own hostname.

## 0. Mothership side (once, not per server)

1. Run `sql/001_monitor_tables.sql` on the **Mothership** DB. Creates
   `AzeelServerMonitorStats` + `AzeelServerMonitorIssues`.
2. Grant the `ServerMonitor` role INSERT on both tables. Until then pushes
   fail with `Invalid role permissions ... (action:insert)` — expected.

## 1. Prerequisites (per monitored server)

- Node 20+ and git.
- systemd (for daemon mode; otherwise run in foreground under tmux/screen).
- No network ports need inbound opening: the SMS relay works by polling
  the Mothership. The optional direct-Twilio webhook (`/sms`, default 8787)
  only matters if you configure Twilio creds *and* expose it (terminate TLS
  in front before exposing publicly).

> Amazon Linux 2 note: official Node 20 builds need glibc ≥ 2.28. The box
> this was born on (AL2, glibc 2.26) runs a hand-copied Node 20 at
> `/usr/local/bin/node-azeel-monitor`. On any modern distro, use official
> Node 20 and point `ExecStart` at it.

## 2. Install

```sh
# get the code onto the new box (clone, or copy the directory)
cd /Azeel.net/AzeelServerMonitor   # or wherever you put it

npm install     # pulls ai SDK, zod, etc.; azeel-node-api is vendored
npm run build   # tsc -> dist/
```

## 3. Configure

Config file (exact spelling): `/Azeel.net/Local/server-minitor.json`.
Override the path with `MONITOR_CONFIG=/path/to.json`. Env vars override
the file (env wins; full table in `README.md`).

```sh
sudo mkdir -p /Azeel.net/Local
# copy server-minitor.json from an existing box as a template, then edit
```

Fill in:

| Section | Keys | Notes |
|---|---|---|
| `mothership` | `accountName`, `apiKey`, `apiKey2`, `mode` | Same account/keys on every box (e.g. `azeelMothership` / `alpha`) |
| `smsRelay` | `fromNumber`, `creator`, `client` | Relay identity stamped on `twilioManagerMessages` rows; verify creator/client against your Mothership |
| `twilio` | `accountSid`, `authToken`, `fromNumber`, `administratorNumber` | May stay `REPLACE_ME` — relay is primary, direct Twilio is fallback only |
| `fireworksApiKey` | — | Ops-agent brain; feature skipped until filled |
| `thresholds` | `loadPerCpu`, `memUsedPct`, `swapUsedPct`, `diskUsedPct`, `maxPushStaleMs` | Per-box tuning lives here |
| `autoRemediate` | — | **Leave `false`** on a new box until you've watched it alert correctly (alert-only mode) |

On startup the monitor logs which keys are still placeholders and skips
just those features. Never print or commit real secret values.

## 4. Verify in foreground

```sh
npm start
# expect: [config] loaded ... then [watch] pushed stats to mothership
```

Checks:

1. A row for the new hostname appears in `AzeelServerMonitorStats`.
2. Text `STATUS` to the monitor's number — you should get a snapshot back.

## 5. Daemonize (systemd)

**Edit `azeel-server-monitor.service` first** — `WorkingDirectory`,
`MONITOR_CONFIG`, and `ExecStart` are hardcoded to the original box's
paths. At minimum point `ExecStart` at the new box's node binary and fix
the working directory:

```sh
npm run daemon:install   # copies unit file, reloads, enables + starts
npm run daemon:status
npm run daemon:logs      # tail journal
npm run daemon:restart   # after editing the JSON config
npm run daemon:stop
```

Survival guarantees (as installed):

- **Reboot:** `systemctl enable` + `WantedBy=multi-user.target` → starts on boot.
- **Crash:** `Restart=always` + `RestartSec=10` → relaunched 10s after any
  exit (including clean exits — deliberate quits will also be restarted).

Caveats:

- Restarting the daemon re-texts any **active** alerts (dedupe is
  in-memory), so warn the admin before restarts.
- If the node binary in `ExecStart` ever goes missing, the restart loop
  fails until it's restored (on AL2 boxes, re-copy from the newest
  `~/.cursor-server/bin/linux-x64/*/node`).

## 6. Multi-server notes

- Same Mothership account/keys on all boxes; new servers appear as new
  rows in the server-list dashboard automatically. No per-server
  Mothership setup.
- Tune sensitivity per box via that box's `thresholds` (or env overrides).
- Keep `autoRemediate: false` until each box has proven its alerting.
