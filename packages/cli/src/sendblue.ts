import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { sendblueSettings, type SendblueSettings } from "@open-instinct/sendblue";

const keys = { apiKey: "SENDBLUE_API_KEY", apiSecret: "SENDBLUE_API_SECRET", fromNumber: "SENDBLUE_FROM_NUMBER", webhookSecret: "SENDBLUE_WEBHOOK_SECRET" } as const;
const savedPath = (dataDir: string): string => path.join(dataDir, "secrets", "sendblue.json");

export function loadSendblueEnv(env: NodeJS.ProcessEnv, dataDir: string): void {
  const file = savedPath(dataDir);
  if (!fs.existsSync(file)) return;
  let saved: SendblueSettings;
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("Invalid saved Sendblue credentials; rerun init --sendblue"); }
  if (!saved || typeof saved !== "object") throw new Error("Invalid saved Sendblue credentials; rerun init --sendblue");
  // Do not mix a different account's environment credentials with saved credentials.
  if (env.SENDBLUE_API_KEY || env.SENDBLUE_API_SECRET || env.SENDBLUE_FROM_NUMBER) return;
  for (const [field, key] of Object.entries(keys)) {
    const value = saved[field as keyof SendblueSettings];
    if (typeof value !== "string") throw new Error(`Invalid saved Sendblue setting: ${key}`);
    env[key] ??= value;
  }
  sendblueSettings(env);
}

/** Explicit opt-in to importing the official CLI login. Secrets never enter config.json or output. */
export function importSendblueCredentials(env: NodeJS.ProcessEnv, dataDir: string, credentialsFile?: string): SendblueSettings {
  let settings: SendblueSettings;
  const previousEnv: NodeJS.ProcessEnv = {};
  // Reimporting the same account must not invalidate its registered webhook.
  try { loadSendblueEnv(previousEnv, dataDir); } catch { /* An explicit import can repair a corrupt saved file. */ }
  const webhookSecretFor = (apiKey: string): string => env.SENDBLUE_WEBHOOK_SECRET ||
    (previousEnv.SENDBLUE_API_KEY === apiKey ? previousEnv.SENDBLUE_WEBHOOK_SECRET : undefined) || randomBytes(32).toString("hex");
  if (env.SENDBLUE_API_KEY || env.SENDBLUE_API_SECRET || env.SENDBLUE_FROM_NUMBER) {
    settings = sendblueSettings({ ...env, SENDBLUE_WEBHOOK_SECRET: webhookSecretFor(env.SENDBLUE_API_KEY ?? "") })!;
  } else if (!credentialsFile && fs.existsSync(savedPath(dataDir))) {
    loadSendblueEnv(env, dataDir);
    settings = sendblueSettings(env)!;
  } else {
    const file = credentialsFile ?? path.join(os.homedir(), ".sendblue", "credentials.json");
    if (!fs.existsSync(file)) throw new Error("No Sendblue credentials. Run `npx -y @sendblue/cli@0.10.0 setup --phone <your-phone>` and send the verification text, then rerun init --sendblue.");
    let saved: Record<string, unknown>;
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("Invalid Sendblue credentials file"); }
    const values = [saved?.apiKey, saved?.apiSecret, saved?.assignedNumber];
    if (values.some((v) => typeof v !== "string" || !v.trim())) throw new Error("Sendblue credentials must contain apiKey, apiSecret and assignedNumber. Finish `sendblue setup --check` first.");
    settings = sendblueSettings({ SENDBLUE_API_KEY: saved.apiKey as string, SENDBLUE_API_SECRET: saved.apiSecret as string, SENDBLUE_FROM_NUMBER: saved.assignedNumber as string, SENDBLUE_WEBHOOK_SECRET: webhookSecretFor(saved.apiKey as string) })!;
  }
  const file = savedPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  for (const [field, key] of Object.entries(keys)) env[key] = settings[field as keyof SendblueSettings];
  return settings;
}
