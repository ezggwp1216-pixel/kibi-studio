import {spawn} from 'node:child_process';
import {lookup} from 'node:dns';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {pathToFileURL} from 'node:url';

const FRAME_BYTES=142080,MAX_MEDIA_BYTES=16*1024*1024,MAX_PLAYLIST_BYTES=256*1024;
const PROVIDER_RESTRICTED_MARKER='KIBI_MEDIA_ERROR_V1 plugin_media_provider_restricted\n';
const ENV=Object.freeze({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LANG:'C.UTF-8'});
const fail=code=>Object.assign(new Error(code),{code});

function checkRequest(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['videoId','fit'].includes(key))||typeof input.videoId!=='string'||!/^[A-Za-z0-9_-]{11}$/.test(input.videoId)||
  (input.fit!==undefined&&!['contain','cover'].includes(input.fit)))throw fail('plugin_media_invalid_request');
 return {videoId:input.videoId,fit:input.fit??'contain'};
}
function mediaURL(value,base){
 if(typeof value!=='string'||value.length>16384||/[\x00-\x20\x7f]/.test(value))throw fail('plugin_media_upstream_invalid');
 let url;try{url=new URL(value,base);}catch{throw fail('plugin_media_upstream_invalid');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!['googlevideo.com','youtube.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))throw fail('plugin_media_upstream_invalid');
 return url;
}
function publicIPv4(address){
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return a!==0&&a!==10&&a!==127&&a<224&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&
  !(a===192&&(b===168||b===0||b===2))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
}
async function resolvePublic(host,lookupImpl,signal){
 if(signal?.aborted)throw fail('plugin_media_cancelled');
 return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(fail('plugin_media_cancelled'));};
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  const timer=setTimeout(()=>{cleanup();reject(fail('plugin_media_timeout'));},4000);
  signal?.addEventListener('abort',abort,{once:true});
  try{lookupImpl(host,{all:true,family:4},(error,answers)=>{cleanup();if(signal?.aborted)return reject(fail('plugin_media_cancelled'));if(error||!Array.isArray(answers)||!answers.length||answers.some(answer=>!publicIPv4(answer.address)))return reject(fail('plugin_media_upstream_invalid'));resolve(answers[0].address);});}catch{cleanup();reject(fail('plugin_media_upstream_invalid'));}
 });
}

/** Redirects re-enter this function, rechecking both host and resolved address.
 * The already validated address is pinned into the HTTPS socket's lookup. */
export async function fetchPublicMediaBytes(value,{signal,lookupImpl=lookup,requestImpl=httpsRequest,maxBytes=MAX_MEDIA_BYTES,redirects=0}={}){
 const url=mediaURL(value);if(redirects>3)throw fail('plugin_media_upstream_invalid');
 const address=await resolvePublic(url.hostname,lookupImpl,signal);
 return new Promise((resolve,reject)=>{
  let req,settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){try{req?.destroy();}catch{}reject(error);}else resolve(result);};
  const abort=()=>finish(fail('plugin_media_cancelled'));
  const timer=setTimeout(()=>finish(fail('plugin_media_timeout')),8000);
  if(signal?.aborted){abort();return;}
  try{
   req=requestImpl(url,{method:'GET',agent:false,family:4,rejectUnauthorized:true,headers:{'User-Agent':'Kibi-Media/1','Accept-Encoding':'identity',Range:'bytes=0-'+(maxBytes-1)},lookup:(_host,options,done)=>options?.all?done(null,[{address,family:4}]):done(null,address,4)},response=>{
    response.on('error',()=>finish(fail('plugin_media_unavailable')));
    if([301,302,303,307,308].includes(response.statusCode)){
     response.resume();let target;try{target=mediaURL(response.headers.location,url).href;}catch{finish(fail('plugin_media_upstream_invalid'));return;}
     fetchPublicMediaBytes(target,{signal,lookupImpl,requestImpl,maxBytes,redirects:redirects+1}).then(result=>finish(null,result),error=>finish(error));return;
    }
    if(![200,206].includes(response.statusCode)){response.resume();finish(fail('plugin_media_unavailable'));return;}
    const chunks=[];let size=0;
    response.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>maxBytes){finish(fail('plugin_media_upstream_invalid'));response.destroy();}else chunks.push(Buffer.from(chunk));});
    response.on('aborted',()=>finish(fail('plugin_media_unavailable')));
    response.on('end',()=>finish(null,Buffer.concat(chunks)));
   });
   req.on('error',()=>finish(fail('plugin_media_unavailable')));signal?.addEventListener('abort',abort,{once:true});req.end();
  }catch{finish(fail('plugin_media_unavailable'));}
 });
}

function runTool(file,args,{spawnImpl,input=Buffer.alloc(0),signal,maxBytes,allowEarlyInputClose=false}){
 return new Promise((resolve,reject)=>{
  let child,settled=false,size=0,stderrSize=0;const chunks=[],diagnostics=[];
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const chunk of diagnostics)chunk.fill(0);diagnostics.length=0;if(error){try{child?.kill('SIGKILL');}catch{}reject(error);}else resolve(result);};
  const abort=()=>finish(fail('plugin_media_cancelled'));
  const timer=setTimeout(()=>finish(fail('plugin_media_timeout')),15000);
  if(signal?.aborted){abort();return;}
  try{
   child=spawnImpl(file,args,{shell:false,stdio:['pipe','pipe','pipe'],env:ENV});
   child.on('error',()=>finish(fail('plugin_media_unavailable')));child.stdin.on('error',error=>{if(!(allowEarlyInputClose&&error.code==='EPIPE'))finish(fail('plugin_media_unavailable'));});
   child.stdout.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>maxBytes)finish(fail('plugin_media_upstream_invalid'));else chunks.push(Buffer.from(chunk));});
   child.stderr.on('data',chunk=>{
    if(settled)return;stderrSize+=chunk.length;
    if(stderrSize>8192)finish(fail('plugin_media_unavailable'));
    else if(file==='/usr/local/bin/yt-dlp')diagnostics.push(Buffer.from(chunk));
   });
   child.on('close',status=>{
    if(settled)return;
    if(status===0){finish(null,Buffer.concat(chunks));return;}
    // Only trusted yt-dlp diagnostics are classified, in bounded memory. Never
    // forward its text, URLs or suggested authentication arguments.
    const restricted=file==='/usr/local/bin/yt-dlp'&&/sign in to confirm|not a bot|LOGIN_REQUIRED|bot check/i.test(Buffer.concat(diagnostics).toString('utf8'));
    finish(fail(restricted?'plugin_media_provider_restricted':'plugin_media_unavailable'));
   });
   signal?.addEventListener('abort',abort,{once:true});child.stdin.end(input);
  }catch{finish(fail('plugin_media_unavailable'));}
 });
}
async function mediaInput(url,{fetchBytesImpl,signal},depth=0){
 if(depth>3)throw fail('plugin_media_upstream_invalid');
 const bytes=await fetchBytesImpl(mediaURL(url).href,{signal,maxBytes:MAX_MEDIA_BYTES});
 if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX_MEDIA_BYTES)throw fail('plugin_media_upstream_invalid');
 if(!bytes.subarray(0,7).equals(Buffer.from('#EXTM3U')))return bytes;
 if(bytes.length>MAX_PLAYLIST_BYTES)throw fail('plugin_media_upstream_invalid');
 const text=bytes.toString('utf8');
 if(/#EXT-X-(?:BYTERANGE|SESSION-KEY)/.test(text)||text.split(/\r?\n/).some(line=>line.startsWith('#EXT-X-KEY:')&&!/^#EXT-X-KEY:METHOD=NONE(?:,|$)/.test(line)))throw fail('plugin_media_upstream_invalid');
 const lines=text.split(/\r?\n/).map(line=>line.trim());const urls=lines.filter(line=>line&&!line.startsWith('#')).map(line=>mediaURL(line,url).href);
 if(!urls.length||urls.length>2000)throw fail('plugin_media_upstream_invalid');
 if(text.includes('#EXT-X-STREAM-INF:'))return mediaInput(urls[0],{fetchBytesImpl,signal},depth+1);
 const maps=lines.filter(line=>line.startsWith('#EXT-X-MAP:'));let init=Buffer.alloc(0);
 if(maps.length){const latest=maps.at(-1);const match=latest.match(/^#EXT-X-MAP:URI="([^"\r\n]+)"$/);if(!match)throw fail('plugin_media_upstream_invalid');init=await fetchBytesImpl(mediaURL(match[1],url).href,{signal,maxBytes:1024*1024});if(!Buffer.isBuffer(init)||init.length>1024*1024)throw fail('plugin_media_upstream_invalid');}
 const segment=await mediaInput(urls.at(-1),{fetchBytesImpl,signal},depth+1);
 if(init.length+segment.length>MAX_MEDIA_BYTES)throw fail('plugin_media_upstream_invalid');return Buffer.concat([init,segment]);
}

/** Trusted code only. Uploaded module source is never accepted by this worker. */
export async function renderYouTubeFrame(input,{spawnImpl=spawn,fetchBytesImpl=fetchPublicMediaBytes,signal}={}){
 const {videoId,fit}=checkRequest(input);
 const args=['--ignore-config','--no-config-locations','--no-plugin-dirs','--no-remote-components','--no-update','--no-cache-dir','--no-playlist','--no-wait-for-video','--no-live-from-start','--skip-download','--get-url','--no-warnings','--quiet','--socket-timeout','5','--retries','0','--extractor-retries','0','--no-js-runtimes','--js-runtimes','node:/usr/local/bin/node','--use-extractors','youtube','--format','best[height<=480]/best','--','https://www.youtube.com/watch?v='+videoId];
 const output=await runTool('/usr/local/bin/yt-dlp',args,{spawnImpl,signal,maxBytes:16384});
 const text=output.toString('utf8').replace(/\r?\n$/,'');const url=mediaURL(text).href;
 const bytes=await mediaInput(url,{fetchBytesImpl,signal});
 const filter=fit==='cover'?'scale=240:296:force_original_aspect_ratio=increase,crop=240:296,setsar=1':'scale=240:296:force_original_aspect_ratio=decrease,pad=240:296:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';
 const rgb565=await runTool('/usr/local/bin/ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','pipe','-probesize','8388608','-analyzeduration','3000000','-i','pipe:0','-map','0:v:0','-an','-sn','-dn','-frames:v','1','-threads','1','-filter_threads','1','-vf',filter,'-pix_fmt','rgb565le','-f','rawvideo','pipe:1'],{spawnImpl,signal,input:bytes,maxBytes:FRAME_BYTES,allowEarlyInputClose:true});
 if(rgb565.length!==FRAME_BYTES)throw fail('plugin_media_invalid_frame');return rgb565;
}

export async function runMediaWorker({stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,spawnImpl=spawn,fetchBytesImpl=fetchPublicMediaBytes}={}){
 const controller=new AbortController();const deadline=setTimeout(()=>controller.abort(),19000);let size=0;const parts=[];
 const stop=()=>controller.abort();controller.signal.addEventListener('abort',()=>stdin.destroy(fail('plugin_media_cancelled')),{once:true});process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{
  for await(const chunk of stdin){size+=chunk.length;if(size>1024)throw fail('plugin_media_invalid_request');parts.push(chunk);}
  let input;try{input=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fail('plugin_media_invalid_request');}
  const frame=await renderYouTubeFrame(input,{spawnImpl,fetchBytesImpl,signal:controller.signal});if(controller.signal.aborted)throw fail('plugin_media_timeout');
  await new Promise((resolve,reject)=>stdout.write(frame,error=>error?reject(error):resolve()));return true;
 }catch(error){
  if(error?.code==='plugin_media_provider_restricted'){try{stderr.write(PROVIDER_RESTRICTED_MARKER);}catch{}}
  return false;
 }
 finally{clearTimeout(deadline);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runMediaWorker()?0:1;
