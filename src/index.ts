/** Entry point: watch loop + SMS (mothership relay poll and/or local webhook). */
import { CONFIG, CONFIG_PATH, configReady } from "./config.js";
import { Watcher } from "./watcher.js";
import { isConfigured as mothershipReady } from "./mothership.js";
import {
  relayReady,
  sendViaRelay,
  fetchInboundSince,
  latestMsgId,
  nextPollDelayMs,
  digits,
} from "./smsRelay.js";
import { startSmsWebhook, isConfigured as twilioReady } from "./twilio.js";
import { collectMetrics } from "./metrics.js";
import { resolveProposal, answerInbound } from "./agent.js";

const { ok: cfgOk, missing } = configReady();
console.log(`[config] file: ${CONFIG_PATH}`);
console.log(
  `[config] poll every ${CONFIG.pollMs}ms, push every ${CONFIG.pushMs}ms, ` +
    `autoRemediate=${CONFIG.autoRemediate ? "ON" : "OFF"}, ` +
    `relay=${CONFIG.smsRelay.enabled ? "on" : "off"}, ` +
    `sms=${CONFIG.smsEnabled ? `:${CONFIG.smsPort}` : "disabled"}`,
);
if (!cfgOk) {
  console.log(
    `[config] WARNING — placeholders still present for: ${missing.join(", ")}. ` +
      `Edit ${CONFIG_PATH}. Related features are skipped until filled.`,
  );
}

const watcher = new Watcher();
watcher.start();

/** Shared SMS command handler (local webhook + relay poll both use this). */
async function handleSmsCommand(from: string, body: string): Promise<string> {
  console.log(`[sms] from ${from}: ${body}`);
  const cmd = body.trim().toLowerCase();

  // Proposal approval: "YES <id>" / "NO <id>".
  const vote = cmd.match(/^(yes|no)\s+([0-9a-f]{4})$/i);
  if (vote) {
    const approved = vote[1].toLowerCase() === "yes";
    try {
      return await resolveProposal(vote[2], approved);
    } catch (e) {
      return `approval error: ${(e as Error).message}`.slice(0, 200);
    }
  }

  if (cmd === "status") {
    const m = await collectMetrics();
    return (
      `load ${m.load1.toFixed(1)}/${m.load5.toFixed(1)}/${m.load15.toFixed(1)} ` +
        `cpu ${m.cpuUsagePct.toFixed(0)}% ` +
        `mem ${m.memUsedPct.toFixed(0)}% swap ${m.swapUsedPct.toFixed(0)}% ` +
        `disk ${m.worstDiskPct}% alerts: ${watcher.latestAlerts.length}`
    );
  }
  if (cmd === "quiet 1h") {
    // TODO: implement quiet-hours window
    return "quiet-hours not implemented yet";
  }
  if (CONFIG.agent.enabled) {
    try {
      const m = await collectMetrics();
      return await answerInbound(body, m, watcher.latestAlerts);
    } catch (e) {
      console.error("[sms] agent reply failed:", (e as Error).message);
    }
  }
  return "commands: STATUS";
}

let smsServer: ReturnType<typeof startSmsWebhook> | undefined;

if (CONFIG.smsEnabled && twilioReady(CONFIG.twilio)) {
  smsServer = startSmsWebhook(CONFIG.smsPort, handleSmsCommand);
} else if (!CONFIG.smsEnabled) {
  console.log("[sms] local webhook disabled in config");
} else {
  console.log("[sms] twilio direct not configured — skipping local webhook");
}

// Mothership relay inbound: adaptive poll for admin commands (works behind
// any NAT). Idle cadence is slow (default 2 min); every successful relay
// send arms a fast window (default 20s for 5 min) to catch the reply.
let lastInboundId = 0;
if (relayReady(CONFIG.mothership, CONFIG.smsRelay)) {
  const adminDigits = digits(CONFIG.twilio.administratorNumber);
  try {
    // Seed: only rows newer than this are "new" (e.g. msgId 8910 already
    // seen stays history). IN rows are never written to — the mothership
    // pipeline owns their RX_* lifecycle.
    lastInboundId = await latestMsgId(CONFIG.mothership);
    console.log(
      `[sms] relay poll on (idle ${CONFIG.smsRelay.pollMs}ms, ` +
        `active ${CONFIG.smsRelay.activePollMs}ms/${CONFIG.smsRelay.activeWindowMs}ms), ` +
        `admin=${adminDigits}, from msgId ${lastInboundId}`,
    );
  } catch (e) {
    console.error("[sms] relay seed failed:", (e as Error).message);
  }
  let lastDelay = 0;
  const pollOnce = async (): Promise<void> => {
    try {
      const rows = await fetchInboundSince(CONFIG.mothership, lastInboundId);
      for (const r of rows) {
        lastInboundId = Math.max(lastInboundId, r.msgId);
        if (r.msgPhone !== adminDigits) continue; // ignore non-admin
        const reply = await handleSmsCommand(r.msgPhone, r.msgMsg);
        if (reply) {
          await sendViaRelay(
            CONFIG.mothership,
            CONFIG.smsRelay,
            r.msgPhone,
            reply,
          );
        }
      }
    } catch (e) {
      console.error("[sms] relay poll failed:", (e as Error).message);
    } finally {
      const delay = nextPollDelayMs(CONFIG.smsRelay);
      if (delay !== lastDelay) {
        console.log(
          `[sms] relay cadence → ${delay}ms (${delay === CONFIG.smsRelay.activePollMs ? "active, awaiting reply" : "idle"})`,
        );
        lastDelay = delay;
      }
      setTimeout(() => void pollOnce(), delay);
    }
  };
  setTimeout(() => void pollOnce(), nextPollDelayMs(CONFIG.smsRelay));
} else if (mothershipReady(CONFIG.mothership)) {
  console.log("[sms] relay disabled or no from-number — skipping relay poll");
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[${sig}] shutting down`);
    watcher.stop();
    smsServer?.close(() => process.exit(0));
    // If the server doesn't drain, force out.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
