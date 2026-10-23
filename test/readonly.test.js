import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Api } from 'telegram';
import { isReadRequest, readOnlyUserbot } from '../src/readonly.js';

const fakeClient = () => {
  const sent = [];
  const send = async request => { sent.push(request.className); return {}; };
  return { sent, invoke: send, invokeWithSender: send, getDialogs: async () => [], iterMessages: () => [], downloadMedia: async () => Buffer.alloc(0), isUserAuthorized: async () => true, disconnect: async () => {} };
};

test('userbot wrapper exposes only read methods', () => {
  const bot = readOnlyUserbot(fakeClient());
  assert.deepEqual(Object.keys(bot).sort(), ['countMessages', 'disconnect', 'downloadMedia', 'getDialogs', 'isUserAuthorized', 'iterMessages']);
  for (const method of ['sendMessage', 'sendFile', 'forwardMessages', 'editMessage', 'deleteMessages', 'markAsRead', 'invoke', 'getEntity', 'start', 'signIn'])
    assert.equal(bot[method], undefined, method);
});

test('write requests are blocked at the session level, read requests pass', async () => {
  const client = fakeClient();
  readOnlyUserbot(client);
  const writes = [
    new Api.messages.SendMessage({ peer: 'me', message: 'x' }),
    new Api.messages.ForwardMessages({ fromPeer: 'me', toPeer: 'me', id: [1] }),
    new Api.messages.EditMessage({ peer: 'me', id: 1 }),
    new Api.messages.DeleteMessages({ id: [1] }),
    new Api.messages.ReadHistory({ peer: 'me', maxId: 0 }),
    new Api.channels.ReadHistory({ channel: 'me', maxId: 0 }),
    new Api.messages.ReadMentions({ peer: 'me' }),
    new Api.messages.SetTyping({ peer: 'me', action: new Api.SendMessageTypingAction() }),
    new Api.channels.JoinChannel({ channel: 'me' }),
    new Api.channels.LeaveChannel({ channel: 'me' }),
    new Api.messages.ImportChatInvite({ hash: 'x' }),
    new Api.account.UpdateStatus({ offline: false }),
    new Api.account.UpdateProfile({ firstName: 'x' }),
    new Api.contacts.ResolveUsername({ username: 'x' })
  ];
  for (const request of writes) {
    await assert.rejects(client.invoke(request), /Blocked non-read/, request.className);
    await assert.rejects(client.invokeWithSender(request, {}), /Blocked non-read/, request.className);
  }
  assert.deepEqual(client.sent, []);
  await client.invoke(new Api.messages.GetHistory({ peer: 'me', offsetId: 0, offsetDate: 0, addOffset: 0, limit: 1, maxId: 0, minId: 0, hash: 0n }));
  assert.ok(isReadRequest(new Api.upload.GetFile({ location: new Api.InputPeerPhotoFileLocation({ peer: 'me', photoId: 1n }), offset: 0n, limit: 1 })));
  assert.deepEqual(client.sent, ['messages.GetHistory']);
});

test('source never calls a gramjs write method outside the guard', () => {
  const forbidden = /\.(sendMessage|sendFile|forwardMessages|editMessage|deleteMessages|markAsRead|pinMessage|unpinMessage|sendRead\w*|setTyping|joinChannel|leaveChannel|invoke|invokeWithSender|getEntity|getInputEntity|updateProfile|signIn|start)\(/;
  const files = ['api/index.js', ...readdirSync('src').filter(f => f.endsWith('.js') && f !== 'readonly.js').map(f => `src/${f}`)];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // IMAP's ImapFlow has its own methods; only look at lines touching the Telegram userbot
    for (const [index, line] of text.split('\n').entries())
      if (/client\./.test(line) && !/imap/i.test(file)) assert.doesNotMatch(line, forbidden, `${file}:${index + 1}`);
  }
});

test('the bot token is never used with the userbot session', () => {
  const text = readFileSync('src/core.js', 'utf8');
  assert.doesNotMatch(text, /client\.[a-zA-Z]*(send|forward)/i);
});
