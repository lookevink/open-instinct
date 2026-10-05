import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { boot } from "../src/boot.js";
import { closeInkboxInbox, createHttpServer } from "../src/http.js";

it("processes authenticated iMessage/SMS over HTTP through durable admission, agent tools and the Sendblue transport", async () => {
  const data = mkdtempSync(join(tmpdir(), "instinct-sendblue-"));
  const received: Array<{ path: string; body: Record<string, unknown>; key: string | undefined }> = [];
  let failSend = false;
  const api = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ path: req.url!, body, key: req.headers["sb-api-key-id"] as string });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(failSend && req.url === "/api/send-message" ? { status: "ERROR" } : { status: "SENT", message_handle: `out-${received.length}` }));
  });
  await new Promise<void>((resolve, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", resolve); });
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const env = { INSTINCT_DATA_DIR: data, INSTINCT_OWNER_NAME: "Owner", INSTINCT_OWNER_PHONE: "+15550001111", INSTINCT_COMPUTER: "none", INSTINCT_SKILLS_DIR: join(data, "no-skills"), SENDBLUE_API_KEY: "test-key", SENDBLUE_API_SECRET: "test-secret", SENDBLUE_FROM_NUMBER: "+15550002222", SENDBLUE_WEBHOOK_SECRET: "test-webhook" };
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const options = {
    model: faux.getModel("faux-1"), streamFn: models.streamSimple.bind(models) as unknown as StreamFn,
    logger: () => {}, fetchImpl: ((url, init) => {
      const target = String(url);
      if (!target.startsWith("https://api.sendblue.com/")) throw new Error("Unexpected external request");
      return fetch(apiBase + new URL(target).pathname, init);
    }) as typeof fetch,
  };
  let app = await boot(env, options);
  let server = createHttpServer(app, { env, tunnelOnly: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (payload: unknown, secret = "test-webhook") => fetch(base + "/webhooks/sendblue", { method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": secret }, body: JSON.stringify(payload) });
  const receipts = () => JSON.parse(readFileSync(join(data, "inkbox-inbox.json"), "utf8")).receipts as Array<{ id: string; status: string }>;
  try {
    expect((await fetch(base + "/chat", { method: "POST", body: JSON.stringify({ message: "hi" }) })).status).toBe(404);
    expect((await fetch(base + "/status")).status).toBe(404);
    expect((await post({}, "wrong")).status).toBe(401);
    for (const [index, service] of ["iMessage", "SMS"].entries()) {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("memory_write", { text: `remember ${service}`, durable: true })], { stopReason: "toolUse" }),
        fauxAssistantMessage(`Reply via ${service}`),
      ]);
      const event = { is_outbound: false, status: "RECEIVED", message_handle: `in-${index}`, from_number: env.INSTINCT_OWNER_PHONE, to_number: env.SENDBLUE_FROM_NUMBER, sendblue_number: env.SENDBLUE_FROM_NUMBER, content: "Remember this", service };
      expect((await post(event)).status).toBe(204);
      expect((await post(event)).status).toBe(204);
      await expect.poll(() => receipts().find((r) => r.id.endsWith(`in-${index}`))?.status).toBe("done");
      const sends = received.filter((r) => r.path === "/api/send-message" && r.body.content === `Reply via ${service}`);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ key: "test-key", body: { from_number: env.SENDBLUE_FROM_NUMBER, number: env.INSTINCT_OWNER_PHONE } });
      expect(readFileSync(join(data, "memory/MEMORY.md"), "utf8")).toContain(`remember ${service}`);
    }
    const count = receipts().length;
    expect((await post({ is_outbound: true, status: "SENT", message_handle: "out-1" })).status).toBe(204);
    expect(receipts()).toHaveLength(count);
    expect(receipts().every((r) => r.status === "done")).toBe(true);
    // Restart from the same disk state and redeliver a completed webhook.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeInkboxInbox(app); await app.close();
    app = await boot(env, options);
    server = createHttpServer(app, { env, tunnelOnly: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const duplicate = { is_outbound: false, status: "RECEIVED", message_handle: "in-0", from_number: env.INSTINCT_OWNER_PHONE, to_number: env.SENDBLUE_FROM_NUMBER, content: "Remember this", service: "iMessage" };
    expect((await post(duplicate)).status).toBe(204);
    expect(receipts()).toHaveLength(count);
    expect(received.filter((r) => r.path === "/api/send-message")).toHaveLength(2);

    // An API-level send failure is retained for inspection, never marked done or blindly resent.
    failSend = true;
    faux.setResponses([fauxAssistantMessage("This send will fail")]);
    expect((await post({ ...duplicate, message_handle: "failed-send" })).status).toBe(204);
    await expect.poll(() => receipts().find((r) => r.id.endsWith("failed-send"))?.status).toBe("uncertain");
    expect((await post({ ...duplicate, message_handle: "failed-send" })).status).toBe(204);
    expect(received.filter((r) => r.path === "/api/send-message" && r.body.content === "This send will fail")).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeInkboxInbox(app); await app.close();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    rmSync(data, { recursive: true, force: true });
  }
}, 20_000);
