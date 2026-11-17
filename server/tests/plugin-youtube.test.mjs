import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPluginService} from '../src/plugins/service.mjs';

const videoId='4t4AQ15yj1M';
const frameBytes=Buffer.alloc(142080,0x39);
const adapter=()=>import('../src/plugins/youtube.mjs');
const worker=()=>import('../workers/media/worker.mjs');
const code=value=>error=>error?.code===value && error.message===value;

function processFixture(handler){
 const calls=[];
 const spawn=(file,args,options)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const parts=[];let ended=false;
  child.stdin=new Writable({write(chunk,encoding,done){parts.push(Buffer.from(chunk));done();}});
  child.finish=(stdout=Buffer.alloc(0),exitCode=0,stderr='')=>{if(ended)return;ended=true;child.stdout.end(stdout);child.stderr.end(stderr);setImmediate(()=>child.emit('close',exitCode,null));};
  child.kill=()=>{child.killed=true;child.finish(Buffer.alloc(0),null);return true;};
  const call={file,args,options,child,input:()=>Buffer.concat(parts)};calls.push(call);
  if(args[0]==='run')child.stdin.once('finish',()=>handler(call));
  else setImmediate(()=>handler(call));
  return child;
 };
 return {spawn,calls};
}
const qualifiedDaemon={securityOptions:['name=rootless'],cgroupVersion:'2',cgroupDriver:'systemd'};
const daemonOutput=(args,value=qualifiedDaemon)=>JSON.stringify(args[2]==='{{json .SecurityOptions}}'?value.securityOptions:value);
function dockerFixture(run,{rootless=true,daemon={...qualifiedDaemon,securityOptions:rootless?['name=rootless']:['name=seccomp']}}={}){
 return processFixture(call=>{
  if(call.args[0]==='info')call.child.finish(daemonOutput(call.args,daemon));
  else if(call.args[0]==='run')run(call);
  else call.child.finish();
 });
}
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('process did not start');}

test('YouTube media is disabled by default and never starts a process',async()=>{
 const {createYouTubeFrameService}=await adapter();let calls=0;
 const service=createYouTubeFrameService({spawnImpl:()=>{calls++;throw Error('private');}});
 assert.equal(service.status().available,false);
 await assert.rejects(service.frame({videoId}),code('plugin_media_unavailable'));assert.equal(calls,0);await service.close();
});

test('media accepts only a video ID and known fit before starting any process',async()=>{
 const {createYouTubeFrameService}=await adapter();let calls=0;
 const service=createYouTubeFrameService({enabled:true,spawnImpl:()=>{calls++;throw Error('private');}});
 for(const request of [{videoId:'https://youtube.com/watch?v='+videoId},{videoId:'../etc/passwd'},{videoId,fit:'stretch'},{videoId,url:'https://example.com'},{videoId,fit:null},null,[],{videoId,signal:{aborted:false}}])await assert.rejects(service.frame(request),code('plugin_media_invalid_request'));
 assert.equal(calls,0);await service.close();
});

test('media returns exactly one RGB565 frame with independently checked hash and hardened Docker invocation',async()=>{
 const {createYouTubeFrameService}=await adapter();const io=dockerFixture(call=>call.child.finish(frameBytes));
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});const result=await service.frame({videoId});
 assert.deepEqual(result,{rgb565:frameBytes,width:240,height:296,sha256:createHash('sha256').update(frameBytes).digest('hex')});
 const call=io.calls.find(c=>c.args[0]==='run');const args=call.args;
 for(const flag of ['--read-only','--cap-drop=ALL','--security-opt=no-new-privileges:true','--pull=never','--network=bridge','--log-driver=none'])assert.ok(args.includes(flag),flag);
 assert.ok(args.includes('--user=65532:65532'));assert.ok(args.includes('--memory=512m'));assert.ok(args.includes('--pids-limit=64'));
 assert.equal(args.some(x=>/^(?:--volume|-v|--mount|--env|-e)$/.test(x)),false);
 assert.equal(call.options.shell,false);assert.deepEqual(Object.keys(call.options.env),['PATH']);
 assert.deepEqual(JSON.parse(call.input()),{videoId,fit:'contain'});assert.equal(args.at(-1),'kibi-youtube-media:local');
 await service.close();
});

test('media refuses a rootful Docker daemon before starting a container',async()=>{
 const {createYouTubeFrameService}=await adapter();const io=dockerFixture(()=>assert.fail('container started'),{rootless:false});
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});await assert.rejects(service.frame({videoId}),code('plugin_media_unavailable'));await service.close();
});

for(const [name,output] of [['short',Buffer.alloc(2)],['excessive',Buffer.alloc(142081)]])test(`media rejects ${name} frame without exposing process diagnostics`,async()=>{
 const {createYouTubeFrameService}=await adapter();const io=dockerFixture(call=>call.child.finish(output,0,'secret https://private.example'));
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});await assert.rejects(service.frame({videoId}),code('plugin_media_invalid_frame'));await service.close();
});

test('media cancels the named container and rejects late successful output',async()=>{
 const {createYouTubeFrameService}=await adapter();const io=dockerFixture(()=>{});const controller=new AbortController();
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});const pending=service.frame({videoId,signal:controller.signal});
 const rejected=assert.rejects(pending,code('plugin_media_cancelled'));await until(()=>io.calls.some(c=>c.args[0]==='run'));controller.abort();await rejected;
 const run=io.calls.find(c=>c.args[0]==='run'),name=run.args.find(x=>x.startsWith('--name=')).slice(7);
 assert.ok(io.calls.some(c=>c.args[0]==='kill'&&c.args[1]===name));assert.ok(io.calls.some(c=>c.args[0]==='rm'&&c.args.includes('--force')&&c.args.at(-1)===name));
 run.child.finish(frameBytes);await service.close();
});

test('media enforces its deadline and cleans up even when the process stalls',async()=>{
 const {createYouTubeFrameService}=await adapter();const io=dockerFixture(()=>{});
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn,timeoutMs:30});await assert.rejects(service.frame({videoId}),code('plugin_media_timeout'));
 assert.ok(io.calls.some(c=>c.args[0]==='rm'));await service.close();
});

test('media rejects concurrent overflow without a queue and close cancels active frames',async()=>{
 const {createYouTubeFrameService}=await adapter();const io=dockerFixture(()=>{});const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});
 const pending=Array.from({length:4},()=>service.frame({videoId}));const observed=pending.map(p=>assert.rejects(p,code('plugin_media_cancelled')));
 await assert.rejects(service.frame({videoId}),code('plugin_media_busy'));await service.close();await Promise.all(observed);
 await assert.rejects(service.frame({videoId}),code('plugin_media_unavailable'));
});

test('worker restricts the extractor to one official YouTube request and sends only bytes to FFmpeg',async()=>{
 const {renderYouTubeFrame}=await worker();const url='https://rr1---sn-test.googlevideo.com/videoplayback?id=public';
 const io=processFixture(call=>{if(call.file==='/usr/local/bin/yt-dlp')call.child.finish(url+'\n');else if(call.file==='/usr/local/bin/ffmpeg')call.child.finish(frameBytes);else assert.fail('unknown tool');});
 // Worker tools consume stdin immediately; the fixture needs to finish them on end.
 const spawn=(file,args,options)=>{const child=io.spawn(file,args,options);if(args[0]!=='run')child.stdin.once('finish',()=>{});return child;};
 let fetched;const rgb565=await renderYouTubeFrame({videoId,fit:'cover'},{spawnImpl:spawn,fetchBytesImpl:async input=>{fetched=input;return Buffer.from('media bytes');}});
 assert.deepEqual(rgb565,frameBytes);assert.equal(fetched,url);
 const yt=io.calls[0];assert.equal(yt.args.at(-1),'https://www.youtube.com/watch?v='+videoId);
 for(const flag of ['--ignore-config','--no-plugin-dirs','--no-remote-components','--no-playlist','--skip-download','--get-url'])assert.ok(yt.args.includes(flag));
 const ff=io.calls[1];assert.ok(ff.args.includes('pipe:0'));assert.equal(ff.args.includes(url),false);
 assert.equal(ff.args[ff.args.indexOf('-protocol_whitelist')+1],'pipe');assert.equal(ff.args[ff.args.indexOf('-pix_fmt')+1],'rgb565le');assert.equal(ff.args[ff.args.indexOf('-frames:v')+1],'1');
 assert.match(ff.args[ff.args.indexOf('-vf')+1],/crop=240:296/);
 assert.deepEqual(ff.input(),Buffer.from('media bytes'));
});

test('worker rejects extractor URLs to non-CDN hosts, credentials, ports or multiple URLs before fetching',async()=>{
 const {renderYouTubeFrame}=await worker();
 for(const output of ['https://127.0.0.1/x','https://googlevideo.com.evil.test/x','file:///etc/passwd','https://u:p@r.googlevideo.com/x','https://r.googlevideo.com:444/x','https://r.googlevideo.com/x\nhttps://r.googlevideo.com/y']){
  const io=processFixture(c=>c.child.finish(output));let fetched=false;
  await assert.rejects(renderYouTubeFrame({videoId},{spawnImpl:io.spawn,fetchBytesImpl:async()=>{fetched=true;return Buffer.alloc(0);}}),code('plugin_media_upstream_invalid'));assert.equal(fetched,false);assert.equal(io.calls.length,1);
 }
});

test('worker recognizes provider sign-in confirmation across stderr chunks without fetching media',async()=>{
 const {renderYouTubeFrame}=await worker();let fetches=0;
 const io=processFixture(call=>{
  call.child.stderr.write('ERROR: [youtube] public: Sign in to con');
  call.child.stderr.write('firm you\u2019re not a bot. PRIVATE https://private.example/cookie');
  call.child.finish(Buffer.alloc(0),1);
 });
 await assert.rejects(renderYouTubeFrame({videoId},{spawnImpl:io.spawn,fetchBytesImpl:async()=>{fetches++;return Buffer.alloc(0);}}),code('plugin_media_provider_restricted'));
 assert.equal(fetches,0);assert.equal(io.calls.length,1);
});

test('worker keeps ordinary tool failures, FFmpeg diagnostics and excessive stderr generic',async()=>{
 const {renderYouTubeFrame}=await worker();
 for(const scenario of ['ordinary','ffmpeg','excessive']){
  const io=processFixture(call=>{
   if(scenario==='ffmpeg'&&call.file.endsWith('yt-dlp'))call.child.finish('https://r.googlevideo.com/x');
   else call.child.finish(Buffer.alloc(0),1,scenario==='ordinary'?'PRIVATE unexpected extraction failure':scenario==='excessive'?'Sign in to confirm '+ 'x'.repeat(8192):'Sign in to confirm you are not a bot');
  });
  await assert.rejects(renderYouTubeFrame({videoId},{spawnImpl:io.spawn,fetchBytesImpl:async()=>Buffer.from('media')}),code('plugin_media_unavailable'));
 }
});

test('worker writes only a fixed stderr failure marker and no frame for provider restriction',async()=>{
 const {runMediaWorker}=await worker();assert.equal(typeof runMediaWorker,'function');
 const stdin=new PassThrough(),stdout=new PassThrough(),stderr=new PassThrough(),out=[],err=[];
 stdout.on('data',chunk=>out.push(chunk));stderr.on('data',chunk=>err.push(chunk));
 stdin.end(JSON.stringify({videoId}));
 const io=processFixture(call=>call.child.finish(Buffer.alloc(0),1,'Sign in to confirm you\u2019re not a bot. PRIVATE https://private.example'));
 assert.equal(await runMediaWorker({stdin,stdout,stderr,spawnImpl:io.spawn}),false);
 assert.equal(Buffer.concat(out).length,0);
 assert.equal(Buffer.concat(err).toString(),'KIBI_MEDIA_ERROR_V1 plugin_media_provider_restricted\n');
});

test('media recognizes only an exact worker failure marker and preserves cleanup',async()=>{
 const {createYouTubeFrameService}=await adapter();
 const io=dockerFixture(call=>{call.child.stderr.write('KIBI_MEDIA_ERROR_V1 plugin_media_');call.child.finish(Buffer.alloc(0),1,'provider_restricted\n');});
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});
 try{
  await assert.rejects(service.frame({videoId}),code('plugin_media_provider_restricted'));
  assert.equal(service.status().available,false);assert.ok(io.calls.some(call=>call.args[0]==='rm'));
 }finally{await service.close();}
});

test('media refuses malformed, mixed, oversized and successful failure markers',async()=>{
 const {createYouTubeFrameService}=await adapter();
 const marker='KIBI_MEDIA_ERROR_V1 plugin_media_provider_restricted\n';
 for(const [stderr,stdout,exit] of [[marker+'PRIVATE',Buffer.alloc(0),1],[marker.repeat(2),Buffer.alloc(0),1],['plugin_media_provider_restricted\n',Buffer.alloc(0),1],[marker,Buffer.from('x'),1],[marker,frameBytes,0],[marker,Buffer.alloc(0),2],[marker+'x'.repeat(8192),Buffer.alloc(0),1]]){
  const io=dockerFixture(call=>call.child.finish(stdout,exit,stderr)),service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});
  try{await assert.rejects(service.frame({videoId}),code('plugin_media_unavailable'));assert.equal(service.status().available,false);}
  finally{await service.close();}
 }
});

test('a restricted trusted worker propagates through the real media adapter, broker and device HTTP as 424',async t=>{
 const {createPluginBrokerServer}=await import('../src/plugins/broker.mjs');
 const {createPluginBrokerClient}=await import('../src/plugins/broker-client.mjs');
 const {createKibiServer}=await import('../src/server.mjs');
 const {createYouTubeFrameService}=await adapter(),{runMediaWorker}=await worker();
 const directory=await mkdtemp('/tmp/kibi-media-http-'),socketPath=directory+'/broker.sock';
 let server,broker,client;
 t.after(async()=>{
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  await client?.close();await broker?.close();await rm(directory,{recursive:true,force:true});
 });
 const tools=processFixture(call=>call.child.finish(Buffer.alloc(0),1,'Sign in to confirm you\u2019re not a bot. PRIVATE https://private.example'));
 const docker=processFixture(async call=>{
  if(call.args[0]==='info')call.child.finish(daemonOutput(call.args));
  else if(call.args[0]==='run'){
   const stdin=new PassThrough();stdin.end(call.input());
   const ok=await runMediaWorker({stdin,stdout:call.child.stdout,stderr:call.child.stderr,spawnImpl:tools.spawn});
   call.child.finish(Buffer.alloc(0),ok?0:1);
  }else call.child.finish();
 });
 const media=createYouTubeFrameService({enabled:true,spawnImpl:docker.spawn});
 broker=createPluginBrokerServer({socketPath,media,runtime:{status:()=>({configured:true,available:true,reason:'ready'}),invoke:async()=>({youtubeFrame:{videoId,fit:'contain'}}),close:async()=>{}}});
 await broker.listen();client=createPluginBrokerClient({socketPath});await client.ready();
 const origin='https://kibi.example';
 server=await createKibiServer({dataDir:directory+'/account',adminPassword:'test owner password',publicOrigin:origin,voiceConfig:{enabled:false},pluginRuntime:client.runtime,pluginMedia:client.media,fetchImpl:()=>{throw Error('Unexpected external network');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const call=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const registered=await call('/api/register',{email:'restricted@example.test',password:'test account password'});assert.equal(registered.status,201);
 const user=await registered.json(),headers={Cookie:registered.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrfToken};
 const created=await call('/api/devices',{name:'Test Kibi'},headers);assert.equal(created.status,200);const device=await created.json();
 const packageText=JSON.stringify({format:'kibi-plugin',manifestVersion:2,sdkVersion:'1.1',id:'test.video',version:'1.0.0',name:'Video',description:'',capabilities:['request-handler'],permissions:['media:youtube-frame'],settings:[],secrets:[],server:{language:'javascript',source:'throw new Error("DO NOT RUN")'}});
 assert.equal((await call('/api/plugins',{packageText,sha256:createHash('sha256').update(packageText).digest('hex')},headers)).status,201);
 assert.equal((await call('/api/devices/'+device.device.id+'/plugins/test.video',{version:'1.0.0',expectedRevision:0,enabled:true,settings:{}},headers)).status,200);
 const response=await call('/api/device/plugins/test.video/invoke',{input:{}},{Authorization:'Bearer '+device.token});
 assert.equal(response.status,424);assert.deepEqual(await response.json(),{ok:false,code:'plugin_media_provider_restricted'});
 assert.equal(response.headers.get('x-pixel-format'),null);assert.equal(client.media.status().available,false);
 assert.equal(tools.calls.length,1);assert.ok(docker.calls.some(item=>item.args[0]==='rm'));
});

test('worker preserves a complete frame when FFmpeg closes media stdin early',async()=>{
 const {renderYouTubeFrame}=await worker();
 const io=processFixture(call=>{if(call.file.endsWith('yt-dlp'))call.child.finish('https://r.googlevideo.com/x');else{call.child.stdin.emit('error',Object.assign(Error('write EPIPE'),{code:'EPIPE'}));call.child.finish(frameBytes);}});
 const result=await renderYouTubeFrame({videoId},{spawnImpl:io.spawn,fetchBytesImpl:async()=>Buffer.from('media')});assert.deepEqual(result,frameBytes);
});

test('worker validates every HLS segment and refuses encrypted or external playlists',async()=>{
 const {renderYouTubeFrame}=await worker();
 for(const playlist of ['#EXTM3U\n#EXTINF:5\nhttps://evil.test/segment.ts\n','#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://r.googlevideo.com/key"\nseg.ts\n']){
  const io=processFixture(c=>c.child.finish('https://r.googlevideo.com/live.m3u8'));let fetches=0;
  await assert.rejects(renderYouTubeFrame({videoId},{spawnImpl:io.spawn,fetchBytesImpl:async()=>{fetches++;return Buffer.from(playlist);}}),code('plugin_media_upstream_invalid'));assert.equal(fetches,1);assert.equal(io.calls.length,1);
 }
});

test('worker reads the latest HLS segment and init bytes within a bounded nesting depth',async()=>{
 const {renderYouTubeFrame}=await worker();const io=processFixture(c=>c.child.finish(c.file.endsWith('yt-dlp')?'https://r.googlevideo.com/live.m3u8':frameBytes));const seen=[];
 const sources={
  'https://r.googlevideo.com/live.m3u8':'#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5\nold.m4s\n#EXTINF:5\nnew.m4s\n',
  'https://r.googlevideo.com/init.mp4':'init','https://r.googlevideo.com/new.m4s':'latest'
 };
 await renderYouTubeFrame({videoId},{spawnImpl:io.spawn,fetchBytesImpl:async url=>{seen.push(url);assert.ok(Object.hasOwn(sources,url));return Buffer.from(sources[url]);}});
 assert.deepEqual(seen,Object.keys(sources));assert.deepEqual(io.calls[1].input(),Buffer.from('initlatest'));
});

test('network transport refuses DNS rebinding/private IPv4 results before opening a socket',async()=>{
 const {fetchPublicMediaBytes}=await worker();let requests=0;
 const lookupImpl=(host,options,cb)=>cb(null,[{address:'127.0.0.1',family:4}]);
 await assert.rejects(fetchPublicMediaBytes('https://r.googlevideo.com/x',{lookupImpl,requestImpl:()=>{requests++;assert.fail('opened socket');}}),code('plugin_media_upstream_invalid'));assert.equal(requests,0);
});

test('network transport revalidates a redirect before the second socket',async()=>{
 const {fetchPublicMediaBytes}=await worker();let requests=0;
 const lookupImpl=(host,options,cb)=>cb(null,[{address:'142.250.1.1',family:4}]);
 const requestImpl=(_url,_options,response)=>{requests++;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>setImmediate(()=>{const res=new PassThrough();res.statusCode=302;res.headers={location:'https://127.0.0.1/private'};response(res);res.end();});return req;};
 await assert.rejects(fetchPublicMediaBytes('https://r.googlevideo.com/x',{lookupImpl,requestImpl}),code('plugin_media_upstream_invalid'));assert.equal(requests,1);
});

test('network transport requests a bounded byte range and accepts a partial CDN response',async()=>{
 const {fetchPublicMediaBytes}=await worker();let options;
 const lookupImpl=(host,lookupOptions,cb)=>cb(null,[{address:'142.250.1.1',family:4}]);
 const requestImpl=(_url,requestOptions,response)=>{options=requestOptions;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>setImmediate(()=>{const res=new PassThrough();res.statusCode=206;res.headers={};response(res);res.end(Buffer.from('bounded media'));});return req;};
 const bytes=await fetchPublicMediaBytes('https://r.googlevideo.com/x',{lookupImpl,requestImpl,maxBytes:200});
 assert.deepEqual(bytes,Buffer.from('bounded media'));assert.equal(options.headers.Range,'bytes=0-199');
 // The socket lookup must use the checked address rather than resolve again.
 options.lookup('r.googlevideo.com',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'142.250.1.1');assert.equal(family,4);});
});

test('worker CLI exits on cancellation while stdin remains open',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const child=spawn(process.execPath,[fileURLToPath(new URL('../workers/media/worker.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});
 const exited=new Promise(resolve=>child.once('close',(exitCode,signal)=>resolve({exitCode,signal})));
 await new Promise(resolve=>setTimeout(resolve,75));child.kill('SIGTERM');
 const result=await Promise.race([exited,new Promise(resolve=>setTimeout(()=>resolve(null),400))]);
 if(!result){child.kill('SIGKILL');await exited;}assert.ok(result,'cancellation must stop an idle worker');
});

test('media cancellation during container cleanup fences a previously completed frame',async()=>{
 const {createYouTubeFrameService}=await adapter();let cleanup;
 const io=processFixture(call=>{
  if(call.args[0]==='info')call.child.finish(daemonOutput(call.args));
  else if(call.args[0]==='run')call.child.finish(frameBytes);
  else if(call.args[0]==='kill')cleanup=call;
  else call.child.finish();
 });
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn}),controller=new AbortController();
 const pending=service.frame({videoId,signal:controller.signal});const checked=assert.rejects(pending,code('plugin_media_cancelled'));
 await until(()=>cleanup);controller.abort();cleanup.child.finish();await checked;await service.close();
});


test('enabled YouTube media can be invoked through the real plugin service capabilities contract',async t=>{
 const {createYouTubeFrameService}=await adapter(),io=dockerFixture(call=>call.child.finish(frameBytes));
 const media=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});
 const dir=await mkdtemp(join(tmpdir(),'kibi-plugin-youtube-service-'));
 const runtime={status:()=>({configured:true,available:true}),invoke:async()=>({youtubeFrame:{videoId,fit:'contain'}})};
 const service=await createPluginService({dataDir:dir,deviceExists:id=>id==='own',runtime,media});
 t.after(async()=>{await service.close();await media.close();await rm(dir,{recursive:true,force:true});});
 assert.deepEqual(service.capabilities().media,{configured:true,available:false});
 const packageText=JSON.stringify({format:'kibi-plugin',manifestVersion:2,sdkVersion:'1.1',id:'test.video',version:'1.0.0',name:'Video',description:'',capabilities:['request-handler'],permissions:['media:youtube-frame'],settings:[],secrets:[],server:{language:'javascript',source:'throw new Error("DO NOT RUN")'}});
 await service.publish({packageText,sha256:createHash('sha256').update(packageText).digest('hex')});
 await service.bind('own',{pluginId:'test.video',version:'1.0.0',expectedRevision:0,enabled:true,settings:{}});
 const result=await service.invoke('own','test.video',{});assert.deepEqual(result.frame.rgb565,frameBytes);assert.equal(result.revision,1);
 assert.deepEqual(service.capabilities().media,{configured:true,available:true});
});

test('media close waits for a killed process to actually close before returning',async()=>{
 const {createYouTubeFrameService}=await adapter();let running;
 const io=dockerFixture(call=>{running=call;call.child.kill=()=>{call.child.killed=true;return true;};});
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});
 const pending=service.frame({videoId}),outcome=assert.rejects(pending,code('plugin_media_cancelled'));
 await until(()=>running);let closed=false;const closing=service.close().then(()=>closed=true);
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(running.child.killed,true);assert.equal(closed,false);
 running.child.finish(Buffer.alloc(0),null);await closing;await outcome;
});

test('a successful --rm run remains usable when follow-up cleanup finds no container',async()=>{
 const {createYouTubeFrameService}=await adapter();
 const io=processFixture(call=>{
  if(call.args[0]==='info')call.child.finish(daemonOutput(call.args));
  else if(call.args[0]==='run')call.child.finish(frameBytes);
  else call.child.finish(Buffer.alloc(0),1);
 });
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});
 assert.deepEqual((await service.frame({videoId})).rgb565,frameBytes);
 assert.deepEqual((await service.frame({videoId})).rgb565,frameBytes);assert.equal(service.status().available,true);
 await service.close();
});

test('media accepts a successful exact daemon absence check after failed removal',async()=>{
 const {createYouTubeFrameService}=await adapter();let running;
 const io=processFixture(call=>{
  if(call.args[0]==='info')call.child.finish(daemonOutput(call.args));
  else if(call.args[0]==='run')running=call;
  else if(call.args[0]==='ps')call.child.finish();
  else call.child.finish(Buffer.alloc(0),1);
 });
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn}),controller=new AbortController();
 const pending=service.frame({videoId,signal:controller.signal}),outcome=assert.rejects(pending,code('plugin_media_cancelled'));
 await until(()=>running);controller.abort();await outcome;
 const check=io.calls.find(call=>call.args[0]==='ps');assert.ok(check);assert.ok(check.args.includes('name=^/'+running.args.find(arg=>arg.startsWith('--name=')).slice(7)+'$'));
 assert.equal(service.status().status,'unverified');await service.close();
});

// A failed cleanup intentionally quarantines capacity for this process.
test('unconfirmed media cleanup fails in bounded time, disables the adapter and does not hang close',{timeout:2000},async()=>{
 const {createYouTubeFrameService}=await adapter();
 const io=processFixture(call=>{
  if(call.args[0]==='info')call.child.finish(daemonOutput(call.args));
  else if(call.args[0]==='run'){}
  else call.child.finish(Buffer.alloc(0),1);
 });
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn}),controller=new AbortController();
 const pending=service.frame({videoId,signal:controller.signal}),outcome=assert.rejects(pending,code('plugin_media_cleanup_failed'));
 await until(()=>io.calls.some(call=>call.args[0]==='run'));controller.abort();await outcome;
 assert.equal(service.status().available,false);assert.equal(service.status().status,'cleanup_failed');
 const calls=io.calls.length;await assert.rejects(service.frame({videoId}),code('plugin_media_unavailable'));assert.equal(io.calls.length,calls);
 await service.close();
});


test('media requires cgroup v2 and systemd before starting a rootless container',async()=>{
 const {createYouTubeFrameService}=await adapter();
 for(const daemon of [{...qualifiedDaemon,cgroupVersion:'1'},{...qualifiedDaemon,cgroupDriver:'none'},{...qualifiedDaemon,cgroupDriver:'cgroupfs'},{securityOptions:['name=rootless']}]){
  const io=dockerFixture(call=>call.child.finish(frameBytes),{daemon});
  const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn});
  try{
   await assert.rejects(service.frame({videoId}),code('plugin_media_unavailable'));
   assert.equal(service.status().available,false);assert.equal(io.calls.some(call=>call.args[0]==='run'),false);
  }finally{await service.close();}
 }
});

test('media cannot prove cleanup while a stopped container with its exact name remains',async()=>{
 const {createYouTubeFrameService}=await adapter();let running;
 const io=processFixture(call=>{
  if(call.args[0]==='info')call.child.finish(daemonOutput(call.args));
  else if(call.args[0]==='run')running=call;
  else if(call.args[0]==='ps')call.child.finish(call.args.includes('--all')?running.args.find(arg=>arg.startsWith('--name=')).slice(7)+'\n':'');
  else call.child.finish(Buffer.alloc(0),1);
 });
 const service=createYouTubeFrameService({enabled:true,spawnImpl:io.spawn}),controller=new AbortController();
 const pending=service.frame({videoId,signal:controller.signal}),outcome=assert.rejects(pending,code('plugin_media_cleanup_failed'));
 await until(()=>running);controller.abort();
 try{await outcome;assert.equal(service.status().status,'cleanup_failed');}
 finally{await service.close();}
});
