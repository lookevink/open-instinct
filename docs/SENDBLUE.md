# iMessage and SMS with Sendblue

Sendblue is an optional phone channel for an always-on, single-user Open Instinct
agent. No Inkbox account, Mac server, or paid dedicated number is needed to start.
Inkbox remains optional for email and agent-to-agent transport. If both lines are
configured, each conversation is answered on the line it arrived on. The existing
multi-user gateway and sleeping Maritime deployment use Inkbox and do not yet
relay Sendblue webhooks; `instinct deploy` rejects Sendblue configurations.

## 1. Create your free account

Install Node 22.19+ and pnpm 10, then build Open Instinct:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Use the official Sendblue CLI to create an account. Replace the example number
with **your personal mobile number**, not a Sendblue line:

```bash
npx -y @sendblue/cli@0.10.0 setup --phone +14155550100
```

Text the exact `SB SETUP ...` phrase it prints to the shared Sendblue number it
shows. This verifies your phone, creates the free account, assigns that shared
line, and saves `apiKey`, `apiSecret`, and `assignedNumber` in
`~/.sendblue/credentials.json`. No credit card is required. Account names are
optional. For an existing account, use `sendblue login` instead of creating another.

An agent operating without an interactive terminal can use `setup --phone
<your-phone> --no-wait`, relay the instructions to the human, then run `setup
--check`. Exit code 3 means verification is still pending; retry the check after
the human texts. Only the human can complete phone verification.

The free plan only routes messages for verified contacts. Phone setup verifies
its primary phone. For another contact, run `sendblue add-contact <phone>` and
have that person text the shared line first. A dedicated AI Agent line is a
separate paid plan; it is not a prerequisite for this quickstart.

## 2. Bind the account to your agent

```bash
export ANTHROPIC_API_KEY=...  # or configure another supported model provider
pnpm instinct init --name "Maria" --phone +14155550100 --sendblue
```

Use the same personal phone verified above. `--phone` identifies the agent's
owner and their permissions. `--sendblue` explicitly imports the CLI account;
it never silently uses a Sendblue login for an Inkbox-only agent. For credentials
saved elsewhere, add `--sendblue-credentials /absolute/path/credentials.json`.

Init copies the keys and line into `.instinct/secrets/sendblue.json` (mode 0600)
and generates a random webhook secret. It does not print secrets or put them in
`config.json`. Keep the data directory private and out of source control. Rerunning
init keeps the webhook secret. `dev` and `connect` load these saved settings.

Server operators can instead set all four environment variables:

- `SENDBLUE_API_KEY`
- `SENDBLUE_API_SECRET`
- `SENDBLUE_FROM_NUMBER` (the assigned Sendblue line, E.164)
- `SENDBLUE_WEBHOOK_SECRET` (a random secret, also used when registering the webhook)

Partial settings fail at startup. Environment credentials must be a complete set;
they are never mixed with a saved account's keys or number.

## 3. Receive messages locally

```bash
pnpm instinct dev --webhook-port 8081
```

The owner API stays on loopback port 8080. Port 8081 only serves health and webhook
routes. In another terminal, expose **port 8081** using an HTTPS tunnel such as
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/):

```bash
cloudflared tunnel --url http://127.0.0.1:8081
```

Install `cloudflared` using Cloudflare's instructions first. Use the public HTTPS
hostname it prints:

```bash
pnpm instinct connect --webhook-url https://YOUR-HOST.trycloudflare.com/webhooks/sendblue
```

This appends a `receive` webhook with a per-webhook secret and a line filter.
Existing account subscriptions are preserved. Repeating the same registration
is a no-op. Concurrent `connect` calls sharing the agent data directory are
locked so only one can register. A failed process can leave
`secrets/sendblue-register.lock`; remove it only after confirming that process
has stopped. Registration also checks the account again after posting and
reports duplicate URLs, including races from other hosts, for manual cleanup. A matching URL with a different secret or line filter is rejected;
remove that URL in Sendblue before registering the new settings. Every request must present the
matching `sb-signing-secret`; invalid secrets are rejected before parsing.
If your temporary tunnel hostname changes, register the new URL and remove the
old URL in Sendblue's Developer → Webhooks settings. Do not forward port 8080:
it contains the owner's chat and status API. `--tunnel` is Inkbox-specific.

Now text the assigned Sendblue number from your verified phone:

> Remember that I like window seats.

You should receive a reply and find the preference in `.instinct/memory/MEMORY.md`.
Send another message asking what you prefer. Try an SMS-capable contact after
verifying them too. `pnpm instinct connect` displays the number and a text link;
Sendblue does not need Inkbox's `connect @handle` text.

## Self-hosting and Docker

Keep one agent process running with persistent storage for its data directory.
For the raw server entrypoint or Docker, supply the four Sendblue variables plus
`INSTINCT_OWNER_PHONE`, `INSTINCT_OWNER_NAME`, and a model API key. The raw server
does not import your host's Sendblue CLI credentials.

Set `INSTINCT_WEBHOOK_PORT=8081`, publish only that listener through your HTTPS
reverse proxy, and route `/webhooks/sendblue` there. Keep the owner port private
or configure `INSTINCT_CHAT_TOKEN`. With the repository's Docker Compose file,
use the optional override:

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.sendblue.yml up --build agent
```

Put the environment in `deploy/.env` (see `deploy/.env.example`). This persists
agent state in the existing `agent-data` volume. To register the webhook, run
`instinct connect --webhook-url ...` locally with the **same** four Sendblue
variables, or create a receive subscription with the same secret in Sendblue.

## Behavior and recovery

- Direct conversations support iMessage and SMS/MMS. Sendblue selects the wire
  service automatically; the `sms` channel does not force an iMessage-capable
  recipient to SMS. Groups are ignored so group senders cannot acquire owner
  permissions or trigger replies to the wrong audience.
- Text replies, proactive `send_message` (subject to account/contact restrictions),
  typing indicators, and tapbacks use Sendblue for Sendblue conversations. Existing
  Inkbox conversations keep using Inkbox; new phone destinations prefer Inkbox.
  Reactions default to the current inbound message when no ID is supplied and
  require a received iMessage in the current conversation. Received-message
  ownership is saved in `sendblue/received/` so validation survives restarts.
  Incoming media is downloaded to `workspace/inbound/` using the shared bounded,
  public-URL downloader; the model gets a local path, or a visible URL fallback;
  outbound `send_file` uploads files and sends them as attachments, capped at
  5 MB to fit SMS fallback. Email requires Inkbox.
- Admission is written to the existing durable `inkbox-inbox.json` before HTTP
  acknowledgement. Sendblue IDs are namespaced and duplicate webhook deliveries
  do not rerun a completed turn. The historical filename is shared with Inkbox.
  The most recent 5,000 completed receipts are retained; older IDs become compact
  permanent SHA-256 tombstones in the same file, so late retries remain duplicates.
  Tombstones and reaction ownership records grow with message history and must be
  included in state backups. Upgrades cannot recover IDs already pruned by an older
  version; downgrading to that version also discards tombstones on its next write.
- A send accepted by the API is not proof of handset delivery. Inspect Sendblue's
  message status for `DELIVERED` or a terminal error when testing live.
- The owner-only `/status` includes `inkboxInbox` counts. `uncertain` means a model
  turn or external send failed after processing started, or the process stopped
  mid-turn. Inspect the account message status and the retained receipt before
  acting. The agent deliberately does not resend an uncertain message, which
  could duplicate a tool action or a delivered reply. After fixing the cause,
  send a new message. Do not blindly delete receipts or replay a whole turn.
- No reply: check the owner phone is verified, the public tunnel is running,
  the registered path/secret match, the receiving line matches
  `SENDBLUE_FROM_NUMBER`, and the model API key is valid. `401` is a wrong webhook
  secret; `503` is missing webhook configuration. Sendblue API `401` indicates
  wrong keys; `403` can indicate an unverified free-plan contact.

## Verification

```bash
pnpm check
pnpm --filter @open-instinct/server exec vitest run test/sendblue.test.ts
```

The integration test boots the real agent, delivers iMessage/SMS fixtures over
HTTP, verifies memory writes and durable queue completion, and observes outbound
HTTP requests at a local Sendblue fixture server. It uses a scripted model and
does not claim real Sendblue or carrier delivery. Complete the phone flow and
text the line above to validate your actual account and network.

API references: [setup](https://docs.sendblue.com/getting-started/quickstart/),
[receiving](https://docs.sendblue.com/getting-started/receiving-messages/),
[webhooks](https://docs.sendblue.com/getting-started/webhooks/),
[media](https://docs.sendblue.com/api-v2/media/).
