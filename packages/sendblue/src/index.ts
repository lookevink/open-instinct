import { createHash, timingSafeEqual } from "node:crypto";
import type { InboundMessage, OutboundMessage, Outbox, Principal, StateDir } from "@open-instinct/core";
import { parseConversationKey, splitMessageText, type FileSend, type FileSendResult } from "@open-instinct/inkbox";

export interface SendblueSettings {
  apiKey: string;
  apiSecret: string;
  fromNumber: string;
  webhookSecret: string;
}

export function sendblueSettings(env: NodeJS.ProcessEnv): SendblueSettings | undefined {
  const names = ["SENDBLUE_API_KEY", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"] as const;
  if (!names.some((name) => env[name]?.trim())) return undefined;
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Sendblue requires ${missing.join(", ")}. See docs/SENDBLUE.md.`);
  const fromNumber = env.SENDBLUE_FROM_NUMBER!.trim();
  if (!isPhone(fromNumber)) throw new Error("SENDBLUE_FROM_NUMBER must be an E.164 phone number");
  return { apiKey: env.SENDBLUE_API_KEY!.trim(), apiSecret: env.SENDBLUE_API_SECRET!.trim(), fromNumber, webhookSecret: env.SENDBLUE_WEBHOOK_SECRET!.trim() };
}

function isPhone(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
}

export function verifySendblueSecret(expected: string | undefined, presented: string | undefined): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only direct inbound messages on this agent's line can enter the runtime. */
export function parseSendblueEvent(payload: unknown, fromNumber: string): InboundMessage | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  if (p.is_outbound !== false || p.status !== "RECEIVED" || p.group_id || p.message_type === "group") return undefined;
  if ((p.sendblue_number || p.to_number) !== fromNumber || (p.to_number && p.to_number !== fromNumber)) return undefined;
  if (!isPhone(p.from_number) || typeof p.message_handle !== "string" || !p.message_handle.trim()) return undefined;
  const service = typeof p.service === "string" ? p.service.toLowerCase() : "";
  if (!["imessage", "sms", "mms", "rcs"].includes(service)) return undefined;
  const channel = service === "imessage" ? "imessage" : "sms";
  const text = typeof p.content === "string" ? p.content : "";
  const media = typeof p.media_url === "string" && /^https:\/\//.test(p.media_url) ? p.media_url : undefined;
  if (!text.trim() && !media) return undefined;
  return {
    id: `sendblue:${fromNumber}:${p.message_handle}`,
    channel,
    conversationKey: `${channel}:sendblue:${fromNumber}:${p.from_number}`,
    from: p.from_number,
    text,
    ...(media ? { attachments: [{ url: media }] } : {}),
    replyRef: { messageId: p.message_handle, from: p.from_number, fromNumber },
    receivedAt: typeof p.date_sent === "string" && Number.isFinite(Date.parse(p.date_sent)) ? p.date_sent : new Date().toISOString(),
    source: "webhook",
    meta: { provider: "sendblue", service: p.service, isGroup: false, conversationScopeKnown: true },
  };
}

export interface SendblueOptions extends SendblueSettings {
  fetchImpl?: typeof fetch;
  state?: Pick<StateDir, "readJson" | "writeJson">;
}
type SendContext = { principal: Principal; conversationKey: string };

/** No automatic POST retries: a timeout can mean the message was already sent. */
export class SendblueChannel implements Outbox {
  private readonly fetchImpl: typeof fetch;
  private readonly received = new Map<string, string>();
  constructor(private readonly opts: SendblueOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  private async request(path: string, body?: Record<string, unknown> | FormData, method = "POST"): Promise<Record<string, unknown>> {
    const multipart = body instanceof FormData;
    const res = await this.fetchImpl(`https://api.sendblue.com${path}`, {
      method,
      headers: { "sb-api-key-id": this.opts.apiKey, "sb-api-secret-key": this.opts.apiSecret, ...(multipart ? {} : { "content-type": "application/json" }) },
      body: multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`Sendblue ${path} failed (HTTP ${res.status}). Check credentials, verified contacts and account limits.`);
    let result: Record<string, unknown>;
    try { result = await res.json() as Record<string, unknown>; } catch { throw new Error(`Sendblue ${path} returned invalid JSON`); }
    if (!result || ["ERROR", "DECLINED", "FAILED"].includes(String(result.status)) || result.error_code) {
      throw new Error(`Sendblue ${path} rejected the request. Check message status in the Sendblue dashboard.`);
    }
    return result;
  }

  private recipient(msg: Pick<OutboundMessage, "to" | "conversationKey">): string {
    if (Array.isArray(msg.to) && msg.to.length !== 1) throw new Error("Sendblue supports one recipient per message; group messaging is not enabled here");
    const explicit = Array.isArray(msg.to) ? msg.to[0] : msg.to;
    const key = parseConversationKey(msg.conversationKey);
    const prefix = `sendblue:${this.opts.fromNumber}:`;
    const number = explicit ?? (key.id.startsWith(prefix) ? key.id.slice(prefix.length) : key.id);
    if (!isPhone(number)) throw new Error("Sendblue needs an E.164 recipient or a Sendblue conversation key");
    return number;
  }

  async send(msg: OutboundMessage, _ctx: SendContext): Promise<void> {
    if (msg.channel !== "imessage" && msg.channel !== "sms") throw new Error(`Sendblue cannot deliver ${msg.channel}; configure Inkbox for email and A2A`);
    const number = this.recipient(msg);
    const chunks = splitMessageText(msg.text);
    const media = msg.mediaUrls ?? [];
    for (let i = 0; i < Math.max(chunks.length, media.length); i++) {
      const result = await this.request("/api/send-message", {
        from_number: this.opts.fromNumber, number,
        ...(chunks[i] ? { content: chunks[i] } : {}),
        ...(media[i] ? { media_url: media[i] } : {}),
        ...(i === 0 && msg.sendStyle && msg.channel === "imessage" ? { send_style: msg.sendStyle } : {}),
        ...(i === 0 && msg.replyToMessageId && msg.channel === "imessage" ? { reply_to: { message_handle: msg.replyToMessageId } } : {}),
      });
      if (typeof result.message_handle !== "string" || !result.message_handle) throw new Error("Sendblue did not return a message handle; delivery is unconfirmed");
    }
  }

  async sendFile(file: FileSend, ctx: SendContext): Promise<FileSendResult> {
    if (file.channel === "email") throw new Error("Sendblue does not send email; configure Inkbox");
    this.recipient(file);
    // A 5 MB cap also fits SMS fallback, which Sendblue selects automatically.
    if (file.content.length > 5 * 1024 * 1024) throw new Error("Sendblue attachments are capped at 5 MB here to allow SMS fallback");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.content)], { type: file.contentType }), file.filename);
    const uploaded = await this.request("/api/upload-file", form);
    if (typeof uploaded.media_url !== "string" || !uploaded.media_url.startsWith("https://")) throw new Error("Sendblue upload returned no HTTPS media URL");
    await this.send({ channel: file.channel, to: file.to, conversationKey: file.conversationKey, text: file.caption ?? "", mediaUrls: [uploaded.media_url] }, ctx);
    return { channel: file.channel, mediaUrl: uploaded.media_url };
  }

  remember(msg: InboundMessage): void {
    if (msg.meta?.provider !== "sendblue" || !msg.replyRef.messageId) return;
    this.opts.state?.writeJson(this.receivedFile(msg.replyRef.messageId), { messageId: msg.replyRef.messageId, conversationKey: msg.conversationKey });
    this.received.set(msg.replyRef.messageId, msg.conversationKey);
    if (this.received.size > 1000) this.received.delete(this.received.keys().next().value!);
  }

  private receivedFile(messageId: string): string {
    const hash = createHash("sha256").update(`${this.opts.fromNumber}\n${messageId}`).digest("hex");
    return `sendblue/received/${hash}.json`;
  }

  async typing(conversationKey: string): Promise<void> {
    if (parseConversationKey(conversationKey).channel !== "imessage") return;
    await this.request("/api/send-typing-indicator", { from_number: this.opts.fromNumber, number: this.recipient({ conversationKey }) });
  }

  async react(conversationKey: string, messageId: string, reaction: string): Promise<void> {
    const saved = this.opts.state?.readJson<{ messageId: string; conversationKey: string } | null>(this.receivedFile(messageId), null);
    const receivedKey = this.received.get(messageId) ?? (saved?.messageId === messageId ? saved.conversationKey : undefined);
    if (parseConversationKey(conversationKey).channel !== "imessage" || receivedKey !== conversationKey) throw new Error("The reaction target must be a received iMessage in the current conversation");
    await this.request("/api/send-reaction", { from_number: this.opts.fromNumber, message_handle: messageId, reaction });
  }

  /** Append one line-scoped subscription. Never replace other account webhooks. */
  async subscribe(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("The Sendblue webhook must be a public HTTPS URL without credentials or a fragment");
    const matchingHooks = async () => {
      const existing = await this.request("/api/account/webhooks", undefined, "GET");
      const subscriptions = (existing.webhooks as { receive?: unknown[] } | undefined)?.receive ?? [];
      return subscriptions.map((entry) => typeof entry === "string" ? { url: entry } : entry as { url?: string; secret?: string; sendblue_numbers?: string[] } | null)
        .filter((hook) => hook?.url === parsed.toString());
    };
    const validate = (hooks: Awaited<ReturnType<typeof matchingHooks>>) => {
      if (hooks.length > 1) throw new Error("Duplicate receive subscriptions exist for this URL. Remove duplicates in Sendblue's webhook settings, then retry connect.");
      const hook = hooks[0];
      if (hook && !(hook.secret === this.opts.webhookSecret && hook.sendblue_numbers?.length === 1 && hook.sendblue_numbers[0] === this.opts.fromNumber)) {
        throw new Error("This receive URL already exists with different settings. Remove that URL in Sendblue's webhook settings before registering it again.");
      }
    };
    const before = await matchingHooks();
    validate(before);
    if (before.length) return;
    await this.request("/api/account/webhooks", { type: "receive", webhooks: [{ url: parsed.toString(), secret: this.opts.webhookSecret, sendblue_numbers: [this.opts.fromNumber] }] });
    // Separate hosts/data directories cannot share the CLI lock. Surface a racing
    // registration instead of claiming success or deleting another host's hook.
    const after = await matchingHooks();
    validate(after);
    if (!after.length) throw new Error("Sendblue webhook registration could not be confirmed; inspect account webhooks before retrying.");
  }
}
