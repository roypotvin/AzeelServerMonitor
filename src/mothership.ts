/**
 * Mothership writes via the vendored `azeel-node-api` client
 * (account + apiKey1/apiKey2 + mode=alpha).
 *
 * Two write paths, both plain table inserts (see sql/001_monitor_tables.sql):
 * - pushStats(): periodic stats row, every pushMs, healthy or not.
 * - logIssue(): issue rows ONLY when something is wrong. Healthy states
 *   are never logged — no "everything is fine" noise.
 */
import os from "node:os";
import { createClient, type AzeelClient } from "azeel-node-api";
import type { MothershipConfig } from "./config.js";
import type { Metrics } from "./metrics.js";

export const STATS_TABLE = "AzeelServerMonitorStats";
export const ISSUES_TABLE = "AzeelServerMonitorIssues";

let client: AzeelClient | null = null;

export function isConfigured(cfg: MothershipConfig): boolean {
  return ![cfg.accountName, cfg.apiKey, cfg.apiKey2].some(
    (v) => !v || v.includes("REPLACE_ME"),
  );
}

export function getClient(cfg: MothershipConfig): AzeelClient {
  if (!client) {
    client = createClient({
      account: cfg.accountName,
      apiKey1: cfg.apiKey,
      apiKey2: cfg.apiKey2,
      mode: cfg.mode,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      deviceId: `server-monitor:${os.hostname()}`,
    });
  }
  return client;
}

/** DATETIME "YYYY-MM-DD HH:MM:SS" for the SQL columns. */
function sqlTs(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function clip(v: string, max: number): string {
  return v.length > max ? v.slice(0, max) : v;
}

/** Periodic stats row — sent every pushMs regardless of health. */
export async function pushStats(
  cfg: MothershipConfig,
  m: Metrics,
  publicIp: string | null,
): Promise<void> {
  await getClient(cfg)
    .key(`${STATS_TABLE}.insert`)
    .setMany({
      stat_ts: sqlTs(),
      hostname: m.hostname,
      uptime_sec: m.uptimeSec,
      load1: +m.load1.toFixed(2),
      load5: +m.load5.toFixed(2),
      load15: +m.load15.toFixed(2),
      cpus: m.cpus,
      cpu_model: clip(m.cpuModel, 255),
      cpu_usage_pct: +m.cpuUsagePct.toFixed(1),
      mem_total_mb: m.memTotalMb,
      mem_used_mb: m.memUsedMb,
      mem_avail_mb: m.memAvailMb,
      mem_used_pct: +m.memUsedPct.toFixed(1),
      swap_total_mb: m.swapTotalMb,
      swap_used_mb: m.swapUsedMb,
      swap_used_pct: +m.swapUsedPct.toFixed(1),
      worst_disk_pct: m.worstDiskPct,
      worst_inode_pct: m.worstInodePct,
      ips: clip(m.ips.join(","), 1024),
      public_ip: publicIp ?? "",
      proc_count: m.procCount,
      top_procs: clip(JSON.stringify(m.topProcs), 8000),
      cursor_builds: clip(JSON.stringify(m.cursorBuilds), 2000),
      oom_recent: clip(JSON.stringify(m.oomRecent), 2000),
    })
    .execute();
}

export type IssueLevel = "watch" | "critical";

/**
 * Issue row — call ONLY for problems (alerts, remediation actions,
 * Fireworks critical verdicts). Never for healthy states.
 */
export async function logIssue(
  cfg: MothershipConfig,
  level: IssueLevel,
  source: string,
  message: string,
  context?: unknown,
): Promise<void> {
  await getClient(cfg)
    .key(`${ISSUES_TABLE}.insert`)
    .setMany({
      issue_ts: sqlTs(),
      hostname: os.hostname(),
      level,
      source: clip(source, 64),
      message: clip(message, 2000),
      context_json: clip(JSON.stringify(context ?? null), 8000),
    })
    .execute();
}
