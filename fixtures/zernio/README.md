# Sanitized Zernio webhook fixtures

Shapes follow Zernio's OpenAPI spec (`WebhookPayloadMessage`, `WebhookPayloadMessageSent`,
`WebhookPayloadMessageDeliveryStatus`, `WebhookPayloadReaction`, conversation lifecycle payloads)
as published in the official SDK repositories (zernio-dev/zernio-python `openapi.yaml`).
All IDs, phone numbers and names are fake. These are **not captured live payloads**: no Zernio
webhook subscription for WhatsApp existed when this was built. Replace or extend them with
sanitized captures once the webhook is connected (see docs/SETUP.md, "Capture real fixtures").

Headers Zernio sends with every delivery: `X-Zernio-Event`, `X-Zernio-Event-Id` (dedupe key,
stable across retries) and `X-Zernio-Signature` (hex HMAC-SHA256 of the raw body).
