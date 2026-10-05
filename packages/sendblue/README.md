# @open-instinct/sendblue

Sendblue phone transport. `SendblueChannel` implements the runtime outbox and
messaging-tool interface. `parseSendblueEvent` accepts direct incoming messages
on the configured line; `verifySendblueSecret` verifies the shared header secret.
`sendblueSettings` validates the four required environment variables.

The server composes it with optional Inkbox email/A2A delivery and the existing
durable inbox. See [the setup guide](../../docs/SENDBLUE.md) for free-account
onboarding, webhook registration, running locally, and supported deployments.
