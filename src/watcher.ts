/**
 * The continuous watch loop: collect metrics, check thresholds, investigate
 * breaches with the ops agent, push to the mothership, text admin on issues.
 */
import { CONFIG } from "./config.js";
import { collectMetrics, getPublicIp, type Metrics } from "./metrics.js";
import {
  pushStats,
  logIssue,
  isConfigured as mothershipReady,
} from "./mothership.js";
import { isConfigured as twilioReady, sendSms } from "./twilio.js";
import { relayReady, sendViaRelay } from "./smsRelay.js";
import { investigate } from "./agent.js";
import { killCursorBuilds, newestBuildHash } from "./remedies.js";

export type Alert = { level: "watch" | "critical"; text: string };

export class Watcher {
  private lastPushOk = 0;
  private alerted = new Set<string>(); // dedupe: don't re-text the same issue
  private timer?: NodeJS.Timeout;
  private pushTimer?: NodeJS.Timeout;

  start(): void {
    console.log(`[watch] poll every ${CONFIG.pollMs}ms, push every ${CONFIG.pushMs}ms`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), CONFIG.pollMs);
    this.pushTimer = setInterval(() => void this.push(), CONFIG.pushMs);
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.pushTimer);
  }

  latestAlerts: Alert[] = [];

  private async tick(): Promise<void> {
    const m = await collectMetrics();
    const alerts = this.evaluate(m);
    this.latestAlerts = alerts;

    const fresh: Alert[] = [];
    for (const a of alerts) {
      const key = `${a.level}:${a.text}`;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);
      fresh.push(a);
      console.log(`[watch] ${a.level.toUpperCase()}: ${a.text}`);

      // Log the issue to the mothership (best effort — never throws).
      // Healthy states are never logged, only problems.
      if (mothershipReady(CONFIG.mothership)) {
        try {
          await logIssue(CONFIG.mothership, a.level, "watcher", a.text, {
            load1: +m.load1.toFixed(2),
            memUsedPct: +m.memUsedPct.toFixed(1),
            worstDiskPct: m.worstDiskPct,
          });
        } catch (e) {
          console.error("[watch] issue-log failed:", (e as Error).message);
        }
      }
    }

    if (fresh.length === 0) return;

    // Agent investigation on new criticals (replaces the old per-tick
    // Fireworks call — runs once per new breach, not every 60s).
    const freshCritical = fresh.filter((a) => a.level === "critical");
    if (freshCritical.length > 0 && CONFIG.agent.enabled) {
      try {
        const inv = await investigate(freshCritical, m);
        console.log(
          `[watch] agent: auto=[${inv.auto.join(" | ") || "none"}] ` +
            `proposals=[${inv.proposals.map((p) => `${p.id}:${p.action}`).join(", ") || "none"}]`,
        );
        await this.text(`AzeelMon: ${inv.sms}`);
      } catch (e) {
        console.error("[watch] agent failed:", (e as Error).message);
        for (const a of freshCritical) {
          await this.text(`AzeelMon ${a.level.toUpperCase()}: ${a.text}`);
        }
      }
      // Non-critical fresh alerts still get a plain text.
      for (const a of fresh.filter((x) => x.level !== "critical")) {
        await this.text(`AzeelMon ${a.level.toUpperCase()}: ${a.text}`);
      }
      return;
    }

    // Agent disabled: deterministic fallback for the known pileup issue,
    // plain texts for everything else.
    for (const a of fresh) {
      if (
        a.text.startsWith("cursor pileup") &&
        m.memUsedPct > 75 &&
        CONFIG.autoRemediate
      ) {
        const keep = newestBuildHash(m);
        const result = keep
          ? await killCursorBuilds(keep)
          : "no builds found";
        await this.text(
          `AzeelMon CRITICAL: ${a.text}. Cleaned stale cursor builds, kept ${keep}. ${result}`,
        );
        continue;
      }
      await this.text(`AzeelMon ${a.level.toUpperCase()}: ${a.text}`);
    }

    // Watchdog: mothership pushes going stale.
    if (
      this.lastPushOk > 0 &&
      Date.now() - this.lastPushOk > CONFIG.thresholds.maxPushStaleMs
    ) {
      await this.text(
        `AzeelMon WATCH: no successful mothership push for ${Math.round(
          (Date.now() - this.lastPushOk) / 60000,
        )}m`,
      );
      this.lastPushOk = Date.now(); // re-alert on the next window, not every tick
    }
  }

  private async push(): Promise<void> {
    if (!mothershipReady(CONFIG.mothership)) {
      console.log("[watch] mothership not configured — skipping stats push");
      return;
    }
    try {
      const m = await collectMetrics();
      await pushStats(CONFIG.mothership, m, await getPublicIp());
      this.lastPushOk = Date.now();
      console.log("[watch] pushed stats to mothership");
    } catch (e) {
      console.error("[watch] push failed:", (e as Error).message);
    }
  }

  evaluate(m: Metrics): Alert[] {
    const t = CONFIG.thresholds;
    const out: Alert[] = [];
    if (m.loadPerCpu > t.loadPerCpu)
      out.push({
        level: "critical",
        text: `load ${m.load1.toFixed(1)} (${m.loadPerCpu.toFixed(1)}/cpu, ${m.cpus} cpus)`,
      });
    if (m.memUsedPct > t.memUsedPct)
      out.push({
        level: "critical",
        text: `RAM ${m.memUsedMb}/${m.memTotalMb}MB (${m.memUsedPct.toFixed(0)}%)`,
      });
    else if (m.memUsedPct > t.memUsedPct - 10)
      out.push({
        level: "watch",
        text: `RAM climbing: ${m.memUsedPct.toFixed(0)}%`,
      });
    if (m.swapUsedPct > t.swapUsedPct)
      out.push({ level: "watch", text: `swap ${m.swapUsedPct.toFixed(0)}% used` });
    if (m.worstDiskPct > t.diskUsedPct)
      out.push({ level: "critical", text: `disk ${m.worstDiskPct}% used` });
    if (m.cursorBuilds.length > 1)
      out.push({
        level: "critical",
        text: `cursor pileup: ${m.cursorBuilds.length} builds (${m.cursorBuilds
          .map((b) => `${b.hash}:${b.procs}`)
          .join(", ")})`,
      });
    if (m.oomRecent.length > 0)
      out.push({ level: "watch", text: `recent OOM: ${m.oomRecent.at(-1)}` });
    return out;
  }

  private async text(body: string): Promise<void> {
    // Primary path: mothership relay (no Twilio creds needed on this box).
    if (relayReady(CONFIG.mothership, CONFIG.smsRelay)) {
      try {
        await sendViaRelay(
          CONFIG.mothership,
          CONFIG.smsRelay,
          CONFIG.twilio.administratorNumber,
          body,
        );
        return;
      } catch (e) {
        console.error("[watch] relay sms failed:", (e as Error).message);
      }
    }
    // Fallback: direct Twilio API.
    if (!twilioReady(CONFIG.twilio)) {
      console.log(`[watch] (sms not configured, would send: ${body})`);
      return;
    }
    try {
      await sendSms(CONFIG.twilio, body);
    } catch (e) {
      console.error("[watch] sms failed:", (e as Error).message);
    }
  }
}
