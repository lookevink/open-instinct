import { describe, expect, it, vi } from "vitest";
import { parseSendblueEvent, sendblueSettings, SendblueChannel, verifySendblueSecret } from "../src/index.js";

const line = "+15550002222";
const owner = "+15550001111";
const event = { is_outbound: false, status: "RECEIVED", message_handle: "in-1", from_number: owner, to_number: line, sendblue_number: line, number: owner, content: "hello", service: "iMessage", group_id: "", date_sent: "2026-10-05T12:00:00Z" };
const config = { apiKey: "test-key", apiSecret: "test-secret", fromNumber: line, webhookSecret: "test-webhook" };
const ctx = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Owner" } as const, conversationKey: `imessage:sendblue:${line}:${owner}` };

describe("Sendblue ingress", () => {
  it("maps iMessage and SMS, keeps ids stable and scopes conversations to the line", () => {
    expect(parseSendblueEvent(event, line)).toMatchObject({ id: `sendblue:${line}:in-1`, channel: "imessage", from: owner, conversationKey: ctx.conversationKey, text: "hello", meta: { isGroup: false, conversationScopeKnown: true } });
    expect(parseSendblueEvent({ ...event, service: "SMS" }, line)?.channel).toBe("sms");
    expect(parseSendblueEvent({ ...event, content: "", media_url: "https://example.com/photo.png" }, line)?.attachments).toEqual([{ url: "https://example.com/photo.png" }]);
  });
  it("ignores outbound callbacks, other lines, groups and malformed input", () => {
    for (const payload of [null, {}, { ...event, is_outbound: true }, { ...event, status: "DELIVERED" }, { ...event, sendblue_number: owner }, { ...event, group_id: "group" }, { ...event, message_type: "group" }, { ...event, message_handle: undefined }, { ...event, from_number: "owner" }]) expect(parseSendblueEvent(payload, line)).toBeUndefined();
  });
  it("fails closed without a webhook secret", () => {
    expect(verifySendblueSecret(undefined, undefined)).toBe(false);
    expect(verifySendblueSecret("secret", "wrong")).toBe(false);
    expect(verifySendblueSecret("secret", "secret")).toBe(true);
  });
  it("rejects incomplete settings instead of falling back to console", () => {
    expect(sendblueSettings({})).toBeUndefined();
    expect(() => sendblueSettings({ SENDBLUE_API_KEY: "test" })).toThrow(/SENDBLUE_API_SECRET/);
  });
});

describe("Sendblue outbound", () => {
  it("sends replies through the configured line with credentials in headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ status: "QUEUED", message_handle: "out-1" }));
    const channel = new SendblueChannel({ ...config, fetchImpl });
    await channel.send({ channel: "imessage", conversationKey: ctx.conversationKey, text: "reply" }, ctx);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.sendblue.com/api/send-message", expect.objectContaining({ headers: expect.objectContaining({ "sb-api-key-id": "test-key", "sb-api-secret-key": "test-secret" }), body: JSON.stringify({ from_number: line, number: owner, content: "reply" }) }));
  });
  it("surfaces HTTP and API-level errors without logging secrets or response bodies", async () => {
    for (const response of [Response.json({ apiKey: "sensitive" }, { status: 401 }), Response.json({ status: "ERROR", error_message: "sensitive" }), Response.json({ status: "DECLINED" })]) {
      const channel = new SendblueChannel({ ...config, fetchImpl: vi.fn().mockResolvedValue(response) });
      await expect(channel.send({ channel: "sms", to: owner, text: "hi" }, ctx)).rejects.toThrow(/Sendblue/);
    }
  });
  it("never treats an Inkbox conversation id as a phone number", async () => {
    const fetchImpl = vi.fn();
    const channel = new SendblueChannel({ ...config, fetchImpl });
    await expect(channel.send({ channel: "imessage", conversationKey: "imessage:inkbox-id", text: "hi" }, ctx)).rejects.toThrow(/recipient/);
    await expect(channel.send({ channel: "sms", to: [owner, line], text: "hi" }, ctx)).rejects.toThrow(/one recipient/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it("uploads a file before sending the returned media URL, and rejects oversized files before upload", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(Response.json({ status: "OK", media_url: "https://cdn.example/file.pdf" }))
    .mockResolvedValueOnce(Response.json({ status: "QUEUED", message_handle: "file-1" }));
  const channel = new SendblueChannel({ ...config, fetchImpl });
  const file = { channel: "imessage" as const, to: owner, filename: "brief.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-test"), caption: "Brief" };
  await channel.sendFile(file, ctx);
  expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.sendblue.com/api/upload-file");
  expect(fetchImpl.mock.calls[0]![1].body).toBeInstanceOf(FormData);
  expect(fetchImpl.mock.calls[0]![1].headers).not.toHaveProperty("content-type");
  expect(JSON.parse(fetchImpl.mock.calls[1]![1].body)).toMatchObject({ from_number: line, number: owner, content: "Brief", media_url: "https://cdn.example/file.pdf" });
  await expect(channel.sendFile({ ...file, content: Buffer.alloc(5 * 1024 * 1024 + 1) }, ctx)).rejects.toThrow(/5 MB/);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("sends typing only for iMessage and restricts reactions to the current inbound conversation", async () => {
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ status: "OK" })));
  const channel = new SendblueChannel({ ...config, fetchImpl });
  channel.remember(parseSendblueEvent(event, line)!);
  await channel.typing(`sms:sendblue:${line}:${owner}`);
  expect(fetchImpl).not.toHaveBeenCalled();
  await channel.typing(ctx.conversationKey);
  await channel.react(ctx.conversationKey, "in-1", "love");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  await expect(channel.react("imessage:other-thread", "in-1", "love")).rejects.toThrow(/current conversation/);
  await expect(channel.react(ctx.conversationKey, "someone-elses-message", "love")).rejects.toThrow(/current conversation/);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("registers once and refuses to overwrite a webhook with different settings", async () => {
  const url = "https://agent.example/webhooks/sendblue";
  const existing = { url, secret: config.webhookSecret, sendblue_numbers: [line] };
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ webhooks: { receive: [existing] } })));
  const channel = new SendblueChannel({ ...config, fetchImpl });
  await channel.subscribe(url);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0]![1].method).toBe("GET");
  existing.secret = "old-secret";
  await expect(channel.subscribe(url)).rejects.toThrow(/already exists/);
  expect(fetchImpl.mock.calls.every((c) => c[1].method === "GET")).toBe(true);
});
