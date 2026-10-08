import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
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
  console.log('\nTELEGRAM_STRING_SESSION=' + client.session.save());
} finally { await client.disconnect(); rl.close(); }
