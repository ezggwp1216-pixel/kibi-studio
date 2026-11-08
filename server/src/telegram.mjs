export function validTelegramCredentials(token, chatId) {
  return typeof token === 'string' && /^\d{1,20}:[A-Za-z0-9_-]{10,200}$/.test(token)
    && typeof chatId === 'string' && /^(?:-?\d{1,24}|@[A-Za-z][A-Za-z0-9_]{3,63})$/.test(chatId);
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
        const response = await fetchImpl(`https://api.telegram.org/bot${credentials.token}/sendMessage`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: credentials.chatId, text: `${title}${message ? `\n${message}` : ''}` }),
        });
        if (!response.ok) return false;
        return (await response.json()).ok === true;
      })(),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, 8000); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}
