import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { utils } from 'telegram';
import { waitUntil } from '@vercel/functions';
import { db, env, ok, state, setState, log, oauth, scopes, encrypt, renewWatch, syncGmail, pollArchive, telegramBot, userbot } from '../src/core.js';

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
      let entity;
      if (target.startsWith('@')) entity = await client.getEntity(target);
      else {
        const dialogs = await client.getDialogs({ limit: 500 });
        const found = dialogs.find(d => String(utils.getPeerId(d.entity)) === target);
        if (!found) throw new Error('Chat ID is not in the user account’s recent dialogs. Use @username or open the chat in Telegram first.');
        entity = found.entity;
      }
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

async function verifyPubsub(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) throw new Error('Missing Pub/Sub OIDC token');
  const verifier = new OAuth2Client();
  const ticket = await verifier.verifyIdToken({ idToken: token, audience: env('GOOGLE_PUBSUB_AUDIENCE') });
  if (ticket.getPayload()?.email !== env('GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT')) throw new Error('Unexpected Pub/Sub service account');
  const data = req.body?.message?.data;
  if (!data) throw new Error('Missing Pub/Sub message');
  const notification = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  if (notification.emailAddress?.toLowerCase() !== env('GMAIL_ADDRESS').toLowerCase()) throw new Error('Unexpected mailbox');
  return notification;
}

export default async function handler(req, res) {
  const path = req.url.split('?')[0];
  try {
    if (path === '/api/health' && req.method === 'GET') return reply(res, 200, { ok: true });
    if (path === '/api/oauth/start' && req.method === 'POST') {
      if (!authorized(req, process.env.SETUP_SECRET)) return reply(res, 401, { error: 'Unauthorized' });
      const nonce = crypto.randomBytes(24).toString('hex');
      await setState('oauth_nonce', nonce);
      return reply(res, 200, { url: oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes, state: nonce }) });
    }
    if (path === '/api/oauth/callback' && req.method === 'GET') {
      if (!req.query?.code || req.query.state !== await state('oauth_nonce')) return reply(res, 403, { error: 'Invalid OAuth state' });
      await setState('oauth_nonce', 'used');
      const auth = oauth(); const { tokens } = await auth.getToken(req.query.code);
      if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
      auth.setCredentials(tokens);
      const profile = (await google.gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' })).data;
      if (profile.emailAddress?.toLowerCase() !== env('GMAIL_ADDRESS').toLowerCase()) throw new Error('Signed into the wrong Google account');
      await setState('google_refresh_token', encrypt(tokens.refresh_token));
      await log('oauth_connect', 'success', profile.emailAddress);
      return res.status(200).send('Google account connected. You can close this tab.');
    }
    if (path === '/api/pubsub' && req.method === 'POST') {
      await verifyPubsub(req);
      return reply(res, 200, await syncGmail());
    }
    if (path === '/api/telegram' && req.method === 'POST') return reply(res, 200, await botCommand(req));
    if (path === '/api/poll/archive' && req.method === 'GET') {
      if (!schedulerAuthorized(req, process.env.CRON_SECRET)) return reply(res, 401, { error: 'Unauthorized' });
      waitUntil(pollArchive().catch(async error => {
        await log('archive_poll', 'failure', 'scheduler', { error: String(error) });
      }));
      return reply(res, 202, { accepted: true });
    }
    if (path.startsWith('/api/cron/') && req.method === 'GET') {
      if (!authorized(req, process.env.CRON_SECRET)) return reply(res, 401, { error: 'Unauthorized' });
      if (path === '/api/cron/watch') return reply(res, 200, await renewWatch());
    }
    return reply(res, 404, { error: 'Not found' });
  } catch (error) {
    try { await log('api_error', 'failure', path, { error: String(error) }); } catch {}
    return reply(res, /Unauthorized|Unexpected|Invalid OAuth/.test(String(error)) ? 401 : 500, { error: String(error) });
  }
}
