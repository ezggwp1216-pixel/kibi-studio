import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {DAEMON_POLICY_ARGS,hasRequiredDaemonIsolation} from './daemon-policy.mjs';

const FRAME_BYTES=240*296*2;
const PROVIDER_RESTRICTED_MARKER=Buffer.from('KIBI_MEDIA_ERROR_V1 plugin_media_provider_restricted\n');
const PROCESS_ENV=Object.freeze({PATH:'/usr/local/bin:/usr/bin:/bin'});
let globallyActive=0;
const fail=code=>Object.assign(new Error(code),{code});

function validRequest(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['videoId','fit','signal'].includes(key))||
  typeof input.videoId!=='string'||!/^[A-Za-z0-9_-]{11}$/.test(input.videoId)||
  (input.fit!==undefined&&!['contain','cover'].includes(input.fit))||
  (input.signal!==undefined&&!(input.signal instanceof AbortSignal)))throw fail('plugin_media_invalid_request');
 return {videoId:input.videoId,fit:input.fit??'contain'};
}

// Never return stderr, an upstream URL or a process exception to the caller.
function boundedProcess(spawnImpl,file,args,{input,signal,maxBytes=FRAME_BYTES,timeoutMs=20000,stopTimeoutMs=200,overflowCode='plugin_media_invalid_frame',mediaProtocol=false}={}){
 return new Promise((resolve,reject)=>{
  let child,settled=false,closed=false,failure,size=0,stderrSize=0,timer,stopTimer,markerMatches=mediaProtocol;const chunks=[];
  const settle=(error,value)=>{
   if(settled)return;settled=true;clearTimeout(timer);clearTimeout(stopTimer);signal?.removeEventListener('abort',abort);
   if(error)reject(error);else resolve(value);
  };
  const stop=error=>{
   if(settled)return;failure??=error;clearTimeout(timer);
   if(!child||closed){settle(failure);return;}
   try{child.kill('SIGKILL');}catch{}
   // A kill request alone does not prove that a process has stopped. Keep the
   // operation pending until close, or report uncertainty within a fixed grace.
   if(!settled&&!stopTimer)stopTimer=setTimeout(()=>settle(fail('plugin_media_cleanup_failed')),stopTimeoutMs);
  };
  const abort=()=>stop(fail(signal.reason?.code==='plugin_media_timeout'?'plugin_media_timeout':'plugin_media_cancelled'));
  timer=setTimeout(()=>stop(fail('plugin_media_timeout')),timeoutMs);
  if(signal?.aborted){abort();return;}
  try{
   child=spawnImpl(file,args,{shell:false,stdio:['pipe','pipe','pipe'],env:PROCESS_ENV,windowsHide:true});
   child.on('error',()=>stop(fail('plugin_media_unavailable')));
   child.stdout.on('data',chunk=>{if(settled||failure)return;size+=chunk.length;if(size>maxBytes)stop(fail(overflowCode));else chunks.push(Buffer.from(chunk));});
   child.stderr.on('data',chunk=>{
    if(settled||failure)return;
    // Compare the fixed protocol incrementally; retain no raw worker stderr.
    markerMatches=markerMatches&&chunk.equals(PROVIDER_RESTRICTED_MARKER.subarray(stderrSize,stderrSize+chunk.length));
    stderrSize+=chunk.length;if(stderrSize>8192)stop(fail('plugin_media_unavailable'));
   });
   child.stdin.on('error',()=>stop(fail('plugin_media_unavailable')));
   child.on('close',exitCode=>{
    closed=true;
    const restricted=mediaProtocol&&exitCode===1&&size===0&&markerMatches&&stderrSize===PROVIDER_RESTRICTED_MARKER.length;
    const error=restricted?fail('plugin_media_provider_restricted'):exitCode!==0?fail('plugin_media_unavailable'):
     mediaProtocol&&size!==FRAME_BYTES?fail('plugin_media_invalid_frame'):mediaProtocol&&stderrSize!==0?fail('plugin_media_unavailable'):null;
    settle(failure??error,Buffer.concat(chunks));
   });
   signal?.addEventListener('abort',abort,{once:true});
   child.stdin.end(input??Buffer.alloc(0));
  }catch{stop(fail('plugin_media_unavailable'));}
 });
}

/** Trusted broker adapter. Call only after the module grant, binding and lease
 * checks; this service intentionally has no account API or plugin-code evaluator. */
export function createYouTubeFrameService({enabled=false,spawnImpl=spawn,dockerPath='docker',image='kibi-youtube-media:local',timeoutMs=20000,maxConcurrent=4}={}){
 if(typeof enabled!=='boolean'||typeof spawnImpl!=='function'||typeof dockerPath!=='string'||!dockerPath||dockerPath.includes('\0')||
  typeof image!=='string'||!(/^[a-z0-9][a-z0-9./_-]*(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})?$/.test(image))||
  !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>4)throw fail('plugin_media_invalid_configuration');
 let closed=false,verified=false,cleanupFailed=false;const jobs=new Set(),pending=new Set();
 const cleanupTimeoutMs=Math.max(1,Math.min(400,Math.floor(timeoutMs/8)));
 const stopTimeoutMs=Math.max(1,Math.min(200,Math.floor(timeoutMs/8)));
 const control=args=>boundedProcess(spawnImpl,dockerPath,args,{maxBytes:1024,timeoutMs:cleanupTimeoutMs,stopTimeoutMs});
 async function cleanup(name,completed){
  // --rm plus a successful run close proves that this container has stopped.
  // After an interrupted CLI, require removal or an exact daemon-side check.
  let processUncertain=false;
  try{await control(['kill',name]);}catch(error){processUncertain=error?.code==='plugin_media_cleanup_failed';}
  try{await control(['rm','--force',name]);return !processUncertain;}catch(error){processUncertain ||= error?.code==='plugin_media_cleanup_failed';}
  if(completed)return !processUncertain;
  try{
   const output=await control(['ps','--all','--filter',`name=^/${name}$`,'--format','{{.Names}}']);
   return !processUncertain&&output.toString('utf8').trim()==='';
  }catch{return false;}
 }
 async function execute(input,signal){
  const request=validRequest(input);
  if(!enabled||closed||cleanupFailed)throw fail('plugin_media_unavailable');
  if(signal?.aborted)throw fail('plugin_media_cancelled');
  if(jobs.size>=maxConcurrent||globallyActive>=4)throw fail('plugin_media_busy');
  const controller=new AbortController(),name='kibi-media-'+randomUUID();jobs.add(controller);globallyActive++;
  const abort=()=>controller.abort(fail('plugin_media_cancelled'));
  signal?.addEventListener('abort',abort,{once:true});
  // Bound normal execution plus kill/absence checks within the public deadline.
  const cleanupBudget=3*(cleanupTimeoutMs+stopTimeoutMs)+stopTimeoutMs;
  const deadline=setTimeout(()=>controller.abort(fail('plugin_media_timeout')),Math.max(1,timeoutMs-cleanupBudget));
  let started=false,completed=false,uncertain=false;
  try{
   const info=await boundedProcess(spawnImpl,dockerPath,DAEMON_POLICY_ARGS,{signal:controller.signal,maxBytes:4096,timeoutMs,stopTimeoutMs});
   if(!hasRequiredDaemonIsolation(info))throw fail('plugin_media_unavailable');
   if(controller.signal.aborted)throw fail(controller.signal.reason?.code??'plugin_media_cancelled');
   started=true;
   const args=['run','--rm','--name='+name,'--pull=never','--read-only','--user=65532:65532','--cap-drop=ALL','--security-opt=no-new-privileges:true','--pids-limit=64','--memory=512m','--memory-swap=512m','--cpus=1','--network=bridge','--tmpfs=/tmp:rw,noexec,nosuid,size=64m','--ulimit=nofile=64:64','--log-driver=none','-i',image];
   const rgb565=await boundedProcess(spawnImpl,dockerPath,args,{signal:controller.signal,input:Buffer.from(JSON.stringify(request)),timeoutMs,stopTimeoutMs,mediaProtocol:true});
   completed=true;
   if(controller.signal.aborted)throw fail(controller.signal.reason?.code??'plugin_media_cancelled');
   if(rgb565.length!==FRAME_BYTES)throw fail('plugin_media_invalid_frame');
   verified=true;return {rgb565,width:240,height:296,sha256:createHash('sha256').update(rgb565).digest('hex')};
  }catch(error){
   verified=false;uncertain=error?.code==='plugin_media_cleanup_failed';
   throw fail(['plugin_media_timeout','plugin_media_cancelled','plugin_media_invalid_frame','plugin_media_cleanup_failed','plugin_media_provider_restricted'].includes(error?.code)?error.code:'plugin_media_unavailable');
  }finally{
   clearTimeout(deadline);if(started&&!await cleanup(name,completed))uncertain=true;
   signal?.removeEventListener('abort',abort);jobs.delete(controller);
   if(uncertain){cleanupFailed=true;verified=false;throw fail('plugin_media_cleanup_failed');}
   globallyActive--;
   if(controller.signal.aborted){verified=false;throw fail(controller.signal.reason?.code==='plugin_media_timeout'?'plugin_media_timeout':'plugin_media_cancelled');}
  }
 }
 return {
  status:()=>({configured:enabled,enabled,available:enabled&&!closed&&!cleanupFailed&&verified,status:cleanupFailed?'cleanup_failed':closed?'closed':!enabled?'disabled':verified?'ready':'unverified'}),
  frame(input){let validated;try{validated=validRequest(input);}catch(error){return Promise.reject(error);}const job=execute(validated,input.signal);pending.add(job);job.then(()=>pending.delete(job),()=>pending.delete(job));return job;},
  async close(){closed=true;for(const job of jobs)job.abort(fail('plugin_media_cancelled'));await Promise.allSettled([...pending]);}
 };
}
