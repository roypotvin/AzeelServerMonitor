/** Basic host metrics collected with the `os` module + a little shell. */
import os from "node:os";
import { execFile } from "node:child_process";

export interface DiskMount {
  mount: string;
  usedPct: number;
}

export interface TopProc {
  pid: number;
  cpu: number;
  memPct: number;
  cmd: string;
}

export interface CursorBuild {
  hash: string;
  procs: number;
}

export interface Metrics {
  ts: string;
  hostname: string;
  uptimeSec: number;
  load1: number;
  load5: number;
  load15: number;
  cpus: number;
  loadPerCpu: number;
  /** e.g. "Intel(R) Xeon(R) Platinum 8259CL" (first cpu entry) */
  cpuModel: string;
  /** overall CPU usage % since the previous sample (0 on first sample) */
  cpuUsagePct: number;
  memTotalMb: number;
  memUsedMb: number;
  memAvailMb: number;
  memUsedPct: number;
  swapTotalMb: number;
  swapUsedMb: number;
  swapUsedPct: number;
  disks: DiskMount[];
  worstDiskPct: number;
  /** worst inode usage % across the same df set */
  worstInodePct: number;
  topProcs: TopProc[];
  /** total process count */
  procCount: number;
  cursorBuilds: CursorBuild[];
  oomRecent: string[];
  /** non-internal IP addresses (v4 + v6) */
  ips: string[];
}

function sh(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

async function diskUsage(): Promise<DiskMount[]> {
  const out = await sh("df", ["-P", "-x", "tmpfs", "-x", "devtmpfs", "-x", "overlay"]);
  const rows: DiskMount[] = [];
  for (const line of out.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const pct = parseInt(parts[4], 10);
    if (Number.isFinite(pct)) rows.push({ mount: parts[5], usedPct: pct });
  }
  return rows;
}

/** Worst inode usage % across real filesystems (0 when unavailable). */
async function worstInodePct(): Promise<number> {
  const out = await sh("df", ["-P", "-i", "-x", "tmpfs", "-x", "devtmpfs", "-x", "overlay"]);
  let worst = 0;
  for (const line of out.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const pct = parseInt(parts[4], 10);
    if (Number.isFinite(pct)) worst = Math.max(worst, pct);
  }
  return worst;
}

/** Non-internal IP addresses from local interfaces (no network calls). */
export function localIps(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal) out.push(a.address);
    }
  }
  return out;
}

let cachedPublicIp: { ip: string; at: number } | null = null;

/**
 * Best-effort public IP, cached for 1h. Never throws — returns null when
 * offline. Called from the push path only, never the per-tick hot path.
 */
export async function getPublicIp(): Promise<string | null> {
  if (cachedPublicIp && Date.now() - cachedPublicIp.at < 3_600_000) {
    return cachedPublicIp.ip;
  }
  try {
    const res = await fetch("https://api.ipify.org", {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return cachedPublicIp?.ip ?? null;
    const ip = (await res.text()).trim();
    if (/^[0-9a-fA-F.:]+$/.test(ip) && ip.length < 64) {
      cachedPublicIp = { ip, at: Date.now() };
      return ip;
    }
  } catch {
    /* offline — keep old cache */
  }
  return cachedPublicIp?.ip ?? null;
}

let lastCpuSample: { idle: number; total: number } | null = null;

/** Overall CPU usage % since the previous call (0 on the first call). */
function cpuUsagePct(): number {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  const prev = lastCpuSample;
  lastCpuSample = { idle, total };
  if (!prev || total <= prev.total) return 0;
  const idleDelta = idle - prev.idle;
  const totalDelta = total - prev.total;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

async function topProcs(): Promise<TopProc[]> {
  const out = await sh("ps", ["-eo", "pid,pcpu,pmem,comm", "--sort=-pmem"]);
  const rows: TopProc[] = [];
  for (const line of out.split("\n").slice(1, 11)) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
    if (m) rows.push({ pid: +m[1], cpu: +m[2], memPct: +m[3], cmd: m[4] });
  }
  return rows;
}

async function cursorBuilds(): Promise<CursorBuild[]> {
  const out = await sh("ps", ["-eo", "cmd"]);
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const m = line.match(/linux-legacy-x64\/([a-f0-9]{8})[a-f0-9]*/);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts].map(([hash, procs]) => ({ hash, procs }));
}

/** OOM-killer lines from the kernel ring buffer (best effort, may be empty). */
async function oomRecent(): Promise<string[]> {
  const out = await sh("sh", [
    "-c",
    "dmesg -T 2>/dev/null | grep -iE 'out of memory|killed process' | tail -5",
  ]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function collectMetrics(): Promise<Metrics> {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  // Linux swap + MemAvailable aren't exposed by os.*; read /proc/meminfo.
  let swapTotal = 0;
  let swapFree = 0;
  let memAvail = free; // fallback: os.freemem()
  try {
    const { readFile } = await import("node:fs/promises");
    const meminfo = await readFile("/proc/meminfo", "utf8");
    swapTotal = (+(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1] ?? 0) * 1024) / 1024 ** 2;
    swapFree = (+(meminfo.match(/SwapFree:\s+(\d+)/)?.[1] ?? 0) * 1024) / 1024 ** 2;
    const availKb = +(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0);
    if (availKb > 0) memAvail = availKb * 1024;
  } catch {
    /* non-Linux — swap stays 0, memAvail falls back to freemem */
  }
  const swapUsed = Math.max(0, swapTotal - swapFree);
  const [load1, load5, load15] = os.loadavg();
  const cpuList = os.cpus();
  const cpus = cpuList.length || 1;
  const disks = await diskUsage();
  const procsOut = await sh("ps", ["-eo", "pid"]);
  const procCount = procsOut
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l)).length;

  return {
    ts: new Date().toISOString(),
    hostname: os.hostname(),
    uptimeSec: Math.floor(os.uptime()),
    load1,
    load5,
    load15,
    cpus,
    loadPerCpu: load1 / cpus,
    cpuModel: cpuList[0]?.model.trim() ?? "unknown",
    cpuUsagePct: cpuUsagePct(),
    memTotalMb: Math.round(total / 1024 ** 2),
    memUsedMb: Math.round(used / 1024 ** 2),
    memAvailMb: Math.round(memAvail / 1024 ** 2),
    memUsedPct: (used / total) * 100,
    swapTotalMb: Math.round(swapTotal),
    swapUsedMb: Math.round(swapUsed),
    swapUsedPct: swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0,
    disks,
    worstDiskPct: disks.reduce((m, d) => Math.max(m, d.usedPct), 0),
    worstInodePct: await worstInodePct(),
    topProcs: await topProcs(),
    procCount,
    cursorBuilds: await cursorBuilds(),
    oomRecent: await oomRecent(),
    ips: localIps(),
  };
}
