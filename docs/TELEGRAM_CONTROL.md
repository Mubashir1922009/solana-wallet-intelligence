# Telegram shadow control

Configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_USER_ID`, and `TELEGRAM_WEBHOOK_SECRET`. Register the HTTPS webhook separately using Telegram's `secret_token`; the application checks `X-Telegram-Bot-Api-Secret-Token` and then checks both chat and sender.

Exit notifications can carry `SELL SHADOW NOW`, `WAIT`, `RECALCULATE`, `MANUAL CONTROL`/`RETURN CONTROL`, and `OPEN DASHBOARD`. Callback data contains only an unguessable compact nonce. Its hash, position, action, expected state, and expiry are persisted. Duplicate updates, expired nonces, wrong state, wrong user/chat, and bad webhook secrets are rejected and audited. The callback query is acknowledged promptly.

`SELL SHADOW NOW` calls the same `PaperPositionService` as the dashboard and closes only the simulated record. There is no signing, transaction creation, or broadcast path.

The [Telegram Bot API](https://core.telegram.org/bots/api) documents the webhook secret header, 1–64 byte callback data, and callback-query acknowledgement.
