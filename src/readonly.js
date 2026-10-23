// The archiver must never change anything on the client's Telegram account.
// Only these MTProto requests may leave the userbot session; everything else is refused.
export const ALLOWED_REQUESTS = new Set([
  'help.GetConfig', 'help.GetNearestDc', 'updates.GetState', 'updates.GetDifference', 'updates.GetChannelDifference',
  'messages.GetDialogs', 'messages.GetPeerDialogs', 'messages.GetHistory', 'messages.GetMessages', 'channels.GetMessages',
  'users.GetUsers', 'messages.GetChats', 'channels.GetChannels',
  'upload.GetFile', 'upload.GetCdnFile', 'auth.ExportAuthorization', 'auth.ImportAuthorization'
]);
export const isReadRequest = request => ALLOWED_REQUESTS.has(request?.className);

const guard = send => async (request, ...rest) => {
  if (!isReadRequest(request)) throw new Error(`Blocked non-read Telegram request: ${request?.className || typeof request}`);
  return await send(request, ...rest);
};

// Returns an object exposing only read methods. Chats are found among the account's own dialogs,
// so there is no username or invite-link resolution and nothing can join a chat.
export function readOnlyUserbot(client) {
  client.invoke = guard(client.invoke.bind(client));
  client.invokeWithSender = guard(client.invokeWithSender.bind(client));
  return Object.freeze({
    getDialogs: options => client.getDialogs(options),
    iterMessages: (peer, options) => client.iterMessages(peer, options),
    downloadMedia: (media, options) => client.downloadMedia(media, options),
    isUserAuthorized: () => client.isUserAuthorized(),
    disconnect: () => client.disconnect()
  });
}
