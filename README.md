# Ellips mail forwarder and Telegram archive

The Vercel backend polls the Yandex IMAP INBOX for new email, forwards the body and attachments to a Telegram group, and archives files from selected Telegram chats to the client's Google Drive and Sheet.

## Production environment

Set these in the isolated Vercel project. Keep all secret values out of Git and local `.env` files.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase state and logs; run `sql/schema.sql` once |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD` | Yandex IMAP over SSL; the password is an app password |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_EMAIL_CHAT_ID` | Email forwarding bot and group |
| `CRON_SECRET` | Shared secret for external poll routes, sent in `X-Cron-Secret` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | OAuth web client for the archive account |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes in base64 to encrypt the archive refresh token |
| `SETUP_SECRET` | Bearer token for `/api/oauth/start` |
| `TELEGRAM_ADMIN_IDS`, `TELEGRAM_WEBHOOK_SECRET` | Bot chat-management authorization |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_STRING_SESSION` | Client's read-only Telegram user session |

The old Gmail OAuth, Pub/Sub, and watch settings are unused. Only the Drive/Sheets account needs Google OAuth: call `POST /api/oauth/start` with `Authorization: Bearer <SETUP_SECRET>` and JSON `{"purpose":"archive"}`, then complete the returned link in the account that should own the archive.

## External scheduler

Create two cron-job.org jobs, each with method `GET`, every five minutes, and header `X-Cron-Secret: <CRON_SECRET>`:

- Email: `https://ellips-mail-archiver-dksu.vercel.app/api/poll/email`
- Telegram archive: `https://ellips-mail-archiver-dksu.vercel.app/api/poll/archive`

Both routes return HTTP 202 immediately. Vercel `waitUntil` runs the batch after that response. Check `message_log` and Vercel logs for actual completion or failure. No Vercel Hobby cron is configured.

## Email behavior

The first successful poll opens INBOX read-only, records the highest current UID and UIDVALIDITY, and forwards no older messages. Later polls process up to three new UIDs in order and persist the checkpoint after each message. A UIDVALIDITY change creates a new baseline to avoid forwarding old mail again. IMAP uses `EXAMINE` and never changes flags, moves, or deletes messages. A database claim keyed by the email's `Message-ID` deduplicates messages; a UIDVALIDITY/UID key is used only when `Message-ID` is absent. The existing `forwarded_emails.gmail_message_id` column stores that key for compatibility with the already-installed schema.

The Telegram body includes From, Subject, Date, and up to about 3,500 characters of plain text or stripped HTML. Attachments up to 50 MB are forwarded with their filenames; images under 10 MB use `sendPhoto`. Oversized attachments get a note. Raw emails above 70 MB get a summary and size note because they cannot be parsed safely in a serverless function.

If IMAP connection or login fails, the backend logs the error and posts a Telegram alert, throttled to one per hour. A new Yandex app password may take 2–3 hours to activate, so an early login failure is not evidence that the password is wrong.

## Telegram archive

Run `node scripts/telegram-login.js` locally when the client can provide the login code and optional two-step password, then set the resulting session only in Vercel. The userbot reads and downloads but never sends, edits, deletes, or marks messages read. The bot handles `/add_chat <id or @username>`, `/remove_chat <id>`, and `/list_chats` for IDs in `TELEGRAM_ADMIN_IDS`. Backfill and new files proceed in small resumable batches. Drive files go into `Telegram Files/<chat>` and rows into the chat's tab in `Telegram Archive`.

## Checks and limits

1. `GET /api/health` should return `{"ok":true}`.
2. Call the email poll once and confirm `app_state.imap_checkpoint` is created. That call is baseline only.
3. Send a new email with a PDF and image, poll again, and confirm each file appears once in the group. Check `forwarded_emails` and `message_log`.
4. Add a Telegram chat, poll the archive route, and check Drive and the Sheet. Post a new file and check the next poll.

Each background batch targets 38 seconds within Vercel's 60-second function limit. A `202` means accepted, not completed. A crash after Telegram accepts a send but before the database step is recorded can result in that step being sent again on retry. Large backlogs require multiple polls.
