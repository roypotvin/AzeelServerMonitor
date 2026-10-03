/**
 * SMS via the mothership relay (no Twilio creds or inbound ports on this box).
 *
 * Outbound: insert an OUT/SEND_START row into twilioManagerMessages; the
 * mothership's existing worker delivers it via its own Twilio account.
 * Inbound: poll twilioManagerMessages for new IN rows and let the caller
 * handle commands. We never write to IN rows (the mothership pipeline owns
 * their RX_* lifecycle) — we only remember the last seen msgId in memory
 * and act on rows from the administrator number.
 */
import { randomBytes } from "node:crypto";
import {
  getClient,
  isConfigured as mothershipReady,
} from "./mothership.js";
import type { MothershipConfig } from "./config.js";
import type { SmsRelayConfig } from "./config.js";

export const RELAY_TABLE = "twilioManagerMessages";
export const RELAY_SEND_KEY = "twilioManagerMessages.send";

/** Timestamp of the last successful relay send (arms the fast window). */
let lastSendAt = 0;

/**
 * How long to wait before the next inbound poll: fast cadence while inside
 * the post-send window, idle cadence otherwise.
 */
export function nextPollDelayMs(
  relay: SmsRelayConfig,
  now = Date.now(),
): number {
  const inWindow =
    lastSendAt > 0 && now - lastSendAt < relay.activeWindowMs;
  return inWindow ? relay.activePollMs : relay.pollMs;
}

/** Digits only, US 10-digit → 11-digit with leading 1 (matches DB format). */
export function digits(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length === 10) return `1${d}`;
  return d;
}

/** Unique id in the mothership's observed "<epoch>.<rand>" shape. */
function newUid(): string {
  const rand = randomBytes(4)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "X")
    .slice(0, 7)
    .padEnd(7, "0");
  return `${Math.floor(Date.now() / 1000)}.${rand}`;
}

export function relayReady(
  mothership: MothershipConfig,
  relay: SmsRelayConfig,
): boolean {
  if (!relay.enabled || !mothershipReady(mothership)) return false;
  return digits(relay.fromNumber).length >= 10;
}

/** Queue an outbound SMS through the mothership `send` action. */
export async function sendViaRelay(
  mothership: MothershipConfig,
  relay: SmsRelayConfig,
  to: string,
  body: string,
): Promise<string> {
  const uid = newUid();
  await getClient(mothership)
    .key(RELAY_SEND_KEY)
    .setMany({
      msgPhone: digits(to),
      msgPhoneLocal: digits(relay.fromNumber),
      msgMsg: body.slice(0, 1600),
      msgUid: uid,
      msgCreator: relay.creator,
      msgClient: relay.client,
    })
    .execute();
  lastSendAt = Date.now(); // arm the fast poll window
  return uid;
}

export interface InboundMsg {
  msgId: number;
  msgPhone: string;
  msgMsg: string;
  msgCreated: string;
}

/** Newest IN rows above `sinceId` (ascending). Empty when none. */
export async function fetchInboundSince(
  mothership: MothershipConfig,
  sinceId: number,
  limit = 25,
): Promise<InboundMsg[]> {
  const res = await getClient(mothership)
    .key(`${RELAY_TABLE}.get`)
    .columns("msgId", "msgPhone", "msgMsg", "msgCreated")
    .filter("msgDirection", "IN", "eq")
    .filter("msgId", sinceId + 1, "gte")
    .orderBy("msgId", "ASC")
    .limit(limit)
    .execute();
  const data = (res.data ?? []) as Record<string, unknown>[];
  return data.map((r) => ({
    msgId: Number(r.msgId),
    msgPhone: String(r.msgPhone ?? ""),
    msgMsg: String(r.msgMsg ?? ""),
    msgCreated: String(r.msgCreated ?? ""),
  }));
}

/** Current max msgId — seed for "only process new rows from here on". */
export async function latestMsgId(
  mothership: MothershipConfig,
): Promise<number> {
  const res = await getClient(mothership)
    .key(`${RELAY_TABLE}.get`)
    .columns("msgId")
    .orderBy("msgId", "DESC")
    .limit(1)
    .execute();
  const data = (res.data ?? []) as Record<string, unknown>[];
  return data.length > 0 ? Number(data[0].msgId) : 0;
}
