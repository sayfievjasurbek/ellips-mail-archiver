import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { claimJob, db, env, log, ok, safeName, setState, state, stripHtml, telegramBot, truncate } from './core.js';

const MAX_SOURCE = 70 * 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024;
const RUN_BUDGET_MS = 45_000;
const BATCH_SIZE = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_BACKOFF_MS = [1_000, 2_000];
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const sendSignal = deadline => {
  const remaining = deadline - Date.now() - 1_000;
  if (remaining < 1_000) throw new Error('IMAP poll time budget reached');
  return AbortSignal.timeout(Math.min(remaining, 30_000));
};

export function messageKey(messageId, uidValidity, uid) {
  const id = String(messageId || '').trim().replace(/^<|>$/g, '');
  return id ? `mid:${id}` : `uid:${uidValidity}:${uid}`;
}

export function checkpointFor(mailbox, saved) {
  const uidValidity = String(mailbox.uidValidity);
  const highest = Math.max(0, Number(mailbox.highestUid || 0));
  if (!saved) return { uidValidity, uid: highest, initialized: true };
  if (saved.uidValidity !== uidValidity) {
    throw new Error(`IMAP UIDVALIDITY changed from ${saved.uidValidity} to ${uidValidity}; checkpoint preserved for reconciliation`);
  }
  return { uidValidity, uid: Number(saved.uid), initialized: false };
}

export const shouldAlert = (failures, lastAlertAt, now = Date.now()) =>
  failures >= 3 && now - Number(lastAlertAt || 0) >= ALERT_COOLDOWN_MS;

const errorText = error => {
  const password = process.env.IMAP_PASSWORD;
  const value = String(error);
  return password ? value.replaceAll(password, '[redacted]') : value;
};

async function markStep(id, sent, step) {
  sent.add(step);
  ok(await db().from('forwarded_emails').update({ sent_steps: [...sent] }).eq('gmail_message_id', id));
}

export async function forwardImapMessage(message, uidValidity, uid, deadline = Date.now() + RUN_BUDGET_MS) {
  const id = messageKey(message.messageId, uidValidity, uid);
  const claimed = ok(await db().rpc('claim_email', { p_id: id, p_thread: null }));
  if (!claimed) return 'duplicate';
  try {
    const row = ok(await db().from('forwarded_emails').select('sent_steps').eq('gmail_message_id', id).single());
    const sent = new Set(row.sent_steps || []);
    const from = message.from?.text || '';
    const body = message.text || (message.html ? stripHtml(String(message.html)) : '') || '(no text body)';
    const summary = `From: ${from}\nSubject: ${message.subject || '(no subject)'}\nDate: ${message.date?.toUTCString?.() || ''}\n\n${truncate(body)}`;
    if (!sent.has('body')) {
      await telegramBot('sendMessage', { chat_id: env('TELEGRAM_EMAIL_CHAT_ID'), text: summary }, undefined, sendSignal(deadline));
      await markStep(id, sent, 'body');
    }
    for (const [index, attachment] of (message.attachments || []).entries()) {
      const step = `attachment:${index}`;
      if (sent.has(step)) continue;
      const filename = safeName(attachment.filename || `attachment-${index + 1}`);
      const size = attachment.size || attachment.content?.length || 0;
      if (size > MAX_FILE) {
        await telegramBot('sendMessage', { chat_id: env('TELEGRAM_EMAIL_CHAT_ID'), text: `Attachment too large to forward: ${filename} (${(size / 1048576).toFixed(1)} MB)` }, undefined, sendSignal(deadline));
      } else {
        const photo = attachment.contentType?.startsWith('image/') && size < 10 * 1024 * 1024;
        await telegramBot(photo ? 'sendPhoto' : 'sendDocument', { chat_id: env('TELEGRAM_EMAIL_CHAT_ID'), ...(photo ? { caption: filename } : {}) }, {
          field: photo ? 'photo' : 'document', bytes: attachment.content, name: filename, mime: attachment.contentType
        }, sendSignal(deadline));
      }
      await markStep(id, sent, step);
    }
    ok(await db().from('forwarded_emails').update({ status: 'done', forwarded_at: new Date().toISOString(), lease_until: null }).eq('gmail_message_id', id));
    await log('email_forward', 'success', id, { uid, attachments: message.attachments?.length || 0 });
    return 'forwarded';
  } catch (error) {
    await db().from('forwarded_emails').update({ status: 'failed', error: String(error), lease_until: null }).eq('gmail_message_id', id);
    await log('email_forward', 'failure', id, { uid, error: String(error) });
    throw error;
  }
}

async function openInboxWithRetries() {
  const attempts = [];
  for (let index = 0; index <= CONNECT_BACKOFF_MS.length; index++) {
    const client = new ImapFlow({
      host: env('IMAP_HOST'), port: Number(env('IMAP_PORT')), secure: true,
      auth: { user: env('IMAP_USER'), pass: env('IMAP_PASSWORD') },
      logger: false, disableAutoIdle: true,
      connectionTimeout: CONNECT_TIMEOUT_MS, greetingTimeout: CONNECT_TIMEOUT_MS, socketTimeout: 15_000
    });
    client.on('error', () => {});
    let timer;
    try {
      const opened = (async () => {
        await client.connect();
        return client.getMailboxLock('INBOX', { readOnly: true });
      })();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          client.close();
          reject(new Error(`IMAP connection timed out after ${CONNECT_TIMEOUT_MS / 1000} seconds`));
        }, CONNECT_TIMEOUT_MS);
      });
      const lock = await Promise.race([opened, timeout]);
      clearTimeout(timer);
      return { client, lock, attempts };
    } catch (error) {
      clearTimeout(timer);
      client.close();
      const message = errorText(error);
      attempts.push(message);
      try { await log('imap_connect_attempt', 'failure', 'INBOX', { attempt: index + 1, error: message }); } catch {}
      const authenticationRejected = error.serverResponseCode === 'AUTHENTICATIONFAILED' || /AUTHENTICATIONFAILED/i.test(message);
      if (authenticationRejected || index === CONNECT_BACKOFF_MS.length) {
        error.attemptErrors = attempts;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, CONNECT_BACKOFF_MS[index]));
    }
  }
}

async function closeInbox(client, lock) {
  if (lock) lock.release();
  if (!client) return;
  let timer;
  try {
    await Promise.race([
      client.logout(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IMAP logout timed out')), 5_000); })
    ]);
  } catch (error) {
    client.close();
    try { await log('imap_logout', 'failure', 'INBOX', { error: errorText(error) }); } catch {}
    throw error;
  } finally { clearTimeout(timer); }
}

async function recordPollFailure(error) {
  const message = errorText(error);
  const failures = Number(await state('imap_failure_streak') || 0) + 1;
  await setState('imap_failure_streak', failures);
  await log('imap_poll', 'failure', 'INBOX', { error: message, consecutiveFailures: failures, connectAttempts: error.attemptErrors || [] });
  const lastAlertAt = await state('imap_login_alert_at');
  if (!shouldAlert(failures, lastAlertAt)) return;
  const alert = `IMAP poll failed ${failures} consecutive times for ${env('IMAP_USER')}. Latest error: ${truncate(message, 650)}. Forwarding will retry; the UID checkpoint is preserved.`;
  try {
    await telegramBot('sendMessage', { chat_id: env('TELEGRAM_EMAIL_CHAT_ID'), text: alert }, undefined, AbortSignal.timeout(10_000));
    await setState('imap_login_alert_at', Date.now());
    await log('imap_poll_alert', 'success', 'INBOX', { error: message, consecutiveFailures: failures });
  } catch (alertError) {
    try { await log('imap_poll_alert', 'failure', 'INBOX', { error: errorText(alertError) }); } catch {}
  }
}

async function processInbox(client, deadline) {
  const savedText = await state('imap_checkpoint');
    const saved = savedText ? JSON.parse(savedText) : null;
    const latest = !saved ? await client.fetchOne('*', { uid: true }) : null;
    const checkpoint = checkpointFor({ ...client.mailbox, highestUid: latest?.uid || 0 }, saved);
    if (checkpoint.initialized) {
      await setState('imap_checkpoint', JSON.stringify({ uidValidity: checkpoint.uidValidity, uid: checkpoint.uid }));
      await log('imap_baseline', 'success', 'INBOX', { uid: checkpoint.uid, uidValidity: checkpoint.uidValidity });
      return { initialized: true, lastUid: checkpoint.uid, forwarded: 0 };
    }
    const highest = Math.max(0, Number(client.mailbox.uidNext) - 1);
    if (highest <= checkpoint.uid) {
      return { forwarded: 0, lastUid: checkpoint.uid };
    }
    const found = await client.search({ uid: `${checkpoint.uid + 1}:${highest}` }, { uid: true });
    const uids = (found || []).filter(uid => uid > checkpoint.uid && uid <= highest).sort((a, b) => a - b).slice(0, BATCH_SIZE);
    let forwarded = 0;
    for (const uid of uids) {
      if (Date.now() + 8_000 >= deadline) break;
      const meta = await client.fetchOne(uid, { envelope: true, size: true, flags: true }, { uid: true });
      if (meta && !meta.flags?.has('\\Draft')) {
        if (meta.size > MAX_SOURCE) {
          const id = messageKey(meta.envelope?.messageId, checkpoint.uidValidity, uid);
          const claimed = ok(await db().rpc('claim_email', { p_id: id, p_thread: null }));
          if (claimed) {
            try {
              await telegramBot('sendMessage', { chat_id: env('TELEGRAM_EMAIL_CHAT_ID'), text: `From: ${meta.envelope?.from?.[0]?.address || ''}\nSubject: ${meta.envelope?.subject || '(no subject)'}\nDate: ${meta.envelope?.date?.toUTCString?.() || ''}\n\nEmail too large to download on the forwarder (${(meta.size / 1048576).toFixed(1)} MB); attachments were not forwarded.` }, undefined, sendSignal(deadline));
              ok(await db().from('forwarded_emails').update({ status: 'done', forwarded_at: new Date().toISOString(), lease_until: null }).eq('gmail_message_id', id));
              await log('email_forward', 'skipped_large', id, { uid, size: meta.size });
            } catch (error) {
              await db().from('forwarded_emails').update({ status: 'failed', error: String(error), lease_until: null }).eq('gmail_message_id', id);
              await log('email_forward', 'failure', id, { uid, error: String(error) });
              throw error;
            }
          }
        } else {
          const fetched = await client.fetchOne(uid, { source: true }, { uid: true });
          if (fetched?.source && await forwardImapMessage(await simpleParser(fetched.source), checkpoint.uidValidity, uid, deadline) === 'forwarded') forwarded++;
        }
      }
      checkpoint.uid = uid;
      await setState('imap_checkpoint', JSON.stringify({ uidValidity: checkpoint.uidValidity, uid }));
    }
    if (!uids.length) {
      checkpoint.uid = highest;
      await setState('imap_checkpoint', JSON.stringify({ uidValidity: checkpoint.uidValidity, uid: highest }));
    }
    return { forwarded, lastUid: checkpoint.uid, remaining: Math.max(0, highest - checkpoint.uid) };
}

export async function pollImap() {
  if (!await claimJob('lock:imap', 90)) return { locked: true };
  const deadline = Date.now() + RUN_BUDGET_MS;
  let client, lock, result, failure, uidValidity;
  try {
    ({ client, lock } = await openInboxWithRetries());
    result = await processInbox(client, deadline);
    uidValidity = String(client.mailbox?.uidValidity || '');
  } catch (error) { failure = error; }
  try { await closeInbox(client, lock); }
  catch (error) { failure ||= error; }
  try { await setState('lock:imap', new Date(0).toISOString()); }
  catch (error) { failure ||= error; }
  if (failure) {
    await recordPollFailure(failure);
    return { failed: true, error: errorText(failure) };
  }
  await setState('imap_failure_streak', 0);
  await log('imap_poll', 'success', 'INBOX', { ...result, uidValidity });
  return result;
}
