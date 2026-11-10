import https from 'node:https';
import {isIP} from 'node:net';
import {randomUUID} from 'node:crypto';
import {sanitizeVoiceDiagnosticMetrics} from '../voice-diagnostics.mjs';
import {WebSocketServer,WebSocket} from '../../resources/xiaozhi/network/ws-8.22.1/wrapper.mjs';
import {createXiaozhiOpenAIAdapter} from './adapter.mjs';

const PATH='/kibi-xiaozhi/v1',JSON_LIMIT=16384,OPUS_LIMIT=1275,QUEUE_BYTES=65536,QUEUE_MESSAGES=32;
const coreCodes=new Set(['idle','connecting','ready','closed','cancelled','configuration_required','unsupported_endpoint','device_protocol_invalid','codec_failed','input_backpressure','output_backpressure','authentication_required','quota_or_rate_limit','provider_error','provider_protocol_invalid','network_error','tls_failed','timeout']);
const codes=new Set([...coreCodes,'listening','connected','gateway_busy','gateway_closed','not_found']);
const failure=code=>Object.assign(new Error(codes.has(code)?code:'network_error'),{code:codes.has(code)?code:'network_error'});
const count=n=>Math.min(Number.MAX_SAFE_INTEGER,n+1);
function bucket(capacity,perSecond){let tokens=capacity,at=Date.now();return cost=>{const now=Date.now();tokens=Math.min(capacity,tokens+Math.max(0,now-at)*perSecond/1000);at=now;if(tokens<cost)return false;tokens-=cost;return true;};}

/** Trusted Node-only TLS device endpoint. Construction does not listen or start a provider.
 * authorize owns capability comparison and current project/configuration identity checks.
 * It receives only {token}; configuration and cancellation never come from device JSON.
 */
export function createXiaozhiGateway({tls,host='127.0.0.1',port=0,authorize,createAdapter=createXiaozhiOpenAIAdapter,onStatus,onDiagnostics}={}){
 if(!tls||(!Buffer.isBuffer(tls.key)&&typeof tls.key!=='string')||!tls.key.length||(!Buffer.isBuffer(tls.cert)&&typeof tls.cert!=='string')||!tls.cert.length)throw new Error('gateway_tls_required');
 if(typeof authorize!=='function'||typeof createAdapter!=='function'||typeof host!=='string'||(!isIP(host)&&host!=='localhost')||!Number.isInteger(port)||port<0||port>65535)throw new Error('gateway_input_invalid');
 // Deliberately select only key/cert: callers cannot weaken TLS or inject filesystem paths/options.
 const server=https.createServer({key:tls.key,cert:tls.cert,minVersion:'TLSv1.2',maxHeaderSize:8192,handshakeTimeout:5000},(request,response)=>{
  response.writeHead(404,{'Content-Type':'text/plain','Content-Length':9,'Cache-Control':'no-store','Connection':'close'});response.end('not_found');
 });
 server.headersTimeout=5000;server.requestTimeout=5000;server.keepAliveTimeout=1000;server.maxHeadersCount=32;server.setTimeout(5000,socket=>socket.destroy());
 const wss=new WebSocketServer({noServer:true,clientTracking:true,perMessageDeflate:false,autoPong:false,maxPayload:JSON_LIMIT,maxFragments:32,maxBufferedChunks:64,closeTimeout:1000,skipUTF8Validation:false});
 const sockets=new Set(),authorizations=new Set(),creations=new Set(),adapterJobs=new Set(),retirements=new Set();const connectionRate=bucket(16,1.6);
 const totals={inputMessages:0,inputBytes:0,outputMessages:0,outputBytes:0,rejectedConnections:0,peakInputBytes:0,peakOutputBytes:0};
 let current=null,closing=false,closePromise=null,listenPromise=null,lastCode='idle',progressTimer=null;
 const snapshot=()=>({kind:'xiaozhi-gateway',code:current?.code??lastCode,metrics:{...totals,connections:sockets.size,activeSessions:current?.ws&&!current.ended?1:0,pendingAuthorization:authorizations.size,inputQueueMessages:current?.inCount??0,inputQueueBytes:current?.inBytes??0,outputQueueMessages:current?.outCount??0,outputQueueBytes:current?.outBytes??0}});
 const publish=()=>{try{onStatus?.(snapshot());}catch{/* Diagnostics never control device/session lifecycle. */}};
 const emit=code=>{lastCode=codes.has(code)?code:'network_error';publish();};
 function diagnostic(context,event='status',report){
  if(typeof onDiagnostics!=='function'||!context?.diagnosticPrincipal)return;
  try{
   const observed=report||context.adapter?.snapshot?.()||{};
   const result=onDiagnostics({principal:{...context.diagnosticPrincipal},sessionId:context.diagnosticId,event,code:codes.has(observed.code)?observed.code:context.code,metrics:sanitizeVoiceDiagnosticMetrics(observed.metrics)});
   Promise.resolve(result).catch(()=>{});
  }catch{/* Observations never control a socket or resource lifetime. */}
 }
 function diagnosticProgress(context){
  if(!context||context.ended||context.diagnosticTimer||!context.diagnosticPrincipal||typeof onDiagnostics!=='function')return;
  context.diagnosticTimer=setTimeout(()=>{context.diagnosticTimer=null;if(!context.ended)diagnostic(context);},1000);context.diagnosticTimer.unref?.();
 }
 // One coalesced update per 250 ms, including the trailing drain. State changes
 // remain immediate; traffic progress never substitutes a different state code.
 const progress=()=>{if(progressTimer||closing||!current||current.ended)return;progressTimer=setTimeout(()=>{progressTimer=null;publish();diagnosticProgress(current);},250);progressTimer.unref?.();};
 function retire(adapter){if(!adapter)return Promise.resolve();let promise;try{promise=Promise.resolve(adapter.close());}catch{promise=Promise.resolve();}const bounded=Promise.race([promise.catch(()=>{}),new Promise(resolve=>{const timer=setTimeout(resolve,1000);timer.unref?.();promise.finally(()=>clearTimeout(timer)).catch(()=>{});})]);retirements.add(bounded);bounded.finally(()=>retirements.delete(bounded));return bounded;}
 function end(context,code='closed'){
  if(context.ended)return;context.ended=true;clearTimeout(context.diagnosticTimer);context.diagnosticTimer=null;
  let metrics;try{metrics=context.adapter?.snapshot?.()?.metrics;}catch{}diagnostic(context,'end',{code,metrics});
  context.life.abort();clearTimeout(progressTimer);progressTimer=null;clearTimeout(context.authTimer);clearTimeout(context.readyTimer);clearInterval(context.heartbeat);context.ownerSignal?.removeEventListener('abort',context.ownerAbort);
  for(const cancel of [...context.operations])cancel();context.operations.clear();for(const item of context.output.splice(0))item.reject(failure(code));context.input.length=0;context.inBytes=0;context.inCount=0;context.outBytes=0;context.outCount=0;
  context.ws?.terminate();context.socket.destroy();if(current===context)current=null;void retire(context.adapter);context.adapter=null;emit(code);
 }
 function bounded(context,promise,ms,code='timeout'){
  return new Promise((resolve,reject)=>{let settled=false;const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);context.operations.delete(cancel);error?reject(error):resolve(value);};const cancel=()=>done(failure(context.ended?'cancelled':code));const timer=setTimeout(()=>{done(failure(code));end(context,code);},ms);context.operations.add(cancel);Promise.resolve(promise).then(value=>done(null,value),()=>done(failure('network_error')));if(context.ended)cancel();});
 }
 function reject(socket,status,code){totals.rejectedConnections=count(totals.rejectedConnections);emit(code);if(!socket.destroyed)socket.end('HTTP/1.1 '+status+' Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',()=>socket.destroy());}
 async function outputPump(context){
  if(context.writing||context.ended)return;context.writing=true;
  try{while(context.output.length&&!context.ended){const item=context.output.shift();try{
   const ws=context.ws,socket=context.socket;if(ws.readyState!==WebSocket.OPEN||socket.writableLength+ws.bufferedAmount>QUEUE_BYTES)throw failure('output_backpressure');
   await bounded(context,new Promise((resolve,reject)=>ws.send(item.payload,{binary:item.binary,compress:false},error=>error?reject(failure('network_error')):resolve())),5000);
   if(socket.writableLength>QUEUE_BYTES||ws.bufferedAmount>QUEUE_BYTES)throw failure('output_backpressure');
   if(socket.writableNeedDrain)await bounded(context,new Promise((resolve,reject)=>{const clean=()=>{socket.off('drain',drained);socket.off('error',failed);socket.off('close',failed);};const drained=()=>{clean();resolve();};const failed=()=>{clean();reject(failure('network_error'));};socket.once('drain',drained);socket.once('error',failed);socket.once('close',failed);if(!socket.writableNeedDrain)drained();}),5000);
   totals.outputMessages=count(totals.outputMessages);totals.outputBytes=Math.min(Number.MAX_SAFE_INTEGER,totals.outputBytes+item.bytes);progress();item.resolve();
  }catch(error){item.reject(failure(coreCodes.has(error?.code)?error.code:'network_error'));throw error;}finally{context.outBytes=Math.max(0,context.outBytes-item.bytes);context.outCount=Math.max(0,context.outCount-1);}}}
  catch(error){end(context,coreCodes.has(error?.code)?error.code:'network_error');}finally{context.writing=false;}
 }
 function sendDevice(context,payload,{binary=false}={}){
  if(context.ended)return Promise.reject(failure('closed'));let value;
  try{if(binary){if(!Buffer.isBuffer(payload)||!payload.length||payload.length>OPUS_LIMIT)throw failure('device_protocol_invalid');value=Buffer.from(payload);}else{if(!payload||typeof payload!=='object'||Array.isArray(payload)||Buffer.isBuffer(payload))throw failure('device_protocol_invalid');value=JSON.stringify(payload);if(Buffer.byteLength(value)>JSON_LIMIT)throw failure('device_protocol_invalid');}}
  catch{end(context,'device_protocol_invalid');return Promise.reject(failure('device_protocol_invalid'));}
  const bytes=Buffer.byteLength(value);if(!context.outputRate(1)||context.outCount>=QUEUE_MESSAGES||context.outBytes+bytes>QUEUE_BYTES||context.socket.writableLength+context.ws.bufferedAmount>QUEUE_BYTES){end(context,'output_backpressure');return Promise.reject(failure('output_backpressure'));}
  return new Promise((resolve,reject)=>{context.output.push({payload:value,binary,bytes,resolve,reject});context.outBytes+=bytes;context.outCount++;totals.peakOutputBytes=Math.max(totals.peakOutputBytes,context.outBytes);void outputPump(context);});
 }
 async function inputPump(context){
  if(context.reading||context.ended)return;context.reading=true;
  try{const adapter=await bounded(context,context.adapterReady,10000);while(context.input.length&&!context.ended){const item=context.input.shift();try{const job=Promise.resolve(adapter.receiveDevice(item.binary?item.payload:item.payload.toString('utf8'),{binary:item.binary}));adapterJobs.add(job);job.then(()=>adapterJobs.delete(job),()=>adapterJobs.delete(job));await bounded(context,job,30000);totals.inputMessages=count(totals.inputMessages);totals.inputBytes=Math.min(Number.MAX_SAFE_INTEGER,totals.inputBytes+item.bytes);progress();}finally{context.inBytes=Math.max(0,context.inBytes-item.bytes);context.inCount=Math.max(0,context.inCount-1);}}}
  catch(error){end(context,coreCodes.has(error?.code)?error.code:'device_protocol_invalid');}finally{context.reading=false;}
 }
 function connected(context,ws,configuration,ownerSignal){
  if(context.ended||closing){ws.terminate();return;}context.ws=ws;context.socket.setTimeout(0);context.ownerSignal=ownerSignal;context.ownerAbort=()=>end(context,'cancelled');ownerSignal?.addEventListener('abort',context.ownerAbort,{once:true});if(ownerSignal?.aborted){end(context,'cancelled');return;}
  context.code='connected';emit('connected');diagnostic(context,'status',{code:'connected'});context.readyTimer=setTimeout(()=>end(context,'timeout'),15000);let seenAt=Date.now();
  ws.on('message',(payload,binary)=>{
   if(context.ended)return;seenAt=Date.now();if(binary&&(!payload.length||payload.length>OPUS_LIMIT)||!binary&&payload.length>JSON_LIMIT){end(context,'device_protocol_invalid');return;}
   if(!context.inputRate(1)||!context.inputBytesRate(payload.length)||context.inCount>=QUEUE_MESSAGES||context.inBytes+payload.length>QUEUE_BYTES){end(context,'input_backpressure');return;}
   const bytes=payload.length;context.input.push({payload:Buffer.from(payload),binary,bytes});context.inBytes+=bytes;context.inCount++;totals.peakInputBytes=Math.max(totals.peakInputBytes,context.inBytes);void inputPump(context);
  });
  ws.on('pong',()=>{if(!context.controlRate(1)){end(context,'input_backpressure');return;}seenAt=Date.now();});
  ws.on('ping',payload=>{if(!context.controlRate(1)||context.socket.writableLength+ws.bufferedAmount>QUEUE_BYTES){end(context,'input_backpressure');return;}seenAt=Date.now();void bounded(context,new Promise((resolve,reject)=>ws.pong(payload,undefined,error=>error?reject(failure('network_error')):resolve())),5000).catch(()=>end(context,'network_error'));});
  ws.on('error',()=>end(context,'device_protocol_invalid'));ws.once('close',()=>end(context,'closed'));
  context.heartbeat=setInterval(()=>{if(Date.now()-seenAt>45000){end(context,'timeout');return;}if(context.socket.writableLength+ws.bufferedAmount>QUEUE_BYTES){end(context,'output_backpressure');return;}void bounded(context,new Promise((resolve,reject)=>ws.ping(undefined,undefined,error=>error?reject(failure('network_error')):resolve())),5000).catch(()=>end(context,'network_error'));},15000);context.heartbeat.unref?.();
  let creating;try{creating=Promise.resolve(createAdapter({configuration,signal:context.life.signal,sendDevice:(payload,options)=>sendDevice(context,payload,options),onStatus:report=>{if(context.ended)return;const code=coreCodes.has(report?.code)?report.code:'provider_error';context.code=code;if(code==='ready')clearTimeout(context.readyTimer);emit(code);diagnostic(context,'status',{code,metrics:report?.metrics});if(report?.closed||!['idle','connecting','ready'].includes(code))end(context,code);}}));}catch{end(context,'provider_error');return;}
  creations.add(creating);context.adapterReady=creating.then(adapter=>{creations.delete(creating);if(!adapter||typeof adapter.receiveDevice!=='function'||typeof adapter.close!=='function'){end(context,'provider_error');throw failure('provider_error');}if(context.ended){void retire(adapter);throw failure('closed');}context.adapter=adapter;return adapter;},()=>{creations.delete(creating);end(context,'provider_error');throw failure('provider_error');});context.adapterReady.catch(()=>{});
 }
 server.on('connection',socket=>{if(closing||sockets.size>=4||!connectionRate(1)){totals.rejectedConnections=count(totals.rejectedConnections);socket.destroy();emit('gateway_busy');return;}sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
 server.on('tlsClientError',()=>emit('tls_failed'));server.on('clientError',(error,socket)=>{socket.destroy();emit('device_protocol_invalid');});server.on('error',()=>emit('network_error'));
 server.on('upgrade',(request,socket,head)=>{void (async()=>{
  socket.on('error',()=>{});if(closing){reject(socket,503,'gateway_closed');return;}
  const names=request.rawHeaders.filter((value,index)=>index%2===0).map(value=>value.toLowerCase());
  if(request.method!=='GET'||request.url!==PATH||names.includes('origin')||names.includes('sec-websocket-protocol')||names.filter(n=>n==='authorization').length!==1){reject(socket,403,'device_protocol_invalid');return;}
  const match=/^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(request.headers.authorization||'');if(!match){reject(socket,401,'authentication_required');return;}
  if(current||authorizations.size||creations.size||adapterJobs.size){reject(socket,409,'gateway_busy');return;}
  const context={socket,ws:null,code:'connecting',ended:false,life:new AbortController(),operations:new Set(),input:[],output:[],inBytes:0,inCount:0,outBytes:0,outCount:0,inputRate:bucket(80,80),inputBytesRate:bucket(131072,131072),outputRate:bucket(160,160),controlRate:bucket(32,16)};current=context;socket.once('close',()=>end(context,'closed'));socket.pause();context.authTimer=setTimeout(()=>{reject(socket,408,'timeout');end(context,'timeout');},5000);
  let pending;try{pending=Promise.resolve(authorize({token:match[1]}));}catch{pending=Promise.resolve(null);}authorizations.add(pending);emit('connecting');let permission;
  try{permission=await pending;}catch{permission=null;}finally{authorizations.delete(pending);clearTimeout(context.authTimer);}
  if(context.ended||closing)return;if(!permission||!permission.configuration||typeof permission.configuration!=='object'||permission.signal?.aborted){reject(socket,401,'authentication_required');end(context,'authentication_required');return;}
  if(permission.principal?.kind==='account'&&permission.principal.accountId!=='owner'&&[permission.principal.accountId,permission.principal.id].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value))){context.diagnosticPrincipal={kind:'account',accountId:permission.principal.accountId,id:permission.principal.id};context.diagnosticId=randomUUID();diagnostic(context,'start',{code:'connecting'});}
  // The upgraded socket and factory never retain/request an HTTP-controlled configuration.
  try{wss.handleUpgrade(request,socket,head,ws=>connected(context,ws,permission.configuration,permission.signal));socket.resume();}catch{end(context,'device_protocol_invalid');}
 })().catch(()=>{socket.destroy();emit('network_error');});});
 return {
  listen(){if(closing)return Promise.reject(failure('gateway_closed'));if(listenPromise)return listenPromise;listenPromise=new Promise((resolve,reject)=>{const failed=()=>{server.off('listening',ready);reject(failure('tls_failed'));};const ready=()=>{server.off('error',failed);emit('listening');resolve(server.address());};server.once('error',failed);server.once('listening',ready);server.listen({host,port,backlog:4});});return listenPromise;},
  address:()=>server.address(),
  snapshot,
  close(){if(closePromise)return closePromise;closing=true;clearTimeout(progressTimer);progressTimer=null;if(current)end(current,'closed');for(const socket of sockets)socket.destroy();closePromise=(async()=>{await listenPromise?.catch(()=>{});await Promise.allSettled([new Promise(resolve=>{if(!server.listening)return resolve();server.close(()=>resolve());server.closeAllConnections?.();}),new Promise(resolve=>wss.close(()=>resolve())),...retirements]);server.removeAllListeners();wss.removeAllListeners();emit('closed');})();return closePromise;}
 };
}
