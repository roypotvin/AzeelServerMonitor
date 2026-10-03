/**
 * Remediation actions. Each returns a human-readable result string and never
 * throws — failures come back as text so the agent can report them.
 *
 * WHITELIST (may run automatically on breach): killCursorBuilds.
 * GATED (only via SMS approval): clearSwap.
 */
import { execFile } from "node:child_process";
import type { Metrics } from "./metrics.js";

function sh(cmd: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", cmd],
      { timeout: timeoutMs },
      (err, stdout, stderr) =>
        resolve(
          err
            ? `error: ${err.message}${stderr ? ` | ${String(stderr).trim().slice(0, 300)}` : ""}`
            : stdout.trim(),
        ),
    );
  });
}

function validHash(h: string): boolean {
  return /^[a-f0-9]{8}$/.test(h);
}

/**
 * Whitelisted: TERM stale cursor-server builds (keeping `keepHash`), give
 * them 5s, then KILL only non-keepers. Refuses on a bad keep hash.
 */
export async function killCursorBuilds(keepHash: string): Promise<string> {
  if (!validHash(keepHash)) {
    return `refusing cleanup: bad keep hash ${JSON.stringify(keepHash)}`;
  }
  const keep = `linux-legacy-x64/${keepHash}`;
  const script =
    `for h in $(ps -eo cmd | grep -oE 'linux-legacy-x64/[a-f0-9]{8}' | sort -u); ` +
    `do [ "$h" != "${keep}" ] && pkill -TERM -f "$h"; done; ` +
    `sleep 5; ` +
    `for h in $(ps -eo cmd | grep -oE 'linux-legacy-x64/[a-f0-9]{8}' | sort -u); ` +
    `do [ "$h" != "${keep}" ] && pkill -KILL -f "$h"; done; ` +
    `ps -eo cmd | grep -oE 'linux-legacy-x64/[a-f0-9]{8}' | sort | uniq -c`;
  const out = await sh(script, 30_000);
  return out.startsWith("error:") ? `cleanup failed: ${out}` : `cleanup done, kept ${keepHash}. Remaining: ${out || "none"}`;
}

/** Newest build hash wins (same rule the watcher used). */
export function newestBuildHash(m: Metrics): string | null {
  const hashes = m.cursorBuilds.map((b) => b.hash).sort();
  return hashes.length > 0 ? hashes[hashes.length - 1] : null;
}

/**
 * Gated: flush swap back into RAM (`swapoff -a && swapon -a`). Refuses
 * unless free memory comfortably exceeds used swap — otherwise swapoff
 * itself would OOM the box.
 */
export async function clearSwap(m: Metrics): Promise<string> {
  const room = m.memAvailMb;
  const need = m.swapUsedMb;
  if (need <= 0) return "swap already empty — nothing to do";
  if (room < need * 1.2) {
    return (
      `refusing swapoff: only ${room}MB available for ${need}MB used swap ` +
      `(need 20% headroom). Free RAM first.`
    );
  }
  const out = await sh("swapoff -a && swapon -a && echo OK", 180_000);
  return out.includes("OK")
    ? `swap cleared (${need}MB flushed to RAM)`
    : `swapoff failed: ${out}`;
}
