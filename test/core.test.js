import test from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { Api } from 'telegram';
import { describeDialogs, findChatEntity, getAllDialogs, mediaInfo, safeName, stripHtml, truncate } from '../src/core.js';
import { checkpointFor, messageKey, shouldAlert } from '../src/imap.js';

test('HTML fallback strips tags and decodes common entities', () => {
  assert.equal(stripHtml('<p>A &amp; B</p><div>C</div>'), 'A & B\nC');
});
test('media selection excludes stickers and text', () => {
  assert.equal(mediaInfo({ id: 1, message: 'hello' }), null);
  assert.equal(mediaInfo({ id: 2, media: {}, sticker: true, file: { name: 'sticker.webp' } }), null);
  assert.deepEqual(mediaInfo({ id: 3, media: { document: { id: 44 } }, file: { name: '../invoice.pdf', size: 100 }, video: false }),
    { kind: 'document', name: '.._invoice.pdf', mime: 'application/octet-stream', size: 100, unique: '44' });
});
test('length and filename boundaries', () => {
  assert.equal(truncate('abcd', 3), 'ab…');
  assert.equal(safeName('a/b\\c'), 'a_b_c');
});

test('IMAP baseline skips existing UIDs and preserves checkpoint on UIDVALIDITY change', () => {
  assert.deepEqual(checkpointFor({ uidValidity: 42n, highestUid: 51 }, null), { uidValidity: '42', uid: 51, initialized: true });
  assert.deepEqual(checkpointFor({ uidValidity: 42n, highestUid: 55 }, { uidValidity: '42', uid: 51 }), { uidValidity: '42', uid: 51, initialized: false });
  assert.throws(() => checkpointFor({ uidValidity: 43n, highestUid: 8 }, { uidValidity: '42', uid: 51 }), /checkpoint preserved for reconciliation/);
});

test('Message-ID is the deduplication key, with UID fallback only if absent', () => {
  assert.equal(messageKey('<one@example.com>', '42', 1), 'mid:one@example.com');
  assert.equal(messageKey('<one@example.com>', '42', 2), 'mid:one@example.com');
  assert.equal(messageKey('', '42', 2), 'uid:42:2');
});

test('IMAP alert needs three failed polls and a six-hour cooldown', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  assert.equal(shouldAlert(2, 0, now), false);
  assert.equal(shouldAlert(3, 0, now), true);
  assert.equal(shouldAlert(4, now - 5 * 60 * 60 * 1000, now), false);
  assert.equal(shouldAlert(4, now - 6 * 60 * 60 * 1000, now), true);
});

test('MIME parser keeps Message-ID, plain body, and attachment filename', async () => {
  const raw = [
    'From: Sender <sender@example.com>', 'Subject: Report', 'Message-ID: <report@example.com>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="boundary"', '',
    '--boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Plain body',
    '--boundary', 'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"', 'Content-Transfer-Encoding: base64', '',
    'UERG', '--boundary--', ''
  ].join('\r\n');
  const parsed = await simpleParser(raw);
  assert.equal(messageKey(parsed.messageId, '1', 5), 'mid:report@example.com');
  assert.equal(parsed.text.trim(), 'Plain body');
  assert.equal(parsed.attachments[0].filename, 'report.pdf');
  assert.equal(parsed.attachments[0].content.toString(), 'PDF');
});
test('chat picker lists every kind of chat newest first, marks archived, skips bots, deleted and Telegram service chat', () => {
  const dialog = (entity, date, extra = {}) => ({ entity, date, message: { id: date }, archived: false, ...extra });
  const list = describeDialogs([
    dialog(new Api.User({ id: 5n, firstName: 'Ann', lastName: 'Lee' }), 100),
    dialog(new Api.User({ id: 6n, firstName: 'Bot', bot: true }), 400),
    dialog(new Api.User({ id: 7n, firstName: 'Gone', deleted: true }), 400),
    dialog(new Api.User({ id: 777000n, firstName: 'Telegram' }), 450),
    dialog(new Api.Chat({ id: 8n, title: 'Family' }), 300),
    dialog(new Api.Channel({ id: 9n, title: 'News', broadcast: true }), 200),
    dialog(new Api.Channel({ id: 10n, title: 'Team', megagroup: true }), 50),
    dialog(new Api.Channel({ id: 11n, title: 'Old', broadcast: true }), 500, { archived: true })
  ]);
  assert.deepEqual(list.map(c => [c.id, c.title, c.type, c.archived]),
    [['-10011', 'Old', 'channel', true], ['-8', 'Family', 'group', false], ['-1009', 'News', 'channel', false], ['5', 'Ann Lee', 'private', false], ['-10010', 'Team', 'group', false]]);
});
test('chat lookup pages through all dialogs and finds archived chats and chats beyond 500', async () => {
  const active = Array.from({ length: 700 }, (_, i) => ({ entity: new Api.User({ id: BigInt(1000 + i), firstName: `U${i}` }), date: 1, message: { id: 1 } }));
  const archived = [{ entity: new Api.User({ id: 99n, firstName: 'Hidden' }), date: 1, message: { id: 1 } }, active[3]];
  const folders = [];
  const client = { getDialogs: async ({ folder }) => { folders.push(folder); return folder === 1 ? archived : active; } };
  const all = await getAllDialogs(client);
  assert.deepEqual(folders, [0, 1]);
  assert.equal(all.length, 701);
  assert.equal(findChatEntity(all, '1699').firstName, 'U699');
  assert.equal(findChatEntity(all, '99').firstName, 'Hidden');
  assert.equal(all.find(d => String(d.entity.id) === '99').archived, true);
  assert.equal(all.find(d => String(d.entity.id) === '1003').archived, false);
  assert.equal(findChatEntity(all, '5'), undefined);
});
