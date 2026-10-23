import crypto from 'node:crypto';
import { google } from 'googleapis';
import { utils } from 'telegram';
import { waitUntil } from '@vercel/functions';
import { db, env, ok, state, setState, log, oauth, oauthScopes, encrypt, pollArchive, telegramBot, userbot, describeDialogs } from '../src/core.js';
import { pollImap } from '../src/imap.js';

const reply = (res, code, body) => res.status(code).json(body);
const authorized = (req, secret) => Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
export const schedulerAuthorized = (req, secret) => {
  const supplied = req.headers['x-cron-secret'];
  if (!secret || typeof supplied !== 'string') return false;
  const expectedHash = crypto.createHash('sha256').update(secret).digest();
  const suppliedHash = crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(expectedHash, suppliedHash);
};

async function botCommand(req) {
  if (req.headers['x-telegram-bot-api-secret-token'] !== env('TELEGRAM_WEBHOOK_SECRET')) throw new Error('Unauthorized Telegram webhook');
  const message = req.body?.message;
  if (!message?.text) return { ignored: true };
  const from = String(message.from?.id || '');
  if (!env('TELEGRAM_ADMIN_IDS').split(',').map(x => x.trim()).includes(from)) return { ignored: true };
  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = rawCommand.split('@')[0];
  const respond = result => telegramBot('sendMessage', { chat_id: message.chat.id, text: result });
  if (command === '/list_chats') {
    const rows = ok(await db().from('archived_chats').select('chat_id,title,last_message_id,active').order('added_at'));
    await respond(rows.length ? rows.map(c => `${c.active ? '●' : '○'} ${c.title} (${c.chat_id}), last ${c.last_message_id}`).join('\n') : 'No chats configured.');
    return { listed: rows.length };
  }
  if (command === '/remove_chat') {
    if (!args[0]) { await respond('Usage: /remove_chat <id>'); return { invalid: true }; }
    const row = ok(await db().from('archived_chats').update({ active: false }).eq('chat_id', args[0]).select('chat_id').maybeSingle());
    await respond(row ? `Removed ${args[0]}` : 'Chat not found');
    return { removed: !!row };
  }
  if (command === '/add_chat') {
    if (!args[0]) { await respond('Usage: /add_chat <id or @username>'); return { invalid: true }; }
    let client;
    try {
      client = await userbot();
      const target = args[0];
      const dialogs = await client.getDialogs({ limit: 500 });
      const found = dialogs.find(d => target.startsWith('@')
        ? d.entity?.username?.toLowerCase() === target.slice(1).toLowerCase()
        : String(utils.getPeerId(d.entity)) === target);
      if (!found) throw new Error('Chat is not among the user account’s existing chats. Only chats the account is already in can be archived.');
      const entity = found.entity;
      const chatId = String(utils.getPeerId(entity));
      const title = entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || chatId;
      const existing = ok(await db().from('archived_chats').select('chat_id').eq('chat_id', chatId).maybeSingle());
      if (existing) ok(await db().from('archived_chats').update({ active: true, title, username: entity.username || null }).eq('chat_id', chatId));
      else ok(await db().from('archived_chats').insert({ chat_id: chatId, title, username: entity.username || null }));
      await respond(`Added ${title} (${chatId}). Backfill starts on the next archive poll.`);
      await log('chat_add', 'success', chatId, { title });
      return { added: chatId };
    } finally { if (client) await client.disconnect(); }
  }
  return { ignored: true };
}

export default async function handler(req, res) {
  const path = req.url.split('?')[0];
  try {
    if (path === '/api/health' && req.method === 'GET') return reply(res, 200, { ok: true });
    if (path === '/api/oauth/start' && req.method === 'POST') {
      if (!authorized(req, process.env.SETUP_SECRET)) return reply(res, 401, { error: 'Unauthorized' });
      const purpose = req.body?.purpose;
      if (purpose !== 'archive') return reply(res, 400, { error: 'purpose must be archive' });
      const nonce = crypto.randomBytes(24).toString('hex');
      await setState(`oauth_nonce_${purpose}`, nonce);
      return reply(res, 200, { purpose, url: oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent select_account', scope: oauthScopes[purpose], state: `${purpose}.${nonce}` }) });
    }
    if (path === '/api/oauth/callback' && req.method === 'GET') {
      const [purpose, nonce] = String(req.query?.state || '').split('.');
      if (!Object.hasOwn(oauthScopes, purpose) || !req.query?.code || !nonce || nonce !== await state(`oauth_nonce_${purpose}`)) return reply(res, 403, { error: 'Invalid OAuth state' });
      await setState(`oauth_nonce_${purpose}`, 'used');
      const auth = oauth(); const { tokens } = await auth.getToken(req.query.code);
      if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
      auth.setCredentials(tokens);
      const account = (await google.drive({ version: 'v3', auth }).about.get({ fields: 'user(emailAddress)' })).data.user?.emailAddress;
      if (!account) throw new Error('Could not identify Google account');
      await setState(`${purpose}_refresh_token`, encrypt(tokens.refresh_token));
      await setState(`${purpose}_account_email`, account);
      await log('oauth_connect', 'success', account, { purpose });
      return res.status(200).send(`Drive and Sheets connected as ${account}. You can close this tab.`);
    }
    if (path === '/api/admin/chats' && req.method === 'GET') {
      if (!authorized(req, process.env.SETUP_SECRET)) return reply(res, 401, { error: 'Unauthorized' });
      const client = await userbot();
      try {
        const dialogs = await client.getDialogs({ limit: 500 });
        const count = req.query?.count;
        if (!count) return reply(res, 200, { chats: describeDialogs(dialogs).map((chat, index) => ({ n: index + 1, ...chat })) });
        const found = dialogs.find(d => String(utils.getPeerId(d.entity)) === String(count));
        if (!found) return reply(res, 404, { error: 'Chat not found' });
        return reply(res, 200, { id: String(count), totalMessages: await client.countMessages(found.entity) });
      } finally { await client.disconnect(); }
    }
    if (path === '/api/telegram' && req.method === 'POST') return reply(res, 200, await botCommand(req));
    if (path === '/api/poll/archive' && req.method === 'GET') {
      if (!schedulerAuthorized(req, process.env.CRON_SECRET)) return reply(res, 401, { error: 'Unauthorized' });
      waitUntil(pollArchive().catch(async error => {
        await log('archive_poll', 'failure', 'scheduler', { error: String(error) });
      }));
      return reply(res, 202, { accepted: true });
    }
    if (path === '/api/poll/email' && req.method === 'GET') {
      if (!schedulerAuthorized(req, process.env.CRON_SECRET)) return reply(res, 401, { error: 'Unauthorized' });
      waitUntil(pollImap().catch(async error => {
        await log('imap_poll', 'failure', 'scheduler', { error: String(error) });
      }));
      return reply(res, 202, { accepted: true });
    }
    return reply(res, 404, { error: 'Not found' });
  } catch (error) {
    try { await log('api_error', 'failure', path, { error: String(error) }); } catch {}
    return reply(res, /Unauthorized|Unexpected|Invalid OAuth/.test(String(error)) ? 401 : 500, { error: String(error) });
  }
}
