/**
 * `instinct connect`: show how a human links their iMessage to the agent.
 * Inkbox runs a shared router number; texting `connect @handle` to it opens a
 * dedicated iMessage thread with the agent.
 */
import { SendblueChannel, sendblueSettings } from "@open-instinct/sendblue";
import { parse, str } from "../args.js";
import { loadSendblueEnv, withSendblueRegistrationLock } from "../sendblue.js";
import { fetchOf } from "../io.js";
import fs from "node:fs";
import path from "node:path";
import type { CliContext } from "../context.js";
import { CliError } from "../io.js";
import { makeProvisioner } from "../inkbox-client.js";
import { readSecrets } from "../secrets.js";
import { loadConfig } from "@open-instinct/core";

export interface ConnectTarget {
  apiKey: string;
  handle: string;
}

/** Decodes a data: URL into bytes. Returns undefined when the URL is not base64 PNG. */
export function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } | undefined {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl.trim());
  if (!m) return undefined;
  const mimeType = m[1]!;
  const payload = m[3]!;
  const bytes = m[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  return { mimeType, bytes };
}

export function resolveConnectTarget(ctx: CliContext): ConnectTarget {
  const secrets = readSecrets(ctx.dataDir);
  const apiKey = ctx.env.INKBOX_ADMIN_API_KEY ?? secrets?.apiKey ?? ctx.env.INKBOX_API_KEY;
  if (!apiKey) throw new CliError("No Inkbox key. Set INKBOX_ADMIN_API_KEY or run `instinct init` with it.");
  const handle = secrets?.handle ?? ctx.env.INKBOX_AGENT_HANDLE ?? loadConfig(ctx.state(), ctx.env).agent.handle;
  if (!handle) throw new CliError("No agent handle. Run `instinct init --handle <handle>` first.");
  return { apiKey, handle };
}

export async function printConnect(ctx: CliContext, target: ConnectTarget, qrFile?: string): Promise<void> {
  const provisioner = makeProvisioner(ctx.io, ctx.env, target.apiKey);
  const info = await provisioner.routerInfo();
  const { c } = ctx;
  const command = info.connectCommand || `connect @${target.handle}`;
  ctx.print();
  ctx.print(c.bold("Connect your iMessage"));
  ctx.print(`  1. Text ${c.cyan(command)} to ${c.cyan(info.number)}`);
  ctx.print(`  2. A new thread from your Instinct appears. Say hi.`);
  if (info.smsLink) ctx.print(`  Tap-to-text link: ${info.smsLink}`);
  if (qrFile && info.qrPngDataUrl) {
    const decoded = decodeDataUrl(info.qrPngDataUrl);
    if (decoded) {
      fs.mkdirSync(path.dirname(qrFile), { recursive: true });
      fs.writeFileSync(qrFile, decoded.bytes);
      ctx.print(`  QR code written to ${qrFile}`);
    }
  }
}

export async function runConnect(ctx: CliContext, _argv: string[]): Promise<number> {
  const { values } = parse("connect", _argv, { "webhook-url": { type: "string" } });
  loadSendblueEnv(ctx.env, ctx.dataDir);
  const settings = sendblueSettings(ctx.env);
  const webhookUrl = str(values, "webhook-url");
  if (settings) {
    if (webhookUrl) {
      if (new URL(webhookUrl).pathname !== "/webhooks/sendblue") throw new CliError("The webhook URL must end in /webhooks/sendblue");
      await withSendblueRegistrationLock(ctx.dataDir, () => new SendblueChannel({ ...settings, fetchImpl: fetchOf(ctx.io) }).subscribe(webhookUrl));
      ctx.print("Sendblue receive webhook registered with a secret and line filter.");
    } else {
      ctx.print("Register your public listener with `instinct connect --webhook-url https://<host>/webhooks/sendblue`.");
    }
    ctx.print(`Text ${settings.fromNumber} from your verified owner phone. No connect @handle command is needed.`);
    ctx.print(`Tap-to-text link: sms:${settings.fromNumber}`);
    ctx.print("Free plan: additional recipients need `sendblue add-contact <phone>` and must text this line first.");
    return 0;
  }
  if (webhookUrl) throw new CliError("--webhook-url requires Sendblue. Run init --sendblue first.");
  const target = resolveConnectTarget(ctx);
  await printConnect(ctx, target, path.join(ctx.dataDir, "connect-qr.png"));
  return 0;
}
