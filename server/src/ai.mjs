// Stateless text module. No keys, provider errors or conversation bodies are logged.
export const DEFAULT_MODEL = 'gpt-5-mini';
export const validApiKey = key => typeof key === 'string' && /^[\x21-\x7e]{20,256}$/.test(key);
export const validModel = model => typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(model);

async function boundedJson(response, maxBytes) {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function askAi(credentials, text, fetchImpl = fetch) {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}` },
          body: JSON.stringify({ model: credentials.model, instructions: credentials.systemPrompt, input: text, store: false, max_output_tokens: 1024 }),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { code: [401, 403].includes(response.status) ? 'ai_auth_failed' : response.status === 429 ? 'ai_quota_exceeded' : 'ai_unavailable' };
        }
        const data = await boundedJson(response, 256 * 1024);
        const parts = [];
        for (const item of Array.isArray(data.output) ? data.output : []) {
          if (item.type !== 'message' || !Array.isArray(item.content)) continue;
          for (const part of item.content) if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
        }
        const answer = parts.join('\n').slice(0, 4000);
        return answer.trim() ? { text: answer } : { code: 'ai_unavailable' };
      })(),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ code: 'ai_unavailable' }); }, 15000); }),
    ]);
  } catch { return { code: 'ai_unavailable' }; }
  finally { clearTimeout(timer); }
}
