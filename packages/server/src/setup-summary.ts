/**
 * "What is set up right now": the one prompt section that stops the model from
 * guessing. Built fresh for every prompt from what boot actually wired.
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, type RegisteredTool, type ToolContext, type ToolResultLike } from "@open-instinct/core";

export interface SetupInput {
  sendblue?: { number: string };
  inkbox?: { handle: string };
  computerKind?: string;
  apps?: { connected: string[]; anyApp: boolean; toolkits: string[] };
  wallet?: { connected: boolean };
}

export function setupSummaryFor(input: SetupInput): string {
  const lines = ["# What is set up right now"];
  if (input.sendblue) {
    lines.push(`- Messaging: iMessage and SMS through Sendblue from ${input.sendblue.number}. Sendblue selects the delivery service automatically. Direct conversations only; send_file supports attachments up to 5 MB. Free shared-line accounts can only message verified contacts who texted the line first. ${input.inkbox ? "Inkbox also provides email and agent-to-agent messaging." : "Email and agent-to-agent transport are not configured."}`);
  } else if (input.inkbox) {
    lines.push(`- Messaging: yes. You reach the owner by iMessage and email through Inkbox as @${input.inkbox.handle} (SMS too when the identity has a phone number). Files go out as attachments with send_file.`);
  } else {
    lines.push("- Messaging: no Inkbox identity on this agent. Replies only reach the dashboard or terminal chat; there is no iMessage, SMS or email yet. To enable: the person running this agent sets INKBOX_API_KEY and INKBOX_AGENT_HANDLE (see docs/KEYS.md).");
  }
  if (input.computerKind === "desktopd") {
    lines.push("- Computer: yes, this agent's own Linux desktop (Chromium, LibreOffice). Logins, 2FA and payments on it go to the owner through request_takeover, which gives you a link to send.");
  } else if (input.computerKind === "maritime") {
    lines.push("- Computer: yes, a hosted desktop through Maritime Computers. request_takeover gives you a link to send when a human must step in.");
  } else {
    lines.push("- Computer: none. You cannot browse websites that need a login, book on the web, or hand over a screen. Research still works through web_search and web_fetch. To enable: run this agent on Maritime with a desktop, or set MARITIME_API_KEY.");
  }
  if (input.apps) {
    const on = input.apps.connected.length > 0 ? input.apps.connected.join(", ") : "none yet";
    const scope = input.apps.anyApp ? "any app by name" : `these toolkits: ${input.apps.toolkits.join(", ")}`;
    lines.push(`- Apps (Composio): yes, ${scope}. Connected: ${on}. For anything not connected, apps_connect returns a sign-in link to send the owner.`);
  } else {
    lines.push("- Apps: not set up. There is no Gmail, Calendar or other app access and no connect links. To enable: the person running this agent sets COMPOSIO_API_KEY (free key at composio.dev) and restarts; then apps_connect produces sign-in links.");
  }
  if (input.wallet) {
    lines.push(input.wallet.connected
      ? "- Payments: Stripe Link wallet connected. payment_request asks the owner to approve a one-time card for an exact amount."
      : "- Payments: Stripe Link is configured but the owner has not connected their wallet. payment_connect returns the link to send.");
  } else {
    lines.push("- Payments: not set up (no Link client). Purchases end with a desktop takeover so the owner pays themselves, or with you stopping at checkout.");
  }
  lines.push("- PDFs and files: yes. create_pdf writes a PDF in the workspace; send_file delivers any workspace file.");
  return lines.join("\n");
}

const CONNECT_PARAMS = Type.Object({
  toolkit: Type.String({ description: "App to connect, for example gmail, googlecalendar, notion, slack." }),
});

/** Stand-in for apps_connect when COMPOSIO_API_KEY is absent: one precise sentence, no invented screens. */
export function appsNotConfiguredTool(): RegisteredTool {
  return defineTool({
    name: "apps_connect",
    label: "Connect an app",
    description: "Get the sign-in link that connects an app (Gmail, Calendar, Notion, Slack, ...) for the owner. On this agent apps are not set up yet; the tool explains what is missing.",
    parameters: CONNECT_PARAMS,
    meta: { capabilities: ["apps.use"], group: "apps" },
    execute: async (args: Static<typeof CONNECT_PARAMS>, ctx: ToolContext): Promise<ToolResultLike> => {
      const who = ctx.principal.kind === "owner" ? "you" : "the owner";
      return `Apps are not set up on this agent, so there is no sign-in link for ${args.toolkit.trim() || "that app"} yet. Tell ${who} in one sentence: the person running the agent needs to set COMPOSIO_API_KEY (free at composio.dev) and restart it; after that you can text a link that connects ${args.toolkit.trim() || "the app"} in one tap.`;
    },
  });
}
