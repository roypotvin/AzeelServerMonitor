/** Minimal Fireworks AI client (OpenAI-compatible chat completions). */
const BASE = "https://api.fireworks.ai/inference/v1";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function askFireworks(
  model: string,
  messages: ChatMsg[],
  maxTokens = 500,
): Promise<string> {
  const key = process.env.FIREWORKS_API_KEY;
  if (!key) throw new Error("FIREWORKS_API_KEY not set");
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`fireworks HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Ask the model to assess a metric snapshot and recommend an action. */
export async function assessMetrics(
  model: string,
  snapshotJson: string,
): Promise<string> {
  return askFireworks(model, [
    {
      role: "system",
      content:
        "You are a server-ops agent. Given a JSON snapshot of host metrics, " +
        "reply in 3 short lines: STATUS (ok|watch|critical), what you see, " +
        "and the one action to take (or 'none'). Be terse.",
    },
    { role: "user", content: snapshotJson },
  ]);
}
