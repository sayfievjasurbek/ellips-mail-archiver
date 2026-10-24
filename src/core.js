import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { TelegramClient, utils } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readOnlyUserbot } from './readonly.js';

export const oauthScopes = {
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
export const truncate = (value, max = 3500) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
export const stripHtml = html => html.replace(/<\s*(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
export function safeName(name) { return (name || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 180); }

export async function telegramBot(method, params = {}, file, signal) {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) form.set(key, String(value));
  if (file) form.set(file.field, new Blob([file.bytes], { type: file.mime || 'application/octet-stream' }), safeName(file.name));
  const response = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, { method: 'POST', body: form, signal });
  const result = await response.json(); if (!result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}
export async function userbot() {
  const client = new TelegramClient(new StringSession(env('TELEGRAM_STRING_SESSION')), Number(env('TELEGRAM_API_ID')), env('TELEGRAM_API_HASH'), { connectionRetries: 2 });
  await client.connect(); if (!await client.isUserAuthorized()) throw new Error('Telegram user session expired');
  return readOnlyUserbot(client);
}
const peerId = entity => String(utils.getPeerId(entity));
// Every dialog of the account, main folder first, then the Archived folder (paged by gramjs, no cap).
export async function getAllDialogs(client) {
  const active = await client.getDialogs({ folder: 0 });
  const archived = await client.getDialogs({ folder: 1 });
  const seen = new Set(active.map(d => peerId(d.entity)));
  return [
    ...active.map(d => ({ entity: d.entity, date: d.date, message: d.message, archived: false })),
    ...archived.filter(d => !seen.has(peerId(d.entity))).map(d => ({ entity: d.entity, date: d.date, message: d.message, archived: true }))
  ];
}
export const findChatEntity = (dialogs, chatId) => dialogs.find(d => peerId(d.entity) === String(chatId))?.entity;
export function describeDialogs(dialogs) {
  const kinds = { User: 'private', Chat: 'group' };
  return dialogs
    .filter(d => (kinds[d.entity?.className] || d.entity?.className === 'Channel')
      && !d.entity.bot && !d.entity.deleted && !d.entity.self && !d.entity.deactivated && String(d.entity.id) !== '777000')
    .map(d => ({
      id: peerId(d.entity),
      title: d.entity.title || [d.entity.firstName, d.entity.lastName].filter(Boolean).join(' ') || d.entity.username || String(d.entity.id),
      type: d.entity.className === 'Channel' ? (d.entity.megagroup ? 'group' : 'channel') : kinds[d.entity.className],
      archived: Boolean(d.archived),
      lastActivity: d.date ? new Date(d.date * 1000).toISOString() : null,
      lastMessageId: d.message?.id || 0
    }))
    .sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
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
  const peer = findChatEntity(dialogs, chat.chat_id);
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
    const dialogs = await getAllDialogs(client);
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
