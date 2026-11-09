/** Public, standalone resource service. Node24 built-ins; never executes remote code.
 * Bind ONLY the four methods returned by createPublicResourceService to AI tools.
 * Trusted host configuration owns sdkRoots, authorization, DNS, transport and installer.
 * getProjectContext()->{id,generation,publicAssetImportsAllowed:true}; generation must
 * change whenever a project is replaced. sdkRoots={device,opus,gif} are canonical,
 * immutable PUBLIC header directories; reads use a fixed basename whitelist only.
 * transport({url,address:{address,family},signal})->{statusCode,headers,body,dispose?}
 * is for trusted/offline adapters; it must not redirect or make its own DNS choices.
 * importPublicAsset(url,{expectedProjectId,recipe?:id|{id}}) never writes directly.
 * Callback receives one verified block for embedded_assets.h; append-only.
 * Host returns the aggregate hash and protects the entire stable header.
 * installAsset must append verified blocks atomically for expectedProjectId/generation,
 * call assertProjectCurrent inside its commit, and never resolve an arbitrary AI path.
 */
import https from 'node:https';
import {MANAGED_ASSET_PATH,createManagedAssetBlock} from './managed-assets.mjs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve, join, basename, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const RECIPE_ID = 'leroyd-c309-public-b59a5c23';
const FIRMWARE_HASH = 'b59a5c23ad622308efe727b325cc1449192f1f344ba00199462ee9e65e317162';
const PINNED_RECIPE = JSON.parse(readFileSync(new URL('./leroyd-c309-recipe.json', import.meta.url), 'utf8'));
export const PUBLIC_ASSET_RECIPES = Object.freeze([Object.freeze({ id: RECIPE_ID, sourceUrl: 'https://leroyd.com/oled.ino.bin', sourceSha256: FIRMWARE_HASH, records: 14, positions: 42, licenseStatus: 'unknown' })]);
export const SDK_HEADERS = Object.freeze({
  'KibiOpus.h': 'opus', 'AnimatedGIF.h': 'gif',
  'microphone_i2s.h': 'device', 'audio_codec_power.h': 'device',
  'microphone_filter.h': 'device', 'http_json.h': 'device',
  'cloud_voice.h': 'device', 'cloud_voice_protocol.h': 'device', 'network_gate.h': 'device',
  'server_transport.h': 'device', 'server_endpoint.h': 'device', 'device_inbox.h': 'device', 'display_touch.h': 'device',
  'kibi_typography.h': 'device', 'power_management.h': 'device',
  'app_core.h': 'device', 'app_view.h': 'device', 'state_info.h': 'device', 'audio_file.h': 'device',
});
const LIMITS = Object.freeze({ timeoutMs: 12000, redirects: 3, chunks: 4096,
  assetBytes: 4 * 1024 * 1024, textBytes: 256 * 1024, headerBytes: 256 * 1024,
  textChars: 24000, links: 48, pixels: 4 * 1024 * 1024, gifFrames: 512 });
export class PublicResourceError extends Error {
  constructor(code, message = 'Не удалось обработать публичный ресурс.') { super(message); this.name = 'PublicResourceError'; this.code = code; }
}
function fail(code, message) { throw new PublicResourceError(code, message); }
function check(value, code, message) { if (!value) fail(code, message); }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
function projectShape(value) {
  check(value && safeId(value.id) && (typeof value.generation === 'string' || Number.isSafeInteger(value.generation)), 'PROJECT_CONTEXT');
  check(value.publicAssetImportsAllowed === true, 'IMPORT_REVOKED', 'Импорт публичных ресурсов отключён.');
  return { id: value.id, generation: value.generation };
}

function ipv6Words(address) {
  check(!address.includes('%') && !address.includes('.'), 'NON_PUBLIC_ADDRESS');
  const halves = address.toLowerCase().split('::');
  check(halves.length <= 2, 'NON_PUBLIC_ADDRESS');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(x => parseInt(x, 16));
}
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const n = address.split('.').map(Number);
    if (n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224) return false;
    if (n[0] === 100 && n[1] >= 64 && n[1] <= 127) return false;
    if (n[0] === 169 && n[1] === 254) return false;
    if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return false;
    if (n[0] === 192 && (n[1] === 168 || (n[1] === 0 && (n[2] === 0 || n[2] === 2)) || (n[1] === 88 && n[2] === 99))) return false;
    if (n[0] === 198 && ((n[1] === 18 || n[1] === 19) || (n[1] === 51 && n[2] === 100))) return false;
    if (n[0] === 203 && n[1] === 0 && n[2] === 113) return false;
    return true;
  }
  if (family === 6) {
    // Conservative global-unicast allow-list: excludes mapped IPv4, local scopes,
    // IETF assignments, Teredo, documentation, 6to4 and multicast.
    if (address.includes('.') || address.includes('%')) return false;
    const w = ipv6Words(address);
    return w.length === 8 && (w[0] & 0xe000) === 0x2000 &&
      !(w[0] === 0x2001 && (w[1] < 0x200 || w[1] === 0xdb8)) &&
      w[0] !== 0x2002 && !(w[0] === 0x3fff && (w[1] & 0xf000) === 0);
  }
  return false;
}
function parsePublicUrl(input, internalSearch = false) {
  check(typeof input === 'string' && input.length <= 2048 && !/[\x00-\x20\x7f\\]/.test(input), 'PUBLIC_URL');
  let url; try { url = new URL(input); } catch { fail('PUBLIC_URL'); }
  check(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && !url.hash, 'PUBLIC_URL', 'Нужна публичная HTTPS-ссылка без паролей и секретных параметров.');
  // Reject signed/token URLs rather than trying to recognize every credential scheme.
  if (url.search) check(internalSearch && url.origin === 'https://api.github.com' && url.pathname === '/search/repositories' && [...url.searchParams.keys()].every(k => k === 'q' || k === 'per_page'), 'SECRET_OR_QUERY_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  check(host && !/%/.test(host), 'PUBLIC_URL');
  if (isIP(host)) check(isPublicAddress(host), 'NON_PUBLIC_ADDRESS');
  else check(host.includes('.') && /^[a-z0-9.-]+$/.test(host) && !/(^|\.)(localhost|local|internal|home|lan|test|invalid|example)$/.test(host) && host.split('.').every(x => x && !x.startsWith('-') && !x.endsWith('-')), 'NON_PUBLIC_HOST');
  return { url, host };
}
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new PublicResourceError('TIME_LIMIT'));
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(new PublicResourceError('TIME_LIMIT'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
export async function nodeHttpsTransport({ url, address, signal }) {
  // The validated address is pinned into lookup; HTTPS keeps the original hostname
  // for Host/SNI/certificate verification. No redirects, proxies or credential headers.
  return new Promise((resolveResponse, reject) => {
    const request = https.request(url, { method: 'GET', signal, agent: false,
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'Kibi-Studio-Public-Resources/1' },
      lookup(_host, options, callback) {
        if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    }, response => resolveResponse({ statusCode: response.statusCode, headers: response.headers, body: response, dispose: () => response.destroy() }));
    request.on('error', reject); request.end();
  });
}
async function fetchPublic(input, { transport, lookup, maxBytes, internalSearch = false, timeoutMs = LIMITS.timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    let current = input;
    for (let redirects = 0; ; redirects++) {
      const { url, host } = parsePublicUrl(current, internalSearch);
      let addresses;
      if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
      else {
        try { addresses = await raceAbort(lookup(host, { all: true, verbatim: true }), controller.signal); }
        catch (error) { if (error instanceof PublicResourceError) throw error; fail('DNS_FAILED'); }
      }
      check(Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 32 && addresses.every(a => a && isPublicAddress(a.address) && isIP(a.address) === a.family), 'NON_PUBLIC_ADDRESS');
      response = await raceAbort(transport({ url: url.href, address: { ...addresses[0] }, signal: controller.signal }), controller.signal);
      check(response && Number.isInteger(response.statusCode) && response.body?.[Symbol.asyncIterator], 'TRANSPORT_RESPONSE');
      const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      check(!headers['set-cookie'] || Array.isArray(headers['set-cookie']) || typeof headers['set-cookie'] === 'string', 'TRANSPORT_RESPONSE');
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        check(redirects < LIMITS.redirects && typeof headers.location === 'string', 'REDIRECT_LIMIT');
        const next = new URL(headers.location, url).href;
        parsePublicUrl(next, internalSearch); response.dispose?.(); response = null; current = next; continue;
      }
      check(response.statusCode === 200, 'HTTP_STATUS', 'Публичный ресурс недоступен.');
      check(!headers['content-encoding'] || headers['content-encoding'] === 'identity', 'CONTENT_ENCODING');
      if (headers['content-length'] !== undefined) check(typeof headers['content-length'] === 'string' && /^\d+$/.test(headers['content-length']) && Number(headers['content-length']) <= maxBytes, 'BYTE_LIMIT');
      const chunks = []; let count = 0, size = 0;
      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        const part = await raceAbort(iterator.next(), controller.signal);
        if (part.done) break;
        check(Buffer.isBuffer(part.value) || part.value instanceof Uint8Array, 'TRANSPORT_CHUNK');
        const chunk = Buffer.from(part.value); size += chunk.length; count++;
        check(count <= LIMITS.chunks && size <= maxBytes, count > LIMITS.chunks ? 'CHUNK_LIMIT' : 'BYTE_LIMIT');
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), url: url.href, headers };
    }
  } catch (error) {
    if (error instanceof PublicResourceError) throw error;
    fail(controller.signal.aborted ? 'TIME_LIMIT' : 'FETCH_FAILED');
  } finally { clearTimeout(timer); response?.dispose?.(); controller.abort(); }
}
const textDecoder = new TextDecoder('utf-8', { fatal: true });
function utf8(bytes) { try { return textDecoder.decode(bytes); } catch { fail('TEXT_ENCODING'); } }
function cleanText(text) { return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); }
function extractReference(bytes, headers, base) {
  const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  check(/^text\//.test(type) || ['application/json', 'application/javascript', 'application/x-javascript', 'application/xml'].includes(type), 'TEXT_ONLY');
  const source = cleanText(utf8(bytes)); const links = [];
  for (const match of source.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    try { const u = new URL(match[1], base); u.hash = ''; parsePublicUrl(u.href); if (!links.includes(u.href)) links.push(u.href); } catch {}
    if (links.length >= LIMITS.links) break;
  }
  const text = type.includes('html') ? source.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : source;
  return { contentType: type, text: text.slice(0, LIMITS.textChars), truncated: text.length > LIMITS.textChars, links };
}

function dimensions(w, h) { check(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 4096 && h <= 4096 && w * h <= LIMITS.pixels, 'IMAGE_DIMENSIONS'); }
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function inspectEncodedImage(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMITS.assetBytes, 'BYTE_LIMIT');
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    let at = 8, width, height, depth, channels, rowBytes, palette = false, idatSeen = false, idatEnded = false, ended = false, count = 0; const idat = [];
    while (at + 12 <= bytes.length && ++count <= LIMITS.chunks) {
      const length = bytes.readUInt32BE(at), end = at + length + 12; check(end <= bytes.length, 'IMAGE_STRUCTURE');
      const type = bytes.toString('ascii', at + 4, at + 8), payload = bytes.subarray(at + 8, end - 4);
      check(/^[A-Za-z]{4}$/.test(type), 'IMAGE_STRUCTURE');
      check(crc32(bytes.subarray(at + 4, end - 4)) === bytes.readUInt32BE(end - 4), 'IMAGE_CRC');
      if (count === 1) check(type === 'IHDR' && length === 13, 'IMAGE_STRUCTURE');
      if (type === 'IHDR') {
        check(count === 1 && length === 13, 'IMAGE_STRUCTURE'); width = payload.readUInt32BE(0); height = payload.readUInt32BE(4); dimensions(width, height);
        depth = payload[8]; const color = payload[9]; channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color];
        check(channels && (color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16]).includes(depth) && payload[10] === 0 && payload[11] === 0 && payload[12] === 0, 'IMAGE_FORMAT');
        rowBytes = Math.ceil(width * depth * channels / 8); check((rowBytes + 1) * height <= 32 * 1024 * 1024, 'IMAGE_DIMENSIONS');
        palette = color !== 3;
      } else if (type === 'PLTE') { check(!idatSeen && length >= 3 && length <= 768 && length % 3 === 0, 'IMAGE_STRUCTURE'); palette = true;
      } else if (type === 'IDAT') { check(palette && !idatEnded, 'IMAGE_STRUCTURE'); idatSeen = true; idat.push(payload);
      } else if (type === 'IEND') { check(length === 0 && idatSeen && end === bytes.length, 'IMAGE_STRUCTURE'); ended = true; break;
      } else { check(type[0] === type[0].toLowerCase(), 'IMAGE_FORMAT'); if (idatSeen) idatEnded = true; }
      at = end;
    }
    check(ended, 'IMAGE_STRUCTURE');
    let inflated; try { const result = inflateSync(Buffer.concat(idat), { maxOutputLength: (rowBytes + 1) * height, info: true }); check(result.engine.bytesWritten === Buffer.concat(idat).length, 'IMAGE_STRUCTURE'); inflated = result.buffer; } catch (error) { if (error instanceof PublicResourceError) throw error; fail('IMAGE_COMPRESSION'); }
    check(inflated.length === (rowBytes + 1) * height && Array.from({ length: height }, (_, y) => inflated[y * (rowBytes + 1)]).every(x => x <= 4), 'IMAGE_STRUCTURE');
    return { format: 'png', width, height, frames: 1, encodedBytes: bytes.length, conversion: 'none' };
  }
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    check(bytes.length >= 14, 'IMAGE_STRUCTURE'); const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8); dimensions(width, height);
    let at = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0, blocks = 0, ended = false; const delaysMs = []; let delay = 0;
    const subblocks = () => { while (true) { check(at < bytes.length && ++blocks <= LIMITS.chunks, 'IMAGE_STRUCTURE'); const n = bytes[at++]; if (!n) break; check(at + n <= bytes.length, 'IMAGE_STRUCTURE'); at += n; } };
    while (at < bytes.length && ++blocks <= LIMITS.chunks) {
      const kind = bytes[at++];
      if (kind === 0x3b) { check(at === bytes.length && frames > 0, 'IMAGE_STRUCTURE'); ended = true; break; }
      if (kind === 0x21) {
        check(at < bytes.length, 'IMAGE_STRUCTURE'); const label = bytes[at++];
        if (label === 0xf9) { check(at + 6 <= bytes.length && bytes[at] === 4 && bytes[at + 5] === 0, 'IMAGE_STRUCTURE'); delay = bytes.readUInt16LE(at + 2) * 10; }
        subblocks();
      } else if (kind === 0x2c) {
        check(at + 9 <= bytes.length, 'IMAGE_STRUCTURE'); const x = bytes.readUInt16LE(at), y = bytes.readUInt16LE(at + 2), w = bytes.readUInt16LE(at + 4), h = bytes.readUInt16LE(at + 6); dimensions(w, h); check(x + w <= width && y + h <= height, 'IMAGE_DIMENSIONS'); const flags = bytes[at + 8]; at += 9;
        if (flags & 128) at += 3 * (1 << ((flags & 7) + 1));
        check(at < bytes.length && bytes[at] >= 2 && bytes[at] <= 8, 'IMAGE_STRUCTURE'); at++; subblocks();
        frames++; check(frames <= LIMITS.gifFrames, 'IMAGE_FRAME_LIMIT'); delaysMs.push(delay); delay = 0;
      } else fail('IMAGE_STRUCTURE');
    }
    check(ended, 'IMAGE_STRUCTURE'); return { format: 'gif', width, height, frames, delaysMs, encodedBytes: bytes.length, conversion: 'none', decoderHeader: 'AnimatedGIF.h', validation: 'container-and-dimensions; decoder not executed', decoderApi: 'Read the actual SDK header; no decoder API is guessed by this importer.' };
  }
  if (bytes.toString('ascii', 0, 2) === 'BM') {
    check(bytes.length >= 54, 'IMAGE_STRUCTURE'); const dib = bytes.readUInt32LE(14), size = bytes.readUInt32LE(2), pixelOffset = bytes.readUInt32LE(10);
    check([40, 108, 124].includes(dib) && bytes.length >= 14 + dib && size === bytes.length && bytes.readUInt32LE(6) === 0, 'IMAGE_STRUCTURE');
    const width = bytes.readInt32LE(18), height = Math.abs(bytes.readInt32LE(22)), bpp = bytes.readUInt16LE(28); dimensions(width, height);
    check(bytes.readUInt16LE(26) === 1 && [1, 4, 8, 16, 24, 32].includes(bpp) && bytes.readUInt32LE(30) === 0, 'IMAGE_FORMAT');
    const colors = bpp <= 8 ? (bytes.readUInt32LE(46) || (1 << bpp)) : 0; check(colors <= (1 << Math.min(bpp, 8)), 'IMAGE_STRUCTURE');
    const stride = Math.ceil(width * bpp / 32) * 4; check(pixelOffset >= 14 + dib + colors * 4 && pixelOffset + stride * height <= bytes.length, 'IMAGE_STRUCTURE');
    return { format: 'bmp', width, height, bitsPerPixel: bpp, frames: 1, encodedBytes: bytes.length, conversion: 'none' };
  }
  fail('IMAGE_FORMAT', 'Поддерживаются проверенные PNG, GIF и несжатые BMP; SVG и исполняемые файлы не импортируются.');
}

function actualPublicInterface(header, namespace) {
  const lines = header.split('\n').filter(line => /^struct Entry |^static constexpr size_t k(?:Width|FrameCount|EntryCount)|^inline (?:const Entry\* GetEntry|bool DecodeFrame|bool DecodeEntryFrame|uint16_t FrameIntervalMs|const uint8_t\* EncodedData|size_t EncodedSize)/.test(line));
  return `namespace ${namespace} {\n${lines.map(line => line.startsWith('inline ') ? line.slice(0, line.indexOf('{')).trim() + ';' : line).join('\n')}\n}`;
}
const byteArray = bytes => Array.from(bytes).join(',');
export function encodeByteRle(bytes) {
  const out = []; for (let at = 0; at < bytes.length;) { const value = bytes[at]; let n = 1; while (n < 255 && at + n < bytes.length && bytes[at + n] === value) n++; out.push(n, value); at += n; } return Buffer.from(out);
}
/** Pure header generator for trusted metadata and data. Not an AI tool or code executor. */
export function generateBitmapHeader(frames, entries, namespace = 'KibiPublicLeroydC309') {
  check(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(namespace) && frames.length > 0 && frames.length <= 255 && entries.length > 0 && entries.length <= 255, 'ASSET_METADATA');
  for (const f of frames) check(Buffer.isBuffer(f) && f.length === 1024, 'ASSET_METADATA');
  for (const e of entries) check(/^[a-z][a-z0-9_]{0,31}$/.test(e.name) && Array.isArray(e.order) && e.order.length > 0 && e.order.length <= 255 && e.order.every(i => Number.isInteger(i) && i >= 0 && i < frames.length) && Number.isInteger(e.baseIntervalMs) && e.baseIntervalMs >= 0 && e.baseIntervalMs <= 65535 && (!e.perFrameIntervalMs || (e.perFrameIntervalMs.length === e.order.length && e.perFrameIntervalMs.every(x => Number.isInteger(x) && x >= 0 && x <= 65535))) && Number.isInteger(e.loopEndFieldMs ?? 0) && (e.loopEndFieldMs ?? 0) >= 0 && (e.loopEndFieldMs ?? 0) <= 65535, 'ASSET_METADATA');
  const lines = ['#pragma once', '#include <cstddef>', '#include <cstdint>', '#include <cstring>', '// Exact raw public bitmap data. No image conversion, interpolation or runtime code loading.', '// Timing fields are inferred milliseconds; original mode/neutral overrides are not reproduced.', `namespace ${namespace} {`, 'static constexpr size_t kWidth=128, kHeight=64, kFrameBytes=1024;', 'struct Frame { const uint8_t* data; size_t size; };', 'struct Entry { const char* name; const uint8_t* order; size_t count; uint16_t baseIntervalMs; const uint16_t* perFrameIntervals; bool semanticsKnown; uint16_t loopEndFieldMs; };'];
  const rles = frames.map(encodeByteRle);
  rles.forEach((r, i) => lines.push(`static const uint8_t kRle${i}[]={${byteArray(r)}};`));
  lines.push(`static const Frame kFrames[]={${rles.map((_, i) => `{kRle${i},sizeof(kRle${i})}`).join(',')}};`);
  entries.forEach((e, i) => { lines.push(`static const uint8_t kOrder${i}[]={${e.order.join(',')}};`); if (e.perFrameIntervalMs) lines.push(`static const uint16_t kIntervals${i}[]={${e.perFrameIntervalMs.join(',')}};`); });
  lines.push(`static const Entry kEntries[]={${entries.map((e, i) => `{"${e.name}",kOrder${i},sizeof(kOrder${i}),${e.baseIntervalMs},${e.perFrameIntervalMs ? `kIntervals${i}` : 'nullptr'},${e.semanticsKnown === false ? 'false' : 'true'},${e.loopEndFieldMs || 0}}`).join(',')}};`);
  lines.push('static constexpr size_t kFrameCount=sizeof(kFrames)/sizeof(kFrames[0]);', 'static constexpr size_t kEntryCount=sizeof(kEntries)/sizeof(kEntries[0]);', 'inline const Entry* GetEntry(size_t index) { return index<kEntryCount ? &kEntries[index] : nullptr; }',
    'inline bool DecodeFrame(size_t index,uint8_t* out,size_t capacity) {', ' if(index>=kFrameCount || !out || capacity<kFrameBytes) return false;', ' const Frame& f=kFrames[index]; if(f.size%2) return false; size_t n=0;', ' for(size_t i=0;i<f.size;i+=2) { size_t count=f.data[i]; if(!count || count>kFrameBytes-n) return false; std::memset(out+n,f.data[i+1],count); n+=count; }', ' return n==kFrameBytes;', '}',
    'inline bool DecodeEntryFrame(size_t entry,size_t position,uint8_t* out,size_t capacity) { const Entry* e=GetEntry(entry); return e && position<e->count && DecodeFrame(e->order[position],out,capacity); }',
    'inline uint16_t FrameIntervalMs(size_t entry,size_t position) { const Entry* e=GetEntry(entry); return !e || position>=e->count ? 0 : e->perFrameIntervals ? e->perFrameIntervals[position] : e->baseIntervalMs; }', '}');
  return lines.join('\n') + '\n';
}
function recipeAsset(bytes) {
  const recipe = PINNED_RECIPE;
  check(recipe.id === RECIPE_ID && recipe.sourceSha256 === FIRMWARE_HASH && bytes.length === recipe.sourceBytes && sha256(bytes) === FIRMWARE_HASH, 'SOURCE_HASH_MISMATCH');
  const frames = [], frameMetadata = [], offsets = new Map(), hashes = new Map();
  for (const f of recipe.frames) {
    check(Number.isSafeInteger(f.offset) && f.offset >= 0 && f.offset + 1024 <= bytes.length, 'RECIPE_METADATA');
    const raw = bytes.subarray(f.offset, f.offset + 1024); check(sha256(raw) === f.sha256, 'FRAME_HASH_MISMATCH');
    let index = hashes.get(f.sha256);
    if (index === undefined) { index = frames.length; hashes.set(f.sha256, index); frames.push(Buffer.from(raw)); frameMetadata.push({ sha256: f.sha256, sourceOffsets: [] }); }
    offsets.set(f.offset, index); frameMetadata[index].sourceOffsets.push(f.offset);
  }
  const entries = recipe.entries.map(e => ({ ...e, order: e.order.map(off => { check(offsets.has(off), 'RECIPE_METADATA'); return offsets.get(off); }) }));
  check(frames.length === 30 && entries.length === 14 && entries.reduce((n, e) => n + e.order.length, 0) === 42, 'RECIPE_METADATA');
  return { header: generateBitmapHeader(frames, entries), metadata: { recipeId: recipe.id, sourceUrl: recipe.sourceUrl, sourceSha256: FIRMWARE_HASH, geometry: recipe.geometry, frames: frameMetadata, entries, timing: recipe.timing, license: recipe.license, completeness: recipe.completeness } };
}
function encodedHeader(bytes, info, namespace) {
  return `#pragma once\n#include <cstddef>\n#include <cstdint>\n// Encoded ${info.format.toUpperCase()} bytes preserved exactly; this header does not decode or execute them.\nnamespace ${namespace} {\nstatic constexpr size_t kWidth=${info.width},kHeight=${info.height};\nstatic const uint8_t kEncoded[]={${byteArray(bytes)}};\ninline const uint8_t* EncodedData(){return kEncoded;}\ninline size_t EncodedSize(){return sizeof(kEncoded);}\n}\n`;
}
function safeInstalledPaths(value, expected) {
  check(value && Array.isArray(value.paths) && value.paths.length === expected.length && value.paths.every((p, i) => typeof p === 'string' && p === expected[i] && !isAbsolute(p) && !p.includes('..') && /^[A-Za-z0-9_./-]+$/.test(p)), 'INSTALL_RESULT');
  return [...value.paths];
}
async function readPublicHeader(roots, name) {
  check(typeof name === 'string' && Object.hasOwn(SDK_HEADERS, name), 'SDK_HEADER_NOT_ALLOWED');
  const root = roots[SDK_HEADERS[name]]; check(typeof root === 'string' && isAbsolute(root), 'SDK_NOT_AVAILABLE', 'Этот публичный SDK-заголовок не подключён к сервису.');
  const resolvedRoot = resolve(root); check(await realpath(resolvedRoot) === resolvedRoot, 'SDK_PATH');
  const rootStat = await lstat(resolvedRoot); check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'SDK_PATH');
  const path = join(resolvedRoot, name); check(basename(path) === name && relative(resolvedRoot, path) === name, 'SDK_PATH');
  check(await realpath(path) === path, 'SDK_PATH');
  const before = await lstat(path); check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= LIMITS.headerBytes, 'SDK_FILE');
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); check(stat.isFile() && stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino && stat.size <= LIMITS.headerBytes, 'SDK_FILE');
    const chunks = []; let size = 0;
    while (true) { const part = Buffer.alloc(16384); const result = await handle.read(part, 0, part.length, null); if (!result.bytesRead) break; size += result.bytesRead; check(size <= LIMITS.headerBytes, 'BYTE_LIMIT'); chunks.push(part.subarray(0, result.bytesRead)); }
    const after = await lstat(path), final = await handle.stat(); check(after.ino === stat.ino && after.dev === stat.dev && after.nlink === 1 && !after.isSymbolicLink() && final.nlink === 1 && final.size === size && final.mtimeMs === stat.mtimeMs && final.ctimeMs === stat.ctimeMs && after.mtimeMs === stat.mtimeMs && await realpath(path) === path && await realpath(resolvedRoot) === resolvedRoot, 'SDK_CHANGED');
    const bytes = Buffer.concat(chunks); return { name, bytes: bytes.length, sha256: sha256(bytes), text: utf8(bytes), evidence: 'public-header-only; no target/device readiness claimed' };
  } finally { await handle.close(); }
}

export function createPublicResourceService({ transport = nodeHttpsTransport, lookup = dnsLookup, getProjectContext, installAsset, sdkRoots = {}, timeoutMs = LIMITS.timeoutMs } = {}) {
  check(typeof transport === 'function' && typeof lookup === 'function' && Number.isInteger(timeoutMs) && timeoutMs >= 20 && timeoutMs <= LIMITS.timeoutMs, 'SERVICE_CONFIG');
  const roots = Object.freeze({ device: sdkRoots.device, opus: sdkRoots.opus, gif: sdkRoots.gif });
  const fetch = (url, maxBytes, internalSearch = false) => fetchPublic(url, { transport, lookup, maxBytes, internalSearch, timeoutMs });
  return Object.freeze({
    async searchPublicResources(query) {
      check(typeof query === 'string' && query.trim().length >= 2 && query.length <= 160 && !/[\x00-\x1f\x7f]/.test(query), 'SEARCH_QUERY');
      const url = new URL('https://api.github.com/search/repositories'); url.searchParams.set('q', query.trim()); url.searchParams.set('per_page', '8');
      const response = await fetch(url.href, LIMITS.textBytes, true); let data; try { data = JSON.parse(utf8(response.bytes)); } catch { fail('SEARCH_RESPONSE'); }
      check(Array.isArray(data.items), 'SEARCH_RESPONSE');
      const results = data.items.slice(0, 8).flatMap(item => { try { const { url: u } = parsePublicUrl(item.html_url); check(u.hostname === 'github.com' && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(u.pathname), 'SEARCH_RESPONSE'); return [{ name: cleanText(String(item.full_name || '')).slice(0, 160), url: u.href, description: cleanText(String(item.description || '')).slice(0, 400), declaredLicense: typeof item.license?.spdx_id === 'string' ? item.license.spdx_id.slice(0, 64) : null, licenseVerified: false }]; } catch { return []; } });
      return { results, source: 'GitHub public unauthenticated repository search', licenseNote: 'Лицензия поиска — подсказка; перед копированием проверяйте LICENSE конкретного проекта.' };
    },
    async openPublicReference(url) { const response = await fetch(url, LIMITS.textBytes); return { url: response.url, ...extractReference(response.bytes, response.headers, response.url), evidence: 'text-only; scripts not executed', untrusted: true }; },
    async readSdkHeader(name) { try { return await readPublicHeader(roots, name); } catch (error) { if (error instanceof PublicResourceError) throw error; fail('SDK_FILE'); } },
    async importPublicAsset(url, { expectedProjectId, recipe } = {}) {
      check(typeof getProjectContext === 'function' && typeof installAsset === 'function' && safeId(expectedProjectId), 'IMPORT_CONFIG');
      const expected = projectShape(await getProjectContext()); check(expected.id === expectedProjectId, 'PROJECT_CHANGED', 'Выбранный проект изменился.');
      const assertProjectCurrent = async () => { const current = projectShape(await getProjectContext()); check(current.id === expected.id && current.generation === expected.generation, 'PROJECT_CHANGED', 'Выбранный проект изменился.'); };
      let selectedRecipe = false;
      if (recipe !== undefined && recipe !== null) { check(recipe === RECIPE_ID || (typeof recipe === 'object' && Object.keys(recipe).length === 1 && recipe.id === RECIPE_ID), 'RECIPE_NOT_ALLOWED'); check(url === PINNED_RECIPE.sourceUrl, 'RECIPE_URL'); selectedRecipe = true; }
      const response = await fetch(url, LIMITS.assetBytes); await assertProjectCurrent();
      const sourceSha256 = sha256(response.bytes); let header, metadata, api, summary;
      const assetId = `${selectedRecipe ? 'leroyd_c309' : 'public_image'}_${sourceSha256.slice(0, 16)}`;
      const headerPath = MANAGED_ASSET_PATH;
      if (selectedRecipe) {
        const asset = recipeAsset(response.bytes); header = asset.header; metadata = asset.metadata;
        api = { include: headerPath, namespace: 'KibiPublicLeroydC309', frameBytes: 1024, decode: 'bool DecodeEntryFrame(size_t entry,size_t position,uint8_t* out,size_t capacity)', entry: 'const Entry* GetEntry(size_t index)', interval: 'uint16_t FrameIntervalMs(size_t entry,size_t position)', counts: { entries: 14, positions: 42, uniqueFrames: 30 }, timing: 'base/per-frame fields only; neutral overrides not recreated', msg: 'entry13; purpose unknown' };
        api.interface = actualPublicInterface(header, api.namespace);
        api.constants = { kWidth: 128, kHeight: 64, kFrameBytes: 1024, kEntryCount: metadata.entries.length, kFrameCount: metadata.frames.length };
        api.entryFields = header.match(/struct Entry \{ ([^}]*) \};/)[1].split(';').map(field => field.trim()).filter(Boolean);
        api.entryOrder = metadata.entries.map(entry => entry.name);
        summary = 'Импортированы точные 1bpp-кадры 128×64: 14 записей, 42 позиции, 30 уникальных изображений. Назначение msg и полное поведение таймингов не подтверждены.';
      } else {
        const info = inspectEncodedImage(response.bytes); const namespace = `KibiPublicAsset_${sourceSha256.slice(0, 16)}`; header = encodedHeader(response.bytes, info, namespace);
        metadata = { sourceUrl: response.url, sourceSha256, image: info, license: { status: 'unknown' }, renderer: 'Encoded bytes only. No conversion/render adapter or hardware readiness is claimed.' };
        api = { include: headerPath, namespace, access: 'const uint8_t* EncodedData(); size_t EncodedSize()', image: info, rendering: 'Use a decoder actually present in the SDK; readSdkHeader("AnimatedGIF.h") for GIF. No guessed API.' };
        api.interface = actualPublicInterface(header, namespace);
        api.constants = { kWidth: info.width, kHeight: info.height };
        summary = `Сохранён ${info.format.toUpperCase()} ${info.width}×${info.height} без изменения исходных байтов; адаптер отрисовки не создавался.`;
      }
      const assetSource = header + '\n/* PUBLIC RESOURCE METADATA\n' + JSON.stringify(metadata, null, 2).replace(/\*\//g, '* /') + '\n*/\n';
      const files = [{ path: headerPath, content: createManagedAssetBlock(assetId, assetSource) }];
      await assertProjectCurrent();
      const installed = await installAsset({ expectedProjectId: expected.id, expectedProjectGeneration: expected.generation, mode: 'append-only', assetId, files, metadata, assertProjectCurrent });
      await assertProjectCurrent();
      return { ok: true, projectId: expected.id, assetId, paths: safeInstalledPaths(installed, files.map(f => f.path)), api, source: { url: response.url, sha256: sourceSha256 }, summary, licenseStatus: 'unknown' };
    },
  });
}
