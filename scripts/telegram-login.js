import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const rl = createInterface({ input: stdin, output: stdout });
const apiId = Number(process.env.TELEGRAM_API_ID || await rl.question('Telegram API ID: '));
const apiHash = process.env.TELEGRAM_API_HASH || await rl.question('Telegram API hash: ');
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
try {
  await client.start({
    phoneNumber: async () => await rl.question('Client phone number: '),
    phoneCode: async () => await rl.question('Telegram login code: '),
    password: async () => await rl.question('Two-step password, if prompted: '),
    onError: error => console.error(error.message)
  });
  const session = client.session.save();
  const stored = spawnSync('vercel', ['env', 'add', 'TELEGRAM_STRING_SESSION', 'production', '--sensitive', '--force'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: session, encoding: 'utf8'
  });
  if (stored.status !== 0) throw new Error('Could not store TELEGRAM_STRING_SESSION in Vercel; check `vercel whoami` and the linked project, then log in again');
  console.log(`\nStored TELEGRAM_STRING_SESSION in Vercel production (ends with ${session.slice(-4)}). Redeploy to apply it.`);
} finally { await client.disconnect(); rl.close(); }
