import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateDir, defaultConfig } from "@open-instinct/core";
import { createHttpServer, listenTunnelServer } from "@open-instinct/server";
import type { HttpApp } from "@open-instinct/server";
import { computeInkboxSignature } from "@open-instinct/inkbox";
import { runDev } from "../src/commands/dev.js";
import { makeContext } from "../src/context.js";
import { tmpDir } from "./helpers.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

describe("dev tunnel boundary", () => {
  it("forwards only signed webhook routes, not the owner's chat, status or schedules", async () => {
    const dir = tmpDir();
    const incoming = vi.fn(async (msg) => ({ acked: true, conversationKey: msg.conversationKey, principal: { kind: "owner" as const, id: "owner", tier: "owner" as const, displayName: "Owner" } }));
    const app: HttpApp = { state: new StateDir(dir), config: defaultConfig(), scheduler: { toMaritimeSchedules: () => [] }, runtime: { handleInbound: incoming, stats: () => ({ conversations: 0, busy: 0 }) } };
    let target = "";
    const context = makeContext({ INSTINCT_DATA_DIR: dir, INKBOX_API_KEY: "test", INKBOX_AGENT_HANDLE: "test", INKBOX_SIGNING_KEY: "whsec_test" }, {
      stdout: () => {}, stderr: () => {}, installSignalHandlers: false,
      importServer: async () => ({
        boot: async () => app as never,
        createHttpServer: (a, opts) => { const s = createHttpServer(a as unknown as HttpApp, opts); servers.push(s); return s; },
        listenTunnelServer: async (a, opts) => { const s = await listenTunnelServer(a as unknown as HttpApp, opts); servers.push(s); return s; },
      }),
      connectTunnel: async (opts) => { target = opts.forwardTo; return { publicUrl: "https://agent.example.com", close: async () => {} }; },
    });
    await runDev(context, ["--port", "0", "--tunnel"]);
    expect(target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${target}/health`)).status).toBe(200);
    for (const path of ["/status", "/schedules"]) expect((await fetch(target + path)).status).toBe(404);
    expect((await fetch(`${target}/chat`, { method: "POST", body: JSON.stringify({ message: "hello" }) })).status).toBe(404);
    expect((await fetch(`${target}/webhooks/inkbox`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(incoming).not.toHaveBeenCalled();
    const body = JSON.stringify({ id: "event", event_type: "imessage.received", data: { message: { id: "message", conversation_id: "conversation", remote_number: "+12025550123", content: "hello", is_group: false } } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`${target}/webhooks/inkbox`, { method: "POST", body, headers: { "x-inkbox-request-id": "r", "x-inkbox-timestamp": timestamp, "x-inkbox-signature": computeInkboxSignature(body, "r", timestamp, "whsec_test") } });
    expect(response.status).toBe(204);
    await vi.waitFor(() => expect(incoming).toHaveBeenCalledOnce());
  });
});

it("starts the Sendblue webhook-only listener and keeps the owner API off it", async () => {
  const dir = tmpDir();
  const incoming = vi.fn(async (msg) => ({ acked: true, conversationKey: msg.conversationKey, principal: { kind: "owner" as const, id: "owner", tier: "owner" as const, displayName: "Owner" } }));
  const app: HttpApp = { state: new StateDir(dir), config: defaultConfig(), scheduler: { toMaritimeSchedules: () => [] }, runtime: { handleInbound: incoming, stats: () => ({ conversations: 0, busy: 0 }) } };
  const probe = createHttpServer(app, { env: {} });
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = (probe.address() as { port: number }).port;
  // Keep this probe as an owner listener until runDev joins the shared inbox.
  const context = makeContext({ INSTINCT_DATA_DIR: dir, SENDBLUE_API_KEY: "key", SENDBLUE_API_SECRET: "secret", SENDBLUE_FROM_NUMBER: "+15550002222", SENDBLUE_WEBHOOK_SECRET: "webhook" }, {
    stdout: () => {}, stderr: () => {}, installSignalHandlers: false,
    importServer: async () => ({
      boot: async () => app as never,
      createHttpServer: (a, opts) => {
        const s = createHttpServer(a as unknown as HttpApp, opts);
        servers.push(s);
        // Use a kernel-selected port without a port reservation race.
        const listen = s.listen.bind(s);
        s.listen = ((requested: number, host: string, cb: () => void) => listen(opts?.tunnelOnly ? 0 : requested, host, cb)) as typeof s.listen;
        return s;
      },
    }),
  });
  servers.push(probe);
  await runDev(context, ["--port", "0", "--webhook-port", String(port)]);
  const publicServer = servers.at(-1)!;
  const url = `http://127.0.0.1:${(publicServer.address() as { port: number }).port}`;
  expect((await fetch(url + "/health")).status).toBe(200);
  expect((await fetch(url + "/status")).status).toBe(404);
  expect((await fetch(url + "/chat", { method: "POST", body: "{}" })).status).toBe(404);
  expect((await fetch(url + "/webhooks/sendblue", { method: "POST", body: "{}" })).status).toBe(401);
  const event = { is_outbound: false, status: "RECEIVED", message_handle: "dev-fixture", from_number: "+15550001111", to_number: "+15550002222", content: "hello", service: "SMS" };
  expect((await fetch(url + "/webhooks/sendblue", { method: "POST", body: JSON.stringify(event), headers: { "sb-signing-secret": "webhook" } })).status).toBe(204);
  await vi.waitFor(() => expect(incoming).toHaveBeenCalledOnce());
});
