import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler, { schedulerAuthorized } from '../api/index.js';
import { ARCHIVE_RUN_BUDGET_MS, hasArchiveTime, oauthScopes, rotateChats } from '../src/core.js';

test('Vercel Hobby configuration has only a daily watch renewal', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url)));
  assert.equal(config.functions['api/index.js'].maxDuration, 60);
  assert.deepEqual(config.crons, [{ path: '/api/cron/watch', schedule: '0 2 * * *' }]);
});

test('external archive scheduler requires the exact custom header', () => {
  assert.equal(schedulerAuthorized({ headers: { 'x-cron-secret': 'correct' } }, 'correct'), true);
  assert.equal(schedulerAuthorized({ headers: { 'x-cron-secret': 'wrong' } }, 'correct'), false);
  assert.equal(schedulerAuthorized({ headers: {} }, undefined), false);
});

test('archive endpoint rejects unauthenticated requests before starting work', async () => {
  const old = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  try {
    await handler({ url: '/api/poll/archive', method: 'GET', headers: {} }, response);
    assert.equal(response.code, 401);
    assert.deepEqual(response.body, { error: 'Unauthorized' });
  } finally {
    if (old === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = old;
  }
});

test('backfill rotates between chats and respects the run deadline', () => {
  const chats = [{ chat_id: 'a' }, { chat_id: 'b' }, { chat_id: 'c' }];
  assert.deepEqual(rotateChats(chats, 'b').map(chat => chat.chat_id), ['b', 'c', 'a']);
  assert.deepEqual(rotateChats(chats, 'missing'), chats);
  assert.equal(hasArchiveTime(Date.now() + ARCHIVE_RUN_BUDGET_MS, 18_000), true);
  assert.equal(hasArchiveTime(Date.now() + 1_000, 18_000), false);
});

test('Gmail and archive consent request separate minimal scopes', () => {
  assert.deepEqual(oauthScopes.gmail, ['https://www.googleapis.com/auth/gmail.readonly']);
  assert.deepEqual(oauthScopes.archive, [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets'
  ]);
});
