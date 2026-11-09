import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createPublicResourceService, PublicResourceError, isPublicAddress, nodeHttpsTransport, inspectEncodedImage, generateBitmapHeader, encodeByteRle } from './public-resources.mjs';

const PUBLIC_IP = '93.184.216.34';
const lookup = async () => [{ address: PUBLIC_IP, family: 4 }];
const context = () => ({ id: 'new-project', generation: 4, publicAssetImportsAllowed: true });
function response(bytes = Buffer.alloc(0), { status = 200, headers = {}, chunks } = {}) {
  return { statusCode: status, headers, body: (async function* () { for (const chunk of chunks || [bytes]) yield chunk; })(), dispose() {} };
}
const errorCode = code => error => error instanceof PublicResourceError && error.code === code;
function crc(bytes) { let n = 0xffffffff; for (const x of bytes) { n ^= x; for (let i = 0; i < 8; i++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1; } return (n ^ 0xffffffff) >>> 0; }
function pngChunk(name, bytes) { const kind = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(Buffer.concat([kind, bytes]))); return Buffer.concat([size, kind, bytes, checksum]); }
function png() { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2); ihdr.writeUInt32BE(2, 4); ihdr[8] = 1; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.from([0, 0x80, 0, 0x40]))), pngChunk('IEND', Buffer.alloc(0))]); }
function bmp() { const b = Buffer.alloc(58); b.write('BM'); b.writeUInt32LE(58, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14); b.writeInt32LE(1, 18); b.writeInt32LE(1, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b[54] = 12; b[55] = 34; b[56] = 56; return b; }
function gif() { return Buffer.from([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,0,2,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]); }

// All transports and DNS calls below are injected or mocked; no external network.
test('blocks local, private, shared, documentation, multicast and reserved addresses', () => {
  for (const ip of ['0.0.0.0','10.1.2.3','100.64.1.2','127.0.0.1','169.254.169.254','172.31.0.1','192.168.1.2','192.0.0.9','192.0.2.1','198.19.2.1','198.51.100.2','203.0.113.1','224.0.0.1','240.0.0.1','255.255.255.255','::','::1','::ffff:8.8.8.8','fc00::1','fe80::1','ff02::1','2001:db8::1','2001::1','2002:7f00:1::1','3fff:1::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', PUBLIC_IP, '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});
test('rejects credentials, secret queries, HTTP, unusual ports and numeric local aliases before network', async () => {
  let calls = 0;
  const service = createPublicResourceService({ lookup, transport: async () => { calls++; throw Error('must not run'); } });
  for (const url of ['http://example.org/','https://user:password@example.org/','https://example.org:8443/','https://example.org/a?token=secret','https://example.org/a#secret','https://127.1/','https://0x7f000001/','https://2130706433/','https://[::1]/','https://localhost/','https://private.local/']) await assert.rejects(service.openPublicReference(url), error => error instanceof PublicResourceError, url);
  assert.equal(calls, 0);
});
test('rejects a DNS answer set containing even one private address', async () => {
  let calls = 0;
  const service = createPublicResourceService({ lookup: async () => [{address:PUBLIC_IP,family:4},{address:'10.0.0.1',family:4}], transport: async () => { calls++; } });
  await assert.rejects(service.openPublicReference('https://assets.example.org/'), errorCode('NON_PUBLIC_ADDRESS')); assert.equal(calls, 0);
});
test('pins the validated DNS address into HTTPS lookup without cookies/auth or disabled TLS', async t => {
  let captured;
  t.mock.method(https, 'request', (url, options, callback) => {
    captured = options;
    const request = new EventEmitter(); request.end = () => callback(Object.assign(Readable.from([Buffer.from('ok')]), { statusCode: 200, headers: {} }));
    return request;
  });
  const signal = new AbortController().signal;
  const r = await nodeHttpsTransport({url:'https://assets.example.org/',address:{address:PUBLIC_IP,family:4},signal});
  assert.equal(r.statusCode, 200); assert.equal(captured.method, 'GET'); assert.equal(captured.agent, false); assert.equal(captured.rejectUnauthorized, undefined);
  assert.equal(Object.keys(captured.headers).some(x => /cookie|authorization/i.test(x)), false);
  captured.lookup('rebound.example.org', {all:true}, (e, addresses) => { assert.equal(e, null); assert.deepEqual(addresses,[{address:PUBLIC_IP,family:4}]); });
  captured.lookup('rebound.example.org', {}, (e, address, family) => { assert.equal(e, null); assert.equal(address, PUBLIC_IP); assert.equal(family, 4); }); r.dispose();
});
test('revalidates every redirect and blocks an HTTPS redirect to loopback', async () => {
  let calls = 0;
  const service = createPublicResourceService({lookup, transport: async ({address}) => { calls++; assert.equal(address.address, PUBLIC_IP); return response(undefined,{status:302,headers:{location:'https://127.0.0.1/private'}}); }});
  await assert.rejects(service.openPublicReference('https://assets.example.org/'), errorCode('NON_PUBLIC_ADDRESS')); assert.equal(calls, 1);
});
test('same-host DNS rebinding on redirect is revalidated, not trusted from previous response', async () => {
  let resolutions=0,calls=0;
  const service=createPublicResourceService({lookup:async()=>[{address:++resolutions===1?PUBLIC_IP:'169.254.169.254',family:4}],transport:async()=>{calls++;return response(undefined,{status:302,headers:{location:'/next'}});}});
  await assert.rejects(service.openPublicReference('https://assets.example.org/start'),errorCode('NON_PUBLIC_ADDRESS'));assert.equal(calls,1);assert.equal(resolutions,2);
});
test('caps redirects, advertised and streamed bytes, chunks and encoded responses', async () => {
  let calls=0; const redirect=createPublicResourceService({lookup,transport:async()=>{calls++;return response(undefined,{status:302,headers:{location:'/again'}});}});
  await assert.rejects(redirect.openPublicReference('https://assets.example.org/'),errorCode('REDIRECT_LIMIT')); assert.equal(calls,4);
  for (const [r,code] of [
    [response(undefined,{headers:{'content-length':'999999999'}}),'BYTE_LIMIT'],
    [response(Buffer.alloc(256*1024+1)),'BYTE_LIMIT'],
    [response(undefined,{chunks:Array.from({length:4097},()=>Buffer.alloc(0))}),'CHUNK_LIMIT'],
    [response(Buffer.from('x'),{headers:{'content-encoding':'gzip'}}),'CONTENT_ENCODING'],
  ]) await assert.rejects(createPublicResourceService({lookup,transport:async()=>r}).openPublicReference('https://assets.example.org/'),errorCode(code));
});
test('deadline bounds stalled DNS and stalled response chunks', async () => {
  const stalled = () => new Promise(()=>{});
  await assert.rejects(createPublicResourceService({lookup:stalled,transport:stalled,timeoutMs:30}).openPublicReference('https://assets.example.org/'),errorCode('TIME_LIMIT'));
  await assert.rejects(createPublicResourceService({lookup,timeoutMs:30,transport:async()=>({statusCode:200,headers:{},body:{[Symbol.asyncIterator](){return {next:stalled};}}})}).openPublicReference('https://assets.example.org/'),errorCode('TIME_LIMIT'));
});
test('opens HTML as untrusted plain text and links without script execution', async () => {
  globalThis.__publicResourceExecuted = false;
  const html='<h1>Public docs</h1><script>globalThis.__publicResourceExecuted=true</script><a href="/source.txt">source</a><a href="https://127.0.0.1/">private</a><a href="/signed?token=secret">secret</a>';
  const result=await createPublicResourceService({lookup,transport:async()=>response(Buffer.from(html),{headers:{'content-type':'text/html'}})}).openPublicReference('https://assets.example.org/');
  assert.equal(globalThis.__publicResourceExecuted,false);delete globalThis.__publicResourceExecuted;
  assert.equal(result.text.includes('__publicResourceExecuted'),false);assert.equal(result.untrusted,true);assert.deepEqual(result.links,['https://assets.example.org/source.txt']);
});
test('legacy JavaScript MIME is readable source text and is never executed',async()=>{
  globalThis.__publicScriptExecuted=false;
  const source='globalThis.__publicScriptExecuted=true; const faces=[\"neutral\"];';
  const r=await createPublicResourceService({lookup,transport:async()=>response(Buffer.from(source),{headers:{'content-type':'application/x-javascript'}})}).openPublicReference('https://leroyd.com/script.js');
  assert.equal(r.text,source);assert.equal(r.untrusted,true);assert.equal(globalThis.__publicScriptExecuted,false);delete globalThis.__publicScriptExecuted;
});
test('search uses unauthenticated GitHub GET and filters untrusted result URLs/license claims', async () => {
  let seen;
  const service=createPublicResourceService({lookup,transport:async request=>{seen=new URL(request.url);return response(Buffer.from(JSON.stringify({items:[{full_name:'owner/public',html_url:'https://github.com/owner/public',description:'D',license:{spdx_id:'MIT'}},{html_url:'https://127.0.0.1/a/b'}]})));}});
  const r=await service.searchPublicResources('animated eyes');assert.equal(seen.origin,'https://api.github.com');assert.equal(seen.searchParams.get('q'),'animated eyes');assert.equal(seen.searchParams.get('per_page'),'8');assert.equal(r.results.length,1);assert.equal(r.results[0].declaredLicense,'MIT');assert.equal(r.results[0].licenseVerified,false);
});
test('PNG/GIF/BMP imports validate dimensions/containers, preserve bytes, and reject script formats', () => {
  assert.deepEqual(inspectEncodedImage(png()),{format:'png',width:2,height:2,frames:1,encodedBytes:png().length,conversion:'none'});
  assert.equal(inspectEncodedImage(gif()).frames,1);assert.deepEqual(inspectEncodedImage(gif()).delaysMs,[20]);assert.equal(inspectEncodedImage(bmp()).bitsPerPixel,24);
  for(const bytes of [Buffer.from('<svg onload="eval(1)"/>'),Buffer.from('<html>hello</html>'),Buffer.from('MZ executable'),png().subarray(0,-1),Buffer.concat([gif(),Buffer.from('html')])]) assert.throws(()=>inspectEncodedImage(bytes),PublicResourceError);
  const corrupt=png();corrupt[45]^=1;assert.throws(()=>inspectEncodedImage(corrupt),errorCode('IMAGE_CRC'));
  const huge=bmp();huge.writeInt32LE(100000,18);assert.throws(()=>inspectEncodedImage(huge),errorCode('IMAGE_DIMENSIONS'));
});
test('ordinary image install only calls the trusted append-only installer and returns compact API paths', async () => {
  let installed;const original=gif();
  const s=createPublicResourceService({lookup,getProjectContext:context,transport:async()=>response(original),installAsset:async request=>{installed=request;await request.assertProjectCurrent();return {paths:request.files.map(f=>f.path)};}});
  const r=await s.importPublicAsset('https://assets.example.org/a.gif',{expectedProjectId:'new-project'});
  assert.equal(installed.mode,'append-only');assert.equal(installed.expectedProjectGeneration,4);assert.equal(installed.files.length,1);assert.equal(installed.files[0].path,'embedded_assets.h');assert.equal(installed.files[0].content.startsWith('// KIBI_ASSET_BEGIN '),true);assert.equal(installed.files[0].content.includes('/* PUBLIC RESOURCE METADATA\n'),true);assert.equal(r.api.image.decoderHeader,'AnimatedGIF.h');assert.equal(r.api.image.conversion,'none');assert.ok(r.api.interface.includes('const uint8_t* EncodedData();'));assert.ok(r.api.interface.includes('size_t EncodedSize();'));assert.equal(r.api.interface.includes('kEncoded[]'),false);assert.deepEqual(r.api.constants,{kWidth:1,kHeight:1});assert.deepEqual(r.paths,['embedded_assets.h']);assert.equal(r.api.include,'embedded_assets.h');
  const match=installed.files[0].content.match(/kEncoded\[\]=\{([\d,]+)\}/);assert.deepEqual(Buffer.from(match[1].split(',').map(Number)),original);assert.equal(JSON.stringify(r).length<5000,true);
});
test('project switch, generation change and revocation before import prevent network/install', async () => {
  for(const c of [{id:'other-project',generation:4,publicAssetImportsAllowed:true},{id:'new-project',generation:4,publicAssetImportsAllowed:false}]){
    let calls=0;const s=createPublicResourceService({lookup,getProjectContext:()=>c,transport:async()=>{calls++;},installAsset:async()=>{calls++;}});
    await assert.rejects(s.importPublicAsset('https://assets.example.org/a.bmp',{expectedProjectId:'new-project'}),PublicResourceError);assert.equal(calls,0);
  }
  for(const change of [c=>c.id='another-project',c=>c.generation++,c=>c.publicAssetImportsAllowed=false]){
    const current=context();let writes=0;
    const s=createPublicResourceService({lookup,getProjectContext:()=>current,transport:async()=>{change(current);return response(bmp());},installAsset:async()=>{writes++;}});
    await assert.rejects(s.importPublicAsset('https://assets.example.org/a.bmp',{expectedProjectId:'new-project'}),PublicResourceError);assert.equal(writes,0);
  }
});
test('trusted installer gets a commit guard, and service validates identity again after awaiting callback', async () => {
  const current=context();let writes=0;
  const guarded=createPublicResourceService({lookup,getProjectContext:()=>current,transport:async()=>response(bmp()),installAsset:async request=>{current.generation++;await request.assertProjectCurrent();writes++;return {paths:request.files.map(f=>f.path)};}});
  await assert.rejects(guarded.importPublicAsset('https://assets.example.org/a.bmp',{expectedProjectId:'new-project'}),errorCode('PROJECT_CHANGED'));assert.equal(writes,0);
  const late=context();const postcheck=createPublicResourceService({lookup,getProjectContext:()=>late,transport:async()=>response(bmp()),installAsset:async request=>{await Promise.resolve();late.publicAssetImportsAllowed=false;return {paths:request.files.map(f=>f.path)};}});
  await assert.rejects(postcheck.importPublicAsset('https://assets.example.org/a.bmp',{expectedProjectId:'new-project'}),errorCode('IMPORT_REVOKED'));
});
test('unknown recipes, source changes, forged paths and unverified binary never install', async () => {
  let installs=0;const service=createPublicResourceService({lookup,getProjectContext:context,transport:async()=>response(Buffer.from('not firmware')),installAsset:async()=>{installs++;}});
  await assert.rejects(service.importPublicAsset('https://leroyd.com/oled.ino.bin',{expectedProjectId:'new-project',recipe:'leroyd-c309-public-b59a5c23'}),errorCode('SOURCE_HASH_MISMATCH'));
  await assert.rejects(service.importPublicAsset('https://evil.example.org/oled.ino.bin',{expectedProjectId:'new-project',recipe:'leroyd-c309-public-b59a5c23'}),errorCode('RECIPE_URL'));
  await assert.rejects(service.importPublicAsset('https://leroyd.com/oled.ino.bin',{expectedProjectId:'new-project',recipe:{id:'leroyd-c309-public-b59a5c23',execute:true}}),errorCode('RECIPE_NOT_ALLOWED'));
  assert.equal(installs,0);
  const bad=createPublicResourceService({lookup,getProjectContext:context,transport:async()=>response(bmp()),installAsset:async()=>({paths:['../../outside.h','bad']})});
  await assert.rejects(bad.importPublicAsset('https://assets.example.org/a.bmp',{expectedProjectId:'new-project'}),errorCode('INSTALL_RESULT'));
});
test('fixed SDK header names, no symlinks/hardlinks, size limits and no private paths', async t => {
  const root=await mkdtemp('/private/tmp/kibi-public-sdk-test-');t.after(()=>rm(root,{recursive:true,force:true}));
  const device=join(root,'public');await mkdir(device);await writeFile(join(device,'network_gate.h'),'#pragma once\n// public SDK interface\n');
  const s=createPublicResourceService({lookup,transport:async()=>{throw Error('network forbidden');},sdkRoots:{device}});
  const r=await s.readSdkHeader('network_gate.h');assert.equal(r.text.includes('public SDK'),true);assert.equal(r.name,'network_gate.h');
  for(const name of ['../private.h','/etc/passwd','__proto__','random.h','config.h','server_config.h','cloud_voice_config.h','wifi.h']) await assert.rejects(s.readSdkHeader(name),errorCode('SDK_HEADER_NOT_ALLOWED'));
  await assert.rejects(s.readSdkHeader('KibiOpus.h'),errorCode('SDK_NOT_AVAILABLE'));
  await symlink(join(device,'network_gate.h'),join(device,'http_json.h'));await assert.rejects(s.readSdkHeader('http_json.h'),PublicResourceError);
  await link(join(device,'network_gate.h'),join(device,'audio_codec_power.h'));await assert.rejects(s.readSdkHeader('audio_codec_power.h'),errorCode('SDK_FILE'));
  await writeFile(join(device,'kibi_typography.h'),Buffer.alloc(256*1024+1));await assert.rejects(s.readSdkHeader('kibi_typography.h'),errorCode('SDK_FILE'));
  const alias=join(root,'alias');await symlink(device,alias);await assert.rejects(createPublicResourceService({sdkRoots:{device:alias}}).readSdkHeader('network_gate.h'),errorCode('SDK_PATH'));
});
function decodeRle(bytes){const out=[];assert.equal(bytes.length%2,0);for(let i=0;i<bytes.length;i+=2){assert.ok(bytes[i]>0);for(let n=0;n<bytes[i];n++)out.push(bytes[i+1]);}return Buffer.from(out);}
test('byte RLE is lossless for long runs and all byte values',()=>{for(const raw of [Buffer.alloc(1024),Buffer.alloc(1024,255),Buffer.from(Array.from({length:1024},(_,i)=>i&255))])assert.deepEqual(decodeRle(encodeByteRle(raw)),raw);});
test('generated portable C++ decoder round-trips exact frames, entry order and bounds',async t=>{
  const compiler=spawnSync('c++',['--version']);if(compiler.error?.code==='ENOENT'){t.skip('No system C++ compiler');return;}
  const root=await mkdtemp('/private/tmp/kibi-public-cpp-test-');t.after(()=>rm(root,{recursive:true,force:true}));const output=join(root,'decoder-test');
  const a=Buffer.alloc(1024),b=Buffer.from(Array.from({length:1024},(_,i)=>i&255));
  const header=generateBitmapHeader([a,b],[{name:'neutral',order:[0,1,1],baseIntervalMs:180,perFrameIntervalMs:[12,25,30],semanticsKnown:true,loopEndFieldMs:2000},{name:'msg',order:[1],baseIntervalMs:200,semanticsKnown:false}], 'PublicTest');
  const harness='#include <cstdio>\n'+header+'\nint main(){uint8_t b[1025];b[1024]=77;if(PublicTest::DecodeFrame(99,b,1024)||PublicTest::DecodeFrame(0,b,1023)||PublicTest::DecodeFrame(0,nullptr,1024))return 1;if(PublicTest::FrameIntervalMs(0,1)!=25||PublicTest::GetEntry(1)->semanticsKnown||PublicTest::GetEntry(99))return 2;for(size_t i=0;i<2;i++){if(!PublicTest::DecodeFrame(i,b,1024)||b[1024]!=77)return 3;std::fwrite(b,1,1024,stdout);}if(!PublicTest::DecodeEntryFrame(0,2,b,1024)||PublicTest::DecodeEntryFrame(0,3,b,1024))return 4;return 0;}';
  const built=spawnSync('c++',['-std=c++11','-x','c++','-','-o',output],{input:harness,encoding:'utf8'});assert.equal(built.status,0,built.stderr);const ran=spawnSync(output,[],{maxBuffer:10000});assert.equal(ran.status,0);assert.deepEqual(ran.stdout,Buffer.concat([a,b]));
  assert.throws(()=>generateBitmapHeader([a],[{name:'bad";exec()',order:[0],baseIntervalMs:1}]),errorCode('ASSET_METADATA'));
});
test('existing public firmware fixture imports all42positions/14records with exact hashes; no new download',async t=>{
  const fixture='/private/tmp/kibi-leroyd-public-analysis/oled.ino.bin';let bytes;try{bytes=await readFile(fixture);}catch(error){if(error.code==='ENOENT'){t.skip('Optional already-downloaded public fixture unavailable');return;}throw error;}
  let capture;const s=createPublicResourceService({lookup,getProjectContext:context,transport:async request=>{assert.equal(request.url,'https://leroyd.com/oled.ino.bin');return response(bytes);},installAsset:async request=>{capture=request;await request.assertProjectCurrent();return {paths:request.files.map(f=>f.path)};}});
  const r=await s.importPublicAsset('https://leroyd.com/oled.ino.bin',{expectedProjectId:'new-project',recipe:'leroyd-c309-public-b59a5c23'});
  assert.equal(r.api.counts.entries,14);assert.equal(r.api.include,'embedded_assets.h');assert.equal(capture.files.length,1);assert.deepEqual(r.api.constants,{kWidth:128,kHeight:64,kFrameBytes:1024,kEntryCount:14,kFrameCount:30});assert.equal(r.api.entryOrder[0],'neutral');assert.equal(r.api.entryOrder[13],'msg');assert.deepEqual(r.api.entryFields,['const char* name','const uint8_t* order','size_t count','uint16_t baseIntervalMs','const uint16_t* perFrameIntervals','bool semanticsKnown','uint16_t loopEndFieldMs']);assert.ok(r.api.interface.includes('bool DecodeEntryFrame(size_t entry,size_t position,uint8_t* out,size_t capacity);'));assert.ok(r.api.interface.includes('const Entry* GetEntry(size_t index);'));assert.ok(r.api.interface.includes('uint16_t FrameIntervalMs(size_t entry,size_t position);'));assert.equal(r.api.interface.includes('kRle0'),false);assert.equal(r.api.counts.positions,42);assert.equal(capture.metadata.frames.length,30);assert.equal(capture.metadata.entries[13].name,'msg');assert.equal(capture.metadata.entries[13].semanticsKnown,false);assert.equal(JSON.stringify(r).length<6000,true);
  const arrays=[...capture.files[0].content.matchAll(/kRle\d+\[\]=\{([\d,]+)\}/g)].map(x=>decodeRle(Buffer.from(x[1].split(',').map(Number))));assert.equal(arrays.length,30);
  for(let i=0;i<arrays.length;i++){const expected=capture.metadata.frames[i];assert.equal(createHash('sha256').update(arrays[i]).digest('hex'),expected.sha256);for(const off of expected.sourceOffsets)assert.deepEqual(arrays[i],bytes.subarray(off,off+1024));}
  assert.equal(capture.metadata.entries.reduce((n,e)=>n+e.order.length,0),42);assert.deepEqual(capture.metadata.entries.find(e=>e.name==='left').perFrameIntervalMs,[500,200,200,500,200,200,500]);
});
