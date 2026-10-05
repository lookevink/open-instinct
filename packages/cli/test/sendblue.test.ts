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
  const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ status: "OK", webhooks: { receive: [] } })));
  const connect = await run(["connect", "--webhook-url", "https://agent.example/webhooks/sendblue", "--data-dir", data], {}, { fetchImpl });
  expect(connect.code).toBe(0);
  expect(connect.out).toContain("+15550002222");
  expect(JSON.parse(fetchImpl.mock.calls[1]![1].body)).toEqual({ type: "receive", webhooks: [{ url: "https://agent.example/webhooks/sendblue", secret, sendblue_numbers: ["+15550002222"] }] });
  const again = await run(["init", "--name", "Owner", "--sendblue", "--data-dir", data]);
  expect(again.code).toBe(0);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).webhookSecret).toBe(secret);
  const env: NodeJS.ProcessEnv = { SENDBLUE_API_KEY: "another-account" };
  loadSendblueEnv(env, data);
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
