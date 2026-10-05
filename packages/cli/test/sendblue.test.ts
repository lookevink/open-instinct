import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { run, tmpDir } from "./helpers.js";
import { loadSendblueEnv } from "../src/sendblue.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("imports a free CLI account, persists secrets privately, and registers a line-scoped webhook", async () => {
  const dir = tmpDir(); dirs.push(dir);
  const credentials = path.join(dir, "cli-credentials.json");
  fs.writeFileSync(credentials, JSON.stringify({ apiKey: "test-key", apiSecret: "test-secret", assignedNumber: "+15550002222", plan: "free_api" }));
  const data = path.join(dir, "agent");
  const result = await run(["init", "--name", "Owner", "--phone", "+15550001111", "--sendblue", "--sendblue-credentials", credentials, "--data-dir", data]);
  expect(result.code).toBe(0);
  expect(result.out + result.err).not.toContain("test-secret");
  const file = path.join(data, "secrets/sendblue.json");
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const secret = JSON.parse(fs.readFileSync(file, "utf8")).webhookSecret;
  expect(secret).toHaveLength(64);
  expect(fs.readFileSync(path.join(data, "config.json"), "utf8")).not.toContain("test-key");
  const hook = { url: "https://agent.example/webhooks/sendblue", secret, sendblue_numbers: ["+15550002222"] };
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(Response.json({ webhooks: { receive: [] } }))
    .mockResolvedValueOnce(Response.json({ status: "OK" }))
    .mockResolvedValueOnce(Response.json({ webhooks: { receive: [hook] } }));
  const connect = await run(["connect", "--webhook-url", "https://agent.example/webhooks/sendblue", "--data-dir", data], {}, { fetchImpl });
  expect(connect.code).toBe(0);
  expect(connect.out).toContain("+15550002222");
  expect(JSON.parse(fetchImpl.mock.calls[1]![1].body)).toEqual({ type: "receive", webhooks: [{ url: "https://agent.example/webhooks/sendblue", secret, sendblue_numbers: ["+15550002222"] }] });
  const again = await run(["init", "--name", "Owner", "--sendblue", "--data-dir", data]);
  expect(again.code).toBe(0);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).webhookSecret).toBe(secret);
  const env: NodeJS.ProcessEnv = { SENDBLUE_API_KEY: "another-account" };
  expect(() => loadSendblueEnv(env, data)).toThrow(/SENDBLUE_API_SECRET/);
  expect(env.SENDBLUE_API_SECRET).toBeUndefined();
});

it("explains missing credentials, refuses incomplete env and unsafe webhook URLs", async () => {
  const dir = tmpDir(); dirs.push(dir);
  const init = await run(["init", "--name", "Owner", "--sendblue", "--sendblue-credentials", path.join(dir, "missing"), "--data-dir", dir]);
  expect(init.code).toBe(1);
  expect(init.err).toContain("setup --phone");
  const env = { SENDBLUE_API_KEY: "key", SENDBLUE_API_SECRET: "secret", SENDBLUE_FROM_NUMBER: "+15550002222", SENDBLUE_WEBHOOK_SECRET: "webhook" };
  const fetchImpl = vi.fn();
  const bad = await run(["connect", "--webhook-url", "http://agent.example/webhooks/sendblue", "--data-dir", dir], env, { fetchImpl });
  expect(bad.code).toBe(1);
  expect(fetchImpl).not.toHaveBeenCalled();
  const partial = await run(["dev", "--data-dir", dir], { SENDBLUE_API_KEY: "key" });
  expect(partial.code).toBe(1);
  expect(partial.err).toContain("SENDBLUE_API_SECRET");
});

it("rejects a webhook-secret-only override without mixing in saved account settings", () => {
  const dir = tmpDir(); dirs.push(dir);
  fs.mkdirSync(path.join(dir, "secrets"));
  fs.writeFileSync(path.join(dir, "secrets/sendblue.json"), JSON.stringify({ apiKey: "saved-key", apiSecret: "saved-secret", fromNumber: "+15550002222", webhookSecret: "registered-secret" }));
  const env: NodeJS.ProcessEnv = { SENDBLUE_WEBHOOK_SECRET: "different-secret" };
  expect(() => loadSendblueEnv(env, dir)).toThrow(/SENDBLUE_API_KEY/);
  expect(env).toEqual({ SENDBLUE_WEBHOOK_SECRET: "different-secret" });
  const complete = { SENDBLUE_API_KEY: "other-key", SENDBLUE_API_SECRET: "other-secret", SENDBLUE_FROM_NUMBER: "+15550003333", SENDBLUE_WEBHOOK_SECRET: "other-webhook" };
  fs.writeFileSync(path.join(dir, "secrets/sendblue.json"), "broken saved JSON");
  expect(() => loadSendblueEnv(complete, dir)).not.toThrow();
});

it("refuses overlapping connect calls before duplicate subscription requests and releases the lock", async () => {
  const dir = tmpDir(); dirs.push(dir);
  const env = { SENDBLUE_API_KEY: "key", SENDBLUE_API_SECRET: "secret", SENDBLUE_FROM_NUMBER: "+15550002222", SENDBLUE_WEBHOOK_SECRET: "webhook" };
  const url = "https://agent.example/webhooks/sendblue";
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let posted = false;
  const fetchImpl = vi.fn(async (_url, init) => {
    await gate;
    if (init.method === "POST") { posted = true; return Response.json({ status: "OK" }); }
    return Response.json({ webhooks: { receive: posted ? [{ url, secret: "webhook", sendblue_numbers: [env.SENDBLUE_FROM_NUMBER] }] : [] } });
  });
  const args = ["connect", "--webhook-url", url, "--data-dir", dir];
  const first = run(args, env, { fetchImpl });
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  const overlapping = await run(args, env, { fetchImpl });
  expect(overlapping.code).toBe(1);
  expect(overlapping.err).toContain("already locked");
  release();
  expect((await first).code).toBe(0);
  expect((await run(args, env, { fetchImpl })).code).toBe(0);
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, "secrets/sendblue-register.lock"))).toBe(false);
});
