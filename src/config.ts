/**
 * Central configuration.
 *
 * Source of truth is the JSON file at $MONITOR_CONFIG, defaulting to
 * /Azeel.net/Local/server-minitor.json (created with REPLACE_ME placeholders;
 * Marc fills in real values). Environment variables override the file, so
 * existing deployments keep working.
 *
 * Precedence: env > JSON file > built-in defaults.
 */

import { existsSync, readFileSync } from "node:fs";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  administratorNumber: string;
}

export interface MothershipConfig {
  /** Azeel account/subdomain, e.g. "azeelMothership" */
  accountName: string;
  /** API key 1 (sent as `ak`) */
  apiKey: string;
  /** API key 2 (used only to compute huid = sha256(uid + apiKey2)) */
  apiKey2: string;
  /** API mode: live | beta | alpha */
  mode: "live" | "beta" | "alpha";
  /** Optional full URL override (maps to client `baseUrl`) */
  baseUrl?: string;
}

export interface SmsRelayConfig {
  /** master switch for mothership-relayed SMS (send + inbound poll) */
  enabled: boolean;
  /** sending line, digits recommended; defaults to twilio.fromNumber */
  fromNumber: string;
  /** stamped on outbound twilioManagerMessages rows (mirrors live rows) */
  creator: number;
  client: number;
  /** idle inbound poll cadence (default 2 min) */
  pollMs: number;
  /** inbound cadence while awaiting a reply after a send (default 20s) */
  activePollMs: number;
  /** how long after a send to stay on the fast cadence (default 5 min) */
  activeWindowMs: number;
}

export interface AgentConfig {
  /** master switch for the ops agent (breach investigation + SMS brain) */
  enabled: boolean;
  /** max agentic tool steps per run */
  maxSteps: number;
  /** proposals expire after this long without YES/NO */
  approvalExpiryMs: number;
}

export interface Thresholds {
  /** 1-min loadavg per CPU above which we raise an alert */
  loadPerCpu: number;
  /** % RAM used above which we raise an alert */
  memUsedPct: number;
  /** % swap used above which we raise an alert */
  swapUsedPct: number;
  /** % disk used (worst mount) above which we raise an alert */
  diskUsedPct: number;
  /** max age (ms) of the last successful mothership push before alerting */
  maxPushStaleMs: number;
}

/** Resolved path of the JSON config file (exact spelling Marc specified). */
export const CONFIG_PATH =
  process.env.MONITOR_CONFIG ?? "/Azeel.net/Local/server-minitor.json";

/** Raw shape of the JSON file — every field optional, defaults fill gaps. */
interface FileConfig {
  pollMs?: number;
  pushMs?: number;
  smsPort?: number;
  smsEnabled?: boolean;
  autoRemediate?: boolean;
  fireworksModel?: string;
  fireworksApiKey?: string;
  thresholds?: Partial<Thresholds>;
  twilio?: Partial<TwilioConfig>;
  mothership?: Partial<MothershipConfig>;
  smsRelay?: Partial<SmsRelayConfig>;
  agent?: Partial<AgentConfig>;
}

function loadFile(path: string): FileConfig {
  // Tolerate the likely-correct spelling as a fallback.
  const candidates =
    path === "/Azeel.net/Local/server-minitor.json"
      ? [path, "/Azeel.net/Local/server-monitor.json"]
      : [path];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as FileConfig;
      if (p !== path) console.log(`[config] using fallback file ${p}`);
      else console.log(`[config] loaded ${p}`);
      return parsed;
    } catch (e) {
      console.error(`[config] failed to parse ${p}: ${(e as Error).message}`);
      return {};
    }
  }
  console.log(`[config] no file at ${path} — using defaults + env`);
  return {};
}

function num(
  envName: string,
  fromFile: number | undefined,
  fallback: number,
): number {
  const raw = process.env[envName];
  if (raw !== undefined) {
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return fromFile ?? fallback;
}

function str(
  envName: string,
  fromFile: string | undefined,
  fallback: string,
): string {
  return process.env[envName] ?? fromFile ?? fallback;
}

const file = loadFile(CONFIG_PATH);

const twilio: TwilioConfig = {
  accountSid: str("TWILIO_ACCOUNT_SID", file.twilio?.accountSid, "REPLACE_ME"),
  authToken: str("TWILIO_AUTH_TOKEN", file.twilio?.authToken, "REPLACE_ME"),
  fromNumber: str("TWILIO_FROM_NUMBER", file.twilio?.fromNumber, "REPLACE_ME"),
  administratorNumber: str(
    "ADMINISTRATOR_NUMBER",
    file.twilio?.administratorNumber ?? process.env.MARC_NUMBER,
    "REPLACE_ME",
  ),
};

const mothership: MothershipConfig = {
  accountName: str(
    "MOTHERSHIP_ACCOUNT",
    file.mothership?.accountName,
    "REPLACE_ME",
  ),
  apiKey: str("MOTHERSHIP_API_KEY", file.mothership?.apiKey, "REPLACE_ME"),
  apiKey2: str("MOTHERSHIP_API_KEY2", file.mothership?.apiKey2, "REPLACE_ME"),
  mode: (() => {
    const raw =
      process.env.MOTHERSHIP_MODE ?? file.mothership?.mode ?? "alpha";
    return raw === "live" || raw === "beta" || raw === "alpha"
      ? raw
      : "alpha";
  })(),
  baseUrl:
    process.env.MOTHERSHIP_URL ?? file.mothership?.baseUrl ?? undefined,
};

// Fireworks key lives in the file now (env still wins).
if (file.fireworksApiKey && !process.env.FIREWORKS_API_KEY) {
  process.env.FIREWORKS_API_KEY = file.fireworksApiKey;
}

function boolEnv(name: string, fromFile: boolean | undefined): boolean {
  const raw = process.env[name];
  if (raw !== undefined) return raw === "1" || raw.toLowerCase() === "true";
  return fromFile ?? true;
}

export const CONFIG = {
  /** ms between metric collections ("periodic review" cadence) */
  pollMs: num("MONITOR_POLL_MS", file.pollMs, 60_000),
  /** ms between mothership pushes */
  pushMs: num("MONITOR_PUSH_MS", file.pushMs, 5 * 60_000),
  /** port for the inbound Twilio SMS webhook (/sms) */
  smsPort: num("MONITOR_SMS_PORT", file.smsPort, 8787),
  /** set false to disable the inbound SMS webhook entirely */
  smsEnabled: boolEnv("MONITOR_SMS_ENABLED", file.smsEnabled),
  /**
   * V1 safety gate for the stale-cursor-build auto-remediation.
   * false (default) = alert only, never kill. Set true once proven.
   */
  autoRemediate: boolEnv("MONITOR_AUTOREMEDIATE", file.autoRemediate ?? false),
  /** Mothership-relayed SMS: send via twilioManagerMessages, poll inbound */
  smsRelay: {
    enabled: boolEnv("MONITOR_RELAY_ENABLED", file.smsRelay?.enabled ?? true),
    fromNumber: str(
      "MONITOR_RELAY_FROM",
      file.smsRelay?.fromNumber,
      twilio.fromNumber,
    ),
    creator: num("MONITOR_RELAY_CREATOR", file.smsRelay?.creator, 97),
    client: num("MONITOR_RELAY_CLIENT", file.smsRelay?.client, 97),
    pollMs: num("MONITOR_RELAY_POLL_MS", file.smsRelay?.pollMs, 120_000),
    activePollMs: num(
      "MONITOR_RELAY_ACTIVE_POLL_MS",
      file.smsRelay?.activePollMs,
      20_000,
    ),
    activeWindowMs: num(
      "MONITOR_RELAY_ACTIVE_WINDOW_MS",
      file.smsRelay?.activeWindowMs,
      300_000,
    ),
  } as SmsRelayConfig,
  agent: {
    enabled: boolEnv("MONITOR_AGENT_ENABLED", file.agent?.enabled ?? true),
    maxSteps: num("MONITOR_AGENT_MAX_STEPS", file.agent?.maxSteps, 5),
    approvalExpiryMs: num(
      "MONITOR_AGENT_APPROVAL_MS",
      file.agent?.approvalExpiryMs,
      30 * 60_000,
    ),
  } as AgentConfig,
  /** Fireworks model used for assessments/decisions */
  fireworksModel: str(
    "FIREWORKS_MODEL",
    file.fireworksModel,
    "accounts/fireworks/models/llama-v3p3-70b-instruct",
  ),
  thresholds: {
    loadPerCpu: num(
      "MONITOR_MAX_LOAD_PER_CPU",
      file.thresholds?.loadPerCpu,
      4,
    ),
    memUsedPct: num("MONITOR_MAX_MEM_PCT", file.thresholds?.memUsedPct, 90),
    swapUsedPct: num(
      "MONITOR_MAX_SWAP_PCT",
      file.thresholds?.swapUsedPct,
      80,
    ),
    diskUsedPct: num(
      "MONITOR_MAX_DISK_PCT",
      file.thresholds?.diskUsedPct,
      90,
    ),
    maxPushStaleMs: num(
      "MONITOR_MAX_PUSH_STALE_MS",
      file.thresholds?.maxPushStaleMs,
      15 * 60_000,
    ),
  } as Thresholds,
  twilio,
  mothership,
};

/** True when every secret looks filled in (no REPLACE_ME left). */
export function configReady(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const check = (label: string, v: string) => {
    if (!v || v.includes("REPLACE_ME")) missing.push(label);
  };
  check("twilio.accountSid", twilio.accountSid);
  check("twilio.authToken", twilio.authToken);
  check("twilio.fromNumber", twilio.fromNumber);
  check("twilio.administratorNumber", twilio.administratorNumber);
  check("mothership.accountName", mothership.accountName);
  check("mothership.apiKey", mothership.apiKey);
  check("mothership.apiKey2", mothership.apiKey2);
  const fwKey = process.env.FIREWORKS_API_KEY ?? "";
  if (!fwKey || fwKey.includes("REPLACE_ME")) missing.push("fireworksApiKey");
  return { ok: missing.length === 0, missing };
}
