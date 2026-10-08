# Ellips mail forwarder and Telegram archive

Standalone backend for `info@ellips.uz`. It receives Gmail Pub/Sub notifications, forwards new inbox messages to a new Telegram group, and polls a client's Telegram account for files to save in their Drive and Sheet.

## Prerequisites

- A **new** Telegram bot and a **new** email group, with the bot added as an admin.
- A **new** Supabase account and project. Run [sql/schema.sql](sql/schema.sql) in its SQL editor.
- A **new** Google Cloud project with Gmail, Drive, Sheets, and Pub/Sub APIs enabled. Configure an OAuth consent screen and web application client. Add the exact callback URL as an authorized redirect URI.
- A **new** Vercel **Pro** project with a unique name. Check the team's existing Vercel projects before creating it; do not link or reuse an earlier project. Pro is required for the 5 and 10 minute crons and 300 second function duration.
- A Telegram API ID/hash for the client's own account. Run the local login helper when the client can provide their Telegram login code and two-step password, if enabled.

Do not copy credentials, environment variables, tables, or project names from any earlier bot. Secrets belong only in the new Vercel project. No secret file should be committed.

## Environment

Copy [.env.example](.env.example) for the variable names and set each in the new Vercel project:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | New Supabase project, server-side access only |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes encoded as base64; encrypts the Google refresh token in `app_state` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | New Google OAuth web client |
| `GOOGLE_PUBSUB_TOPIC` | `projects/<new-project-id>/topics/<topic>` in the same Google project as the OAuth client |
| `GOOGLE_PUBSUB_AUDIENCE`, `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT` | Exact `/api/pubsub` URL and identity of the authenticated Pub/Sub push subscription |
| `GMAIL_ADDRESS` | `info@ellips.uz`; OAuth callback checks this mailbox |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_EMAIL_CHAT_ID` | New bot and new forwarding group |
| `TELEGRAM_ADMIN_IDS` | Comma-separated Telegram user IDs allowed to manage archive chats |
| `TELEGRAM_WEBHOOK_SECRET` | Random secret for Telegram webhook verification |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_STRING_SESSION` | Client's Telegram user session; download-only code path |
| `CRON_SECRET` | Random bearer secret automatically supplied by Vercel cron |
| `SETUP_SECRET` | Random bearer secret for one-time Google OAuth link generation |

Generate independent random values for `CRON_SECRET`, `SETUP_SECRET`, and `TELEGRAM_WEBHOOK_SECRET`. Generate `TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 32`. Never put these values in URLs, chat messages, or the repository.

## Setup sequence

1. Create all new projects and verify the proposed Vercel name is unused among the team's projects. Run the SQL schema. Deploy this folder to the new Vercel project and set all environment variables. Check `GET /api/health` returns `{"ok":true}`.
2. Create a Pub/Sub topic. Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on the topic. Create a **push** subscription pointing to `https://<deployment>/api/pubsub`; enable authenticated push using the new push service account and set its audience to the same exact URL. Give the Pub/Sub service agent permission to mint OIDC tokens for that account.
3. Request the one-time consent link with `POST /api/oauth/start` and `Authorization: Bearer <SETUP_SECRET>`. Open the returned URL in the client's browser and sign in as `info@ellips.uz`. The callback stores the refresh token encrypted in Supabase. The OAuth scopes are Gmail read-only, Drive file, and Sheets.
4. Run `node scripts/telegram-login.js` locally with the new Telegram API ID/hash, enter the client's phone, login code, and optional two-step password. Put the printed session in `TELEGRAM_STRING_SESSION` in Vercel, then clear the terminal history/output containing it.
5. Register the new bot webhook: call Telegram `setWebhook` with URL `https://<deployment>/api/telegram` and `secret_token` equal to `TELEGRAM_WEBHOOK_SECRET`. Add the bot as an admin of the new email group. Set `TELEGRAM_EMAIL_CHAT_ID` to that group's ID.
6. Invoke `GET /api/cron/watch` with `Authorization: Bearer <CRON_SECRET>` once after OAuth. Confirm `app_state.gmail_watch_expiration` is later than the current time. Vercel renews the watch daily.
7. From an ID in `TELEGRAM_ADMIN_IDS`, message the bot `/add_chat @username` or `/add_chat -100...`. For private chats without usernames, the chat must be among the user's recent dialogs. `/list_chats` shows status; `/remove_chat <id>` disables future polling. Backfill begins on the next `/api/cron/archive` poll and proceeds in batches of 30 messages per chat per run.

## Verification checklist

1. Send a fresh email with a PDF and an image to `info@ellips.uz`. Confirm one header/body message and one copy of each attachment appear in the email group. Check `forwarded_emails` and `message_log`.
2. Add one chat with an existing file. Invoke `/api/cron/archive`, then check the `Telegram Files/<chat>` Drive folder and that chat's tab in `Telegram Archive`. Confirm the Russian header is bold and frozen. Post a new file and confirm it appears after the next poll.
3. Invoke the watch endpoint again and verify `gmail_watch_expiration` advances. Check Vercel's cron logs the next day.

## Behavior and limits

- The userbot uses Telegram history reads and media downloads only. It does not send, edit, delete, or mark messages as read. The bot only sends command replies and forwarded emails.
- Each Gmail message and each Telegram message is claimed in Supabase before processing. Checkpoints prevent routine webhook and cron duplicates. There remains a narrow crash window between an external send/append and recording success in Supabase; an automatic retry can duplicate that step. Strict end-to-end exactly-once delivery is not possible across these external APIs without their own idempotency keys.
- Gmail history can expire. The Gmail cron periodically syncs, and a 404 triggers an inbox recovery scan from the last sync checkpoint with a one-day overlap. Large outages can require manual reconciliation.
- Telegram Bot API document uploads are limited to 50 MB. Images under 10 MB go through `sendPhoto`; larger ones through `sendDocument`. Oversized email attachments produce a note. The archiver currently refuses Telegram files over 50 MB to stay within serverless memory and duration limits.
- The archiver processes 30 messages per chat per poll. Long backfills need multiple polls. Vercel can delay cron executions; the schedule is not a precise delivery guarantee.
- Drive files and Sheet tabs are created in the client's OAuth account. Changing a chat title after its first archive does not rename existing folders or tabs.
