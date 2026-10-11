import test from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { mediaInfo, safeName, stripHtml, truncate } from '../src/core.js';
import { checkpointFor, messageKey } from '../src/imap.js';

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
