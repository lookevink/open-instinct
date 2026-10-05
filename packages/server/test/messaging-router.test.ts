import { expect, it, vi } from "vitest";
import type { MessagingChannel } from "@open-instinct/inkbox";
import { MessagingRouter } from "../src/messaging-router.js";

function transport(): MessagingChannel {
  return { send: vi.fn(async () => {}), sendFile: vi.fn(async (file) => ({ channel: file.channel })), typing: vi.fn(async () => {}), react: vi.fn(async () => {}) };
}
const ctx = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Owner" } as const, conversationKey: "chat:owner" };
it.each(["imessage", "sms"] as const)("keeps %s replies, files, typing and reactions on their originating transport", async (channel) => {
  const sendblue = transport(), inkbox = transport();
  const router = new MessagingRouter(sendblue, inkbox);
  for (const [key, destination, other] of [
    [`${channel}:inkbox-conversation`, inkbox, sendblue],
    [`${channel}:sendblue:+15550002222:+15550001111`, sendblue, inkbox],
  ] as const) {
    vi.clearAllMocks();
    const msg = { channel, conversationKey: key, text: "reply" };
    const file = { channel, conversationKey: key, filename: "test.txt", contentType: "text/plain", content: Buffer.from("test") };
    await router.send(msg, ctx);
    await router.sendFile(file, ctx);
    await router.typing(key);
    await router.react(key, "received-id", "like");
    expect(destination.send).toHaveBeenCalledWith(msg, ctx);
    expect(destination.sendFile).toHaveBeenCalledWith(file, ctx);
    expect(destination.typing).toHaveBeenCalledWith(key);
    expect(destination.react).toHaveBeenCalledWith(key, "received-id", "like");
    for (const fn of Object.values(other)) expect(fn).not.toHaveBeenCalled();
  }
});
it("prefers Sendblue for new phone destinations and preserves Inkbox email", async () => {
  const sendblue = transport(), inkbox = transport();
  const router = new MessagingRouter(sendblue, inkbox);
  const msg = { channel: "imessage" as const, to: "+15550001111", text: "new" };
  await router.send(msg, ctx);
  expect(sendblue.send).toHaveBeenCalledWith(msg, ctx);
  await router.send({ channel: "email", to: "owner@example.com", text: "email" }, ctx);
  expect(inkbox.send).toHaveBeenCalledOnce();
  expect(() => new MessagingRouter(sendblue).typing("imessage:inkbox-id")).toThrow(/No transport/);
  expect(() => new MessagingRouter(undefined, inkbox).typing("imessage:sendblue:+15550002222:+15550001111")).toThrow(/No transport/);
});
