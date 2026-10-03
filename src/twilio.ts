/** Direct Twilio SMS via api.twilio.com — no SDK needed. */
import http from "node:http";
import type { TwilioConfig } from "./config.js";

function auth(cfg: TwilioConfig): string {
  return (
    "Basic " + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")
  );
}

export function isConfigured(cfg: TwilioConfig): boolean {
  return !Object.values(cfg).some((v) => v.includes("REPLACE_ME"));
}

export async function sendSms(cfg: TwilioConfig, body: string): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: auth(cfg),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: cfg.administratorNumber,
      From: cfg.fromNumber,
      Body: body,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`twilio HTTP ${res.status}: ${await res.text()}`);
}

export type SmsHandler = (from: string, body: string) => Promise<string | void>;

/**
 * Inbound webhook for Marc's replies ("immediate feedback").
 * Point a Twilio number's messaging webhook at http://<host>:<port>/sms.
 */
export function startSmsWebhook(port: number, onSms: SmsHandler): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/sms") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        const params = new URLSearchParams(raw);
        const reply = await onSms(
          params.get("From") ?? "?",
          params.get("Body") ?? "",
        );
        res.writeHead(200, { "content-type": "text/xml" });
        res.end(
          reply
            ? `<Response><Message>${escapeXml(reply)}</Message></Response>`
            : "<Response></Response>",
        );
      } catch (e) {
        res.writeHead(200, { "content-type": "text/xml" });
        res.end("<Response></Response>");
        console.error("[sms] handler error:", e);
      }
    });
  });
  server.listen(port, () =>
    console.log(`[sms] webhook listening on :${port}/sms`),
  );
  return server;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
