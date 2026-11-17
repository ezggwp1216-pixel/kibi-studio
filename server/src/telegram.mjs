export function validTelegramCredentials(token, chatId) {
  return typeof token === 'string' && /^\d{1,20}:[A-Za-z0-9_-]{10,200}$/.test(token)
    && typeof chatId === 'string' && /^(?:-?\d{1,24}|@[A-Za-z][A-Za-z0-9_]{3,63})$/.test(chatId);
}

async function readTelegramJson(response, signal) {
  const limit = 256 * 1024;
  const length = response.headers?.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('invalid_response');
  if (!response.body?.getReader) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  const chunks = [];
  try {
    if (signal.aborted) throw new Error('timeout');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit || chunks.length >= 8192) throw new Error('invalid_response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

function cancelBody(response) {
  try { void response?.body?.cancel().catch(() => {}); } catch {}
}

export async function sendTelegram(credentials, title, message, fetchImpl = fetch) {
  if (!validTelegramCredentials(credentials?.token, credentials?.chatId)) return false;
  const controller = new AbortController();
  let timer;
  try {
    // The URL is constructed here; redirects are rejected so credentials never
    // travel to a configurable endpoint or a redirect destination.
    return await Promise.race([
      (async () => {
        let response;
        try {
          response = await fetchImpl(`https://api.telegram.org/bot${credentials.token}/sendMessage`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: credentials.chatId, text: `${title}${message ? `\n${message}` : ''}` }),
        });
          if (controller.signal.aborted || !response.ok) return false;
          return (await readTelegramJson(response, controller.signal)).ok === true;
        } finally { cancelBody(response); }
      })(),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, 8000); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}
