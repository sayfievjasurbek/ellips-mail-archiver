import test from 'node:test';
import assert from 'node:assert/strict';
import { b64, emailParts, mediaInfo, safeName, stripHtml, truncate } from '../src/core.js';

const encoded = value => Buffer.from(value).toString('base64url');
test('email parsing prefers plain text and keeps attachments', () => {
  const result = emailParts({ parts: [
    { mimeType: 'text/html', body: { data: encoded('<p>HTML</p>') } },
    { mimeType: 'text/plain', body: { data: encoded('Plain body') } },
    { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'a1', size: 12 } }
  ] });
  assert.equal(result.text, 'Plain body');
  assert.equal(result.attachments[0].filename, 'invoice.pdf');
});
test('HTML fallback strips tags and decodes common entities', () => {
  assert.equal(stripHtml('<p>A &amp; B</p><div>C</div>'), 'A & B\nC');
  assert.equal(emailParts({ mimeType: 'text/html', body: { data: encoded('<p>Hi</p>') } }).text, 'Hi');
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
  assert.equal(b64(encoded('value')).toString(), 'value');
});
