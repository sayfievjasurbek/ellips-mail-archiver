import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { TelegramClient, utils } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

export const oauthScopes = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
  archive: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/spreadsheets']
};
export const env = key => { const value = process.env[key]; if (!value) throw new Error(`Missing ${key}`); return value; };
const boundedFetch = (input, options = {}) => fetch(input, {
  ...options,
  signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000)
});
export const db = () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false }, global: { fetch: boundedFetch } });
export const ok = (result) => { if (result.error) throw result.error; return result.data; };
export const state = async key => (ok(await db().from('app_state').select('value').eq('key', key).maybeSingle()))?.value;
export const setState = async (key, value) => ok(await db().from('app_state').upsert({ key, value: String(value), updated_at: new Date().toISOString() }));
export const log = async (action, status, source_id, details = {}) => ok(await db().from('message_log').insert({ action, status, source_id: String(source_id || ''), details }));
export const claimJob = async (key, seconds = 600) => ok(await db().rpc('claim_job', { p_key: key, p_seconds: seconds }));
export const ARCHIVE_RUN_BUDGET_MS = 38_000;
export const ARCHIVE_MIN_START_MS = 18_000;
export const hasArchiveTime = (deadline, minimum = 0) => Date.now() + minimum < deadline;
export function rotateChats(chats, nextChatId) {
  const index = chats.findIndex(chat => chat.chat_id === nextChatId);
  return index < 0 ? chats : [...chats.slice(index), ...chats.slice(0, index)];
}
function googleTimeout(deadline, maximum = 10_000) {
  const remaining = deadline - Date.now();
  if (remaining <= 1_000) throw new Error('Archive run time budget reached');
  return { timeout: Math.min(maximum, remaining - 500) };
}

function cipherKey() { return Buffer.from(env('TOKEN_ENCRYPTION_KEY'), 'base64'); }
export function encrypt(text) {
  const key = cipherKey(); if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 base64 decoded bytes');
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function decrypt(text) {
  const raw = Buffer.from(text, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
export function oauth() { return new google.auth.OAuth2(env('GOOGLE_CLIENT_ID'), env('GOOGLE_CLIENT_SECRET'), env('GOOGLE_REDIRECT_URI')); }
export async function googleAuth(purpose) {
  if (!(purpose in oauthScopes)) throw new Error('Invalid Google OAuth purpose');
  const refresh = await state(`${purpose}_refresh_token`);
  if (!refresh) throw new Error(`${purpose} Google OAuth not connected`);
  const auth = oauth(); auth.setCredentials({ refresh_token: decrypt(refresh) }); return auth;
}
export const b64 = value => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
export const truncate = (value, max = 3500) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
export const stripHtml = html => html.replace(/<\s*(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
export function emailParts(root) {
  const parts = []; const walk = p => { if (p.parts?.length) p.parts.forEach(walk); else parts.push(p); }; walk(root || {});
  const body = parts.find(p => p.mimeType === 'text/plain' && p.body?.data) || parts.find(p => p.mimeType === 'text/html' && p.body?.data);
  const value = body ? b64(body.body.data).toString('utf8') : '';
  return { text: body?.mimeType === 'text/html' ? stripHtml(value) : value, attachments: parts.filter(p => p.filename && (p.body?.attachmentId || p.body?.data)) };
}
export function safeName(name) { return (name || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 180); }

export async function telegramBot(method, params = {}, file) {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) form.set(key, String(value));
  if (file) form.set(file.field, new Blob([file.bytes], { type: file.mime || 'application/octet-stream' }), safeName(file.name));
  const response = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, { method: 'POST', body: form });
  const result = await response.json(); if (!result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}
export async function forwardMessage(gmail, id) {
  const message = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
  const labels = message.labelIds || [];
  if (!labels.includes('INBOX') || labels.includes('SENT') || labels.includes('DRAFT')) return 'skipped';
  const claimed = ok(await db().rpc('claim_email', { p_id: id, p_thread: message.threadId }));
  if (!claimed) return 'duplicate';
  try {
    const row = ok(await db().from('forwarded_emails').select('sent_steps').eq('gmail_message_id', id).single());
    const sent = new Set(row.sent_steps || []);
    const mark = async step => {
      sent.add(step);
      ok(await db().from('forwarded_emails').update({ sent_steps: [...sent] }).eq('gmail_message_id', id));
    };
    const headers = Object.fromEntries((message.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
    const { text, attachments } = emailParts(message.payload);
    const summary = `From: ${headers.from || ''}\nSubject: ${headers.subject || '(no subject)'}\nDate: ${headers.date || ''}\n\n${truncate(text || '(no text body)')}`;
    if (!sent.has('body')) { await telegramBot('sendMessage', { chat_id: env('TELEGRAM_EMAIL_CHAT_ID'), text: summary }); await mark('body'); }
    for (const [index, part] of attachments.entries()) {
      const step = `attachment:${index}`;
      if (sent.has(step)) continue;
      if (Number(part.body.size || 0) > 50 * 1024 * 1024) {
        await telegramBot('sendMessage', { chat_id: env('TELEGRAM_EMAIL_CHAT_ID'), text: `Attachment too large to forward: ${safeName(part.filename)} (${(part.body.size / 1048576).toFixed(1)} MB)` });
        await mark(step); continue;
      }
      const bytes = part.body.data ? b64(part.body.data) : b64((await gmail.users.messages.attachments.get({ userId: 'me', messageId: id, id: part.body.attachmentId })).data.data);
      if (bytes.length > 50 * 1024 * 1024) {
        await telegramBot('sendMessage', { chat_id: env('TELEGRAM_EMAIL_CHAT_ID'), text: `Attachment too large to forward: ${safeName(part.filename)} (${(bytes.length / 1048576).toFixed(1)} MB)` });
      } else {
        const photo = part.mimeType?.startsWith('image/') && bytes.length < 10 * 1024 * 1024;
        await telegramBot(photo ? 'sendPhoto' : 'sendDocument', { chat_id: env('TELEGRAM_EMAIL_CHAT_ID'), ...(photo ? { caption: safeName(part.filename) } : {}) }, { field: photo ? 'photo' : 'document', bytes, name: part.filename, mime: part.mimeType });
      }
      await mark(step);
    }
    ok(await db().from('forwarded_emails').update({ status: 'done', forwarded_at: new Date().toISOString(), lease_until: null }).eq('gmail_message_id', id));
    await log('email_forward', 'success', id, { attachments: attachments.length });
    return 'forwarded';
  } catch (error) {
    await db().from('forwarded_emails').update({ status: 'failed', error: String(error), lease_until: null }).eq('gmail_message_id', id);
    await log('email_forward', 'failure', id, { error: String(error) }); throw error;
  }
}
export async function syncGmail() {
  if (!await claimJob('lock:gmail')) return { locked: true };
  try {
    const gmail = google.gmail({ version: 'v1', auth: await googleAuth('gmail') });
    let cursor = await state('gmail_history_id');
    if (!cursor) throw new Error('Gmail watch not initialized');
    let pageToken, count = 0, latest = cursor;
    try {
      do {
        const { data } = await gmail.users.history.list({ userId: 'me', startHistoryId: cursor, historyTypes: ['messageAdded'], pageToken, maxResults: 100 });
        const ids = [...new Set((data.history || []).flatMap(h => (h.messagesAdded || []).map(x => x.message?.id).filter(Boolean)))];
        for (const id of ids) { const result = await forwardMessage(gmail, id); if (result === 'forwarded') count++; }
        pageToken = data.nextPageToken; latest = data.historyId || latest;
      } while (pageToken);
    } catch (error) {
      if (error.code !== 404 && error.status !== 404) throw error;
      const after = await state('gmail_last_sync_unix');
      if (!after) throw new Error('Gmail history expired and no recovery checkpoint exists');
      let next;
      do {
        const { data } = await gmail.users.messages.list({ userId: 'me', q: `in:inbox after:${Math.max(0, Number(after) - 86400)}`, maxResults: 100, pageToken: next });
        for (const item of data.messages || []) { const result = await forwardMessage(gmail, item.id); if (result === 'forwarded') count++; }
        next = data.nextPageToken;
      } while (next);
      latest = (await gmail.users.getProfile({ userId: 'me' })).data.historyId;
      await log('gmail_history_recovery', 'success', latest, { after });
    }
    await setState('gmail_history_id', latest);
    await setState('gmail_last_sync_unix', Math.floor(Date.now() / 1000));
    return { forwarded: count, historyId: latest };
  } finally { await setState('lock:gmail', new Date(0).toISOString()); }
}
export async function renewWatch() {
  const gmail = google.gmail({ version: 'v1', auth: await googleAuth('gmail') });
  const { data } = await gmail.users.watch({ userId: 'me', requestBody: { topicName: env('GOOGLE_PUBSUB_TOPIC') } });
  if (!await state('gmail_history_id')) await setState('gmail_history_id', data.historyId);
  if (!await state('gmail_last_sync_unix')) await setState('gmail_last_sync_unix', Math.floor(Date.now() / 1000));
  await setState('gmail_watch_expiration', data.expiration);
  await log('watch_renew', 'success', data.historyId, { expiration: data.expiration });
  return data;
}

export async function userbot() {
  const client = new TelegramClient(new StringSession(env('TELEGRAM_STRING_SESSION')), Number(env('TELEGRAM_API_ID')), env('TELEGRAM_API_HASH'), { connectionRetries: 2 });
  await client.connect(); if (!await client.isUserAuthorized()) throw new Error('Telegram user session expired');
  return client;
}
export function mediaInfo(message) {
  if (!message.media || message.sticker) return null;
  const file = message.file;
  if (!file) return null;
  const kind = message.photo ? 'photo' : message.video ? 'video' : message.voice ? 'voice' : message.audio ? 'audio' : 'document';
  const name = safeName(file.name || `${kind}-${message.id}${file.ext || ''}`);
  return { kind, name, mime: file.mimeType || 'application/octet-stream', size: Number(file.size || 0), unique: String(message.media?.document?.id || message.media?.photo?.id || message.id) };
}
const quote = value => String(value).replace(/'/g, "\\'");
async function ensureDriveFolder(drive, name, parent, deadline) {
  const q = `name = '${quote(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parent ? ` and '${parent}' in parents` : ''}`;
  const found = (await drive.files.list({ q, fields: 'files(id,name)', pageSize: 10 }, googleTimeout(deadline))).data.files?.[0];
  if (found) return found.id;
  return (await drive.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }, fields: 'id' }, googleTimeout(deadline))).data.id;
}
async function ensureResources(auth, chat, deadline) {
  const drive = google.drive({ version: 'v3', auth }), sheets = google.sheets({ version: 'v4', auth });
  let root = await state('drive_root_id');
  if (!root) { root = await ensureDriveFolder(drive, 'Telegram Files', null, deadline); await setState('drive_root_id', root); }
  let spreadsheetId = await state('spreadsheet_id');
  if (!spreadsheetId) {
    const created = await sheets.spreadsheets.create({ requestBody: { properties: { title: 'Telegram Archive' } }, fields: 'spreadsheetId' }, googleTimeout(deadline));
    spreadsheetId = created.data.spreadsheetId; await setState('spreadsheet_id', spreadsheetId);
  }
  let folder = chat.drive_folder_id;
  if (!folder) { folder = await ensureDriveFolder(drive, chat.title, root, deadline); ok(await db().from('archived_chats').update({ drive_folder_id: folder }).eq('chat_id', chat.chat_id)); }
  let tab = chat.sheet_tab_id;
  if (tab == null) {
    const title = chat.title.slice(0, 90).replace(/[\[\]:*?/\\]/g, '_') || chat.chat_id;
    const tabTitle = `${title} ${chat.chat_id}`.slice(0, 100);
    const existing = (await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' }, googleTimeout(deadline))).data.sheets.find(s => s.properties.title === tabTitle);
    if (existing) tab = existing.properties.sheetId;
    else {
      const result = await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: tabTitle, gridProperties: { frozenRowCount: 1 } } } }] } }, googleTimeout(deadline));
      tab = result.data.replies[0].addSheet.properties.sheetId;
    }
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `'${tabTitle.replace(/'/g, "''")}'!A1:G1`, valueInputOption: 'RAW', requestBody: { values: [['Дата', 'Отправитель', 'Имя файла', 'Тип', 'Размер', 'Ссылка на Drive', 'Ссылка на сообщение']] } }, googleTimeout(deadline));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ repeatCell: { range: { sheetId: tab, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } }] } }, googleTimeout(deadline));
    ok(await db().from('archived_chats').update({ sheet_tab_id: tab }).eq('chat_id', chat.chat_id));
  }
  return { drive, sheets, root, folder, spreadsheetId, tab };
}
export async function archiveChat(client, auth, chat, dialogs, deadline, limit = 15) {
  const peer = chat.username ? await client.getEntity(`@${chat.username}`) : dialogs.find(d => String(utils.getPeerId(d.entity)) === chat.chat_id)?.entity;
  if (!peer) throw new Error('Chat is not in the user account’s recent dialogs');
  let count = 0, processed = 0, last = Number(chat.last_message_id || 0), paused = false;
  for await (const message of client.iterMessages(peer, { minId: last, reverse: true, limit })) {
    if (!hasArchiveTime(deadline, ARCHIVE_MIN_START_MS)) { paused = true; break; }
    const info = mediaInfo(message);
    if (info) {
      const claimed = ok(await db().rpc('claim_file', { p_chat: chat.chat_id, p_message: message.id, p_unique: info.unique }));
      if (!claimed) {
        const existing = ok(await db().from('archived_files').select('status').eq('chat_id', chat.chat_id).eq('message_id', message.id).single());
        if (existing.status !== 'done' && existing.status !== 'skipped') { paused = true; break; }
      }
      if (claimed) {
        try {
          if (info.size > 50 * 1024 * 1024) {
            ok(await db().from('archived_files').update({ status: 'skipped', error: 'File exceeds 50 MB serverless processing limit', lease_until: null }).eq('chat_id', chat.chat_id).eq('message_id', message.id));
            await log('file_archive', 'skipped', `${chat.chat_id}:${message.id}`, { size: info.size });
            last = message.id; processed++;
            ok(await db().from('archived_chats').update({ last_message_id: last }).eq('chat_id', chat.chat_id));
            continue;
          }
          const resources = await ensureResources(auth, chat, deadline);
          const previous = ok(await db().from('archived_files').select('drive_file_id').eq('chat_id', chat.chat_id).eq('message_id', message.id).single());
          let fileId = previous.drive_file_id, filename = info.name, bytes = info.size;
          if (!fileId) {
            const downloaded = await client.downloadMedia(message.media, { progressCallback: () => {
              if (!hasArchiveTime(deadline, 2_000)) throw new Error('Archive run time budget reached');
            } });
            if (!Buffer.isBuffer(downloaded)) throw new Error('Telegram media download failed');
            bytes = downloaded.length;
            const q = `'${resources.folder}' in parents and trashed = false`;
            const existingFiles = (await resources.drive.files.list({ q, fields: 'nextPageToken,files(id,name,description)', pageSize: 1000 }, googleTimeout(deadline))).data.files || [];
            const earlier = existingFiles.find(f => f.description === `Telegram ${chat.chat_id}:${message.id}`);
            if (earlier) { fileId = earlier.id; filename = earlier.name; }
            else {
              filename = existingFiles.some(f => f.name === info.name) ? `${info.name.replace(/(\.[^.]+)?$/, '')}-${message.id}${info.name.match(/\.[^.]+$/)?.[0] || ''}` : info.name;
              const upload = await resources.drive.files.create({ requestBody: { name: filename, parents: [resources.folder], description: `Telegram ${chat.chat_id}:${message.id}` }, media: { mimeType: info.mime, body: Readable.from(downloaded) }, fields: 'id' }, googleTimeout(deadline, 30_000));
              fileId = upload.data.id;
            }
            ok(await db().from('archived_files').update({ drive_file_id: fileId }).eq('chat_id', chat.chat_id).eq('message_id', message.id));
          } else {
            const existing = (await resources.drive.files.get({ fileId, fields: 'id,name,size' }, googleTimeout(deadline))).data;
            filename = existing.name; bytes = Number(existing.size || bytes);
          }
          const sender = message.senderId ? String(message.senderId) : '';
          const link = chat.username ? `https://t.me/${chat.username}/${message.id}` : chat.chat_id.startsWith('-100') ? `https://t.me/c/${chat.chat_id.slice(4)}/${message.id}` : '';
          const sheet = (await resources.sheets.spreadsheets.get({ spreadsheetId: resources.spreadsheetId, fields: 'sheets(properties(sheetId,title))' }, googleTimeout(deadline))).data.sheets.find(s => s.properties.sheetId === resources.tab);
          const sheetRange = `'${sheet.properties.title.replace(/'/g, "''")}'!A:G`;
          const existingRows = (await resources.sheets.spreadsheets.values.get({ spreadsheetId: resources.spreadsheetId, range: sheetRange }, googleTimeout(deadline))).data.values || [];
          if (!existingRows.some(row => row[5] === `https://drive.google.com/file/d/${fileId}/view`)) {
            await resources.sheets.spreadsheets.values.append({ spreadsheetId: resources.spreadsheetId, range: sheetRange, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [[message.date?.toISOString?.() || '', sender, filename, info.kind, bytes, `https://drive.google.com/file/d/${fileId}/view`, link]] } }, googleTimeout(deadline));
          }
          ok(await db().from('archived_files').update({ status: 'done', drive_file_id: fileId, archived_at: new Date().toISOString(), lease_until: null }).eq('chat_id', chat.chat_id).eq('message_id', message.id));
          await log('file_archive', 'success', `${chat.chat_id}:${message.id}`, { fileId }); count++;
        } catch (error) {
          await db().from('archived_files').update({ status: 'failed', error: String(error), lease_until: null }).eq('chat_id', chat.chat_id).eq('message_id', message.id);
          await log('file_archive', 'failure', `${chat.chat_id}:${message.id}`, { error: String(error) });
          throw error;
        }
      }
    }
    last = message.id;
    processed++;
    ok(await db().from('archived_chats').update({ last_message_id: last }).eq('chat_id', chat.chat_id));
  }
  return { archived: count, processed, lastMessageId: last, paused };
}
export async function pollArchive({ budgetMs = ARCHIVE_RUN_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  if (!await claimJob('lock:archive')) return { locked: true };
  let client;
  try {
    const chats = ok(await db().from('archived_chats').select('*').eq('active', true).order('added_at'));
    if (!chats.length) return { chats: 0 };
    client = await userbot(); const auth = await googleAuth('archive'); const results = [];
    const dialogs = await client.getDialogs({ limit: 500 });
    const ordered = rotateChats(chats, await state('archive_next_chat_id'));
    for (const [index, chat] of ordered.entries()) {
      if (!hasArchiveTime(deadline, ARCHIVE_MIN_START_MS)) break;
      await setState('archive_next_chat_id', ordered[(index + 1) % ordered.length].chat_id);
      try { results.push({ chat: chat.chat_id, ...await archiveChat(client, auth, chat, dialogs, deadline) }); }
      catch (error) { results.push({ chat: chat.chat_id, error: String(error) }); await log('chat_poll', 'failure', chat.chat_id, { error: String(error) }); }
    }
    return { results, paused: !hasArchiveTime(deadline, ARCHIVE_MIN_START_MS) };
  } finally { if (client) await client.disconnect(); await setState('lock:archive', new Date(0).toISOString()); }
}
