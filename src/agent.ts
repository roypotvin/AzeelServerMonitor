/**
 * Ops agent (Vercel AI SDK + Fireworks glm-5p3-flash, function calling
 * verified 2026-10-03).
 *
 * Two entry points:
 * - investigate(alerts, metrics): threshold breach → diagnoses with
 *   read-only tools, runs WHITELISTED remedies directly, and records
 *   GATED proposals for SMS approval. Returns SMS-ready text.
 * - answerInbound(text, metrics, alerts): conversational replies, read-only.
 *
 * Approvals: propose() → "YES <id>" text → resolve() executes the gated
 * action against FRESH metrics (guards re-checked at execution time).
 */
import { randomBytes } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { CONFIG } from "./config.js";
import {
  collectMetrics,
  type Metrics,
} from "./metrics.js";
import {
  killCursorBuilds,
  newestBuildHash,
  clearSwap,
} from "./remedies.js";
import { logIssue, isConfigured as mothershipReady } from "./mothership.js";
import type { Alert } from "./watcher.js";

const SMS_MAX = 1500;
const clip = (s: string, max = SMS_MAX): string =>
  s.length > max ? s.slice(0, max - 1) + "…" : s;

function model() {
  const key = process.env.FIREWORKS_API_KEY;
  if (!key) throw new Error("FIREWORKS_API_KEY not set");
  return createOpenAICompatible({
    name: "fireworks",
    baseURL: "https://api.fireworks.ai/inference/v1",
    apiKey: key,
  }).chatModel(CONFIG.fireworksModel);
}

/** Compact snapshot for prompts (top procs trimmed to fit SMS context). */
function snapshot(m: Metrics, alerts: Alert[]): string {
  return JSON.stringify({
    hostname: m.hostname,
    ts: m.ts,
    load: [m.load1, m.load5, m.load15].map((v) => +v.toFixed(2)),
    cpus: m.cpus,
    cpuUsagePct: +m.cpuUsagePct.toFixed(1),
    cpuModel: m.cpuModel,
    mem: {
      totalMb: m.memTotalMb,
      usedMb: m.memUsedMb,
      availMb: m.memAvailMb,
      usedPct: +m.memUsedPct.toFixed(1),
    },
    swap: {
      totalMb: m.swapTotalMb,
      usedMb: m.swapUsedMb,
      usedPct: +m.swapUsedPct.toFixed(1),
    },
    worstDiskPct: m.worstDiskPct,
    worstInodePct: m.worstInodePct,
    ips: m.ips,
    procCount: m.procCount,
    topProcs: m.topProcs.slice(0, 5),
    cursorBuilds: m.cursorBuilds,
    oomRecent: m.oomRecent.slice(-2),
    alerts: alerts.map((a) => `${a.level}: ${a.text}`),
  });
}

// ---------------------------------------------------------------- approvals

export interface Proposal {
  id: string;
  action: "clear_swap";
  reason: string;
  createdAt: number;
  status: "pending" | "done" | "declined" | "expired";
  result?: string;
}

const proposals = new Map<string, Proposal>();

function newProposalId(): string {
  return randomBytes(2).toString("hex").toUpperCase();
}

export function propose(action: Proposal["action"], reason: string): Proposal {
  const p: Proposal = {
    id: newProposalId(),
    action,
    reason,
    createdAt: Date.now(),
    status: "pending",
  };
  proposals.set(p.id, p);
  return p;
}

export function pendingProposals(): Proposal[] {
  const now = Date.now();
  for (const p of proposals.values()) {
    if (p.status === "pending" && now - p.createdAt > CONFIG.agent.approvalExpiryMs) {
      p.status = "expired";
    }
  }
  return [...proposals.values()].filter((p) => p.status === "pending");
}

/** Execute an approved proposal against fresh metrics. Never throws. */
export async function resolveProposal(
  id: string,
  approved: boolean,
): Promise<string> {
  const p = proposals.get(id.toUpperCase());
  if (!p) return `no proposal ${id.toUpperCase()} — it may have expired or was already handled.`;
  if (p.status !== "pending")
    return `proposal ${p.id} is already ${p.status}.`;
  if (Date.now() - p.createdAt > CONFIG.agent.approvalExpiryMs) {
    p.status = "expired";
    return `proposal ${p.id} expired (30 min window).`;
  }
  if (!approved) {
    p.status = "declined";
    audit(`proposal ${p.id} declined by admin`, p);
    return `proposal ${p.id} (${p.action}) declined — nothing executed.`;
  }
  const m = await collectMetrics();
  let result: string;
  if (p.action === "clear_swap") {
    result = await clearSwap(m);
  } else {
    result = `unknown action ${p.action} — refusing`;
  }
  p.status = "done";
  p.result = result;
  audit(`proposal ${p.id} APPROVED + executed: ${result}`, p);
  return `proposal ${p.id} (${p.action}): ${result}`;
}

async function audit(message: string, context?: unknown): Promise<void> {
  if (!mothershipReady(CONFIG.mothership)) return;
  try {
    await logIssue(CONFIG.mothership, "watch", "agent", message, context);
  } catch {
    /* audit is best effort */
  }
}

// ------------------------------------------------------------------- tools

function readTools(m: Metrics, alerts: Alert[]) {
  void alerts;
  return {
    get_status: tool({
      description: "Current load, CPU, memory, swap, disk at a glance",
      inputSchema: z.object({}),
      execute: async () => {
        const s = {
          load: [m.load1, m.load5, m.load15].map((v) => +v.toFixed(2)),
          cpuUsagePct: +m.cpuUsagePct.toFixed(1),
          memUsedPct: +m.memUsedPct.toFixed(1),
          memAvailMb: m.memAvailMb,
          swapUsedPct: +m.swapUsedPct.toFixed(1),
          swapUsedMb: m.swapUsedMb,
          worstDiskPct: m.worstDiskPct,
          uptimeSec: m.uptimeSec,
        };
        return JSON.stringify(s);
      },
    }),
    list_alerts: tool({
      description: "Active threshold alerts being investigated",
      inputSchema: z.object({}),
      execute: async () =>
        JSON.stringify(alerts.map((a) => `${a.level}: ${a.text}`)),
    }),
    get_top_processes: tool({
      description: "Top memory processes (pid, %mem, rss, command)",
      inputSchema: z.object({}),
      execute: async () => JSON.stringify(m.topProcs.slice(0, 8)),
    }),
  };
}

export interface Investigation {
  /** SMS-ready summary incl. actions + proposals with YES ids */
  sms: string;
  auto: string[];
  proposals: Proposal[];
}

/** Threshold breach → diagnose, auto-remediate whitelist, propose the rest. */
export async function investigate(
  alerts: Alert[],
  m: Metrics,
): Promise<Investigation> {
  const auto: string[] = [];
  const created: Proposal[] = [];
  const tools = {
    ...readTools(m, alerts),
    kill_cursor_builds: tool({
      description:
        "WHITELISTED: kill stale cursor-server builds, keeping the newest. " +
        "Only acts when more than one build exists AND memory pressure is high.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!CONFIG.autoRemediate)
          return "auto-remediation is OFF in config — skipping";
        if (m.cursorBuilds.length <= 1)
          return "no pileup — nothing to do";
        if (m.memUsedPct <= 75)
          return `pileup present but memory at ${m.memUsedPct.toFixed(0)}% — below the 75% auto threshold, skipping`;
        const keep = newestBuildHash(m);
        if (!keep) return "no builds found";
        const res = await killCursorBuilds(keep);
        auto.push(`kill_cursor_builds kept ${keep}: ${res}`);
        void audit(`auto-remedy kill_cursor_builds: ${res}`, {
          keep,
          builds: m.cursorBuilds,
        });
        return res;
      },
    }),
    propose_remedy: tool({
      description:
        "GATED: propose an action needing admin SMS approval. Use for anything " +
        "NOT whitelisted (e.g. clear_swap when swap is full). Returns the proposal id.",
      inputSchema: z.object({
        action: z.enum(["clear_swap"]),
        reason: z.string(),
      }),
      execute: async ({ action, reason }) => {
        const p = propose(action, reason);
        created.push(p);
        return `proposal ${p.id} recorded (${action}). Tell the admin to reply YES ${p.id} to approve, NO ${p.id} to decline.`;
      },
    }),
  };

  const { text } = await generateText({
    model: model(),
    system:
      "You are the on-call ops agent for a Linux box, texting the admin over SMS. " +
      "Diagnose the alerts using tools. kill_cursor_builds is pre-approved: use it when warranted. " +
      "Anything else corrective needs propose_remedy — never claim you ran something you only proposed. " +
      "Final message: 3 short texts max — STATUS line, what you found, action taken and/or the YES <id> approval ask. " +
      "Plain text, no markdown, terse.",
    prompt: `Investigate these alerts:\n${snapshot(m, alerts)}`,
    tools,
    stopWhen: stepCountIs(CONFIG.agent.maxSteps),
    abortSignal: AbortSignal.timeout(180_000),
  });
  return { sms: clip(text.trim() || "investigation complete, no action."), auto, proposals: created };
}

/** Conversational inbound reply (read-only tools). */
export async function answerInbound(
  text: string,
  m: Metrics,
  alerts: Alert[],
): Promise<string> {
  const { text: out } = await generateText({
    model: model(),
    system:
      "You are the on-call ops agent texting the server admin over SMS. " +
      "Answer from live data via tools; be terse, plain text, no markdown. " +
      "You cannot run remedies from chat — if action is needed, say what you recommend.",
    prompt: `Admin asks: ${text}\nLive snapshot:\n${snapshot(m, alerts)}`,
    tools: readTools(m, alerts),
    stopWhen: stepCountIs(3),
    abortSignal: AbortSignal.timeout(90_000),
  });
  return clip(out.trim() || "commands: STATUS");
}
