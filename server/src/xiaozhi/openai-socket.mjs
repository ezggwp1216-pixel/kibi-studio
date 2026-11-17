import tls from 'node:tls';
import {createHash,randomBytes} from 'node:crypto';
import {WebSocketDecoder,encodeClientFrame} from '../virtual-kibi/ws-codec.mjs';

const fault=code=>Object.assign(new Error(code),{code});
export function validateOpenAIConfiguration(configuration){
 const key=configuration?.api_key;
 if(typeof key!=='string'||!key.length||key.length>4096||!/^[\x21-\x7e]+$/.test(key))throw fault('configuration_required');
 try{const u=new URL(configuration.api_base_url);if(u.protocol!=='https:'||u.hostname!=='api.openai.com'||u.port&&u.port!=='443'||u.username||u.password||u.search||u.hash||!['/v1','/v1/'].includes(u.pathname))throw new Error();}catch{throw fault('unsupported_endpoint');}
 const model=configuration.model??configuration.api_model??'gpt-realtime';
 if(typeof model!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(model))throw fault('configuration_required');
 const instructions=configuration.instructions;
 if(instructions!==undefined&&(typeof instructions!=='string'||instructions.length>4000))throw fault('configuration_required');
 return {model,instructions};
}

/** Official TLS WebSocket only. connectTls is trusted test DI, never a user URL. */
export async function connectOpenAI({configuration,signal,onEvent,onClose,connectTls=options=>tls.connect(options)}={}){
 const {model}=validateOpenAIConfiguration(configuration);
 if(signal?.aborted)throw fault('cancelled');
 let socket,secure=false,upgraded=false,ended=false,resolved=false,header=Buffer.alloc(0),queuedBytes=0,tail=Promise.resolve(),heartbeat;
 let resolveOpen,rejectOpen;const opened=new Promise((resolve,reject)=>{resolveOpen=resolve;rejectOpen=reject;});
 const nonce=randomBytes(16).toString('base64'),expected=createHash('sha1').update(nonce+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 const decoder=new WebSocketDecoder({maxMessageBytes:131072}),pending=new Set();let lastReceived=Date.now();
 const timer=setTimeout(()=>fail('timeout'),10000);
 const abort=()=>fail('cancelled');
 function finish(code,notify){
  if(ended)return;ended=true;clearTimeout(timer);clearInterval(heartbeat);signal?.removeEventListener('abort',abort);
  for(const reject of [...pending])reject(fault(code));pending.clear();header=Buffer.alloc(0);
  socket?.destroy();socket?.off('data',incoming);socket?.off('secureConnect',secured);
  if(!resolved)rejectOpen(fault(code));else if(notify){try{onClose?.(code);}catch{}}
 }
 function fail(code){finish(code,true);}
 function rawWrite(data){
  if(ended)return Promise.reject(fault('network_error'));
  if(queuedBytes+data.length>131072){fail('input_backpressure');return Promise.reject(fault('input_backpressure'));}
  queuedBytes+=data.length;
  const job=tail.then(()=>new Promise((resolve,reject)=>{
   if(ended){reject(fault('network_error'));return;}
   let done=false;const complete=error=>{if(done)return;done=true;clearTimeout(timeout);pending.delete(rejectPending);error?reject(error):resolve();};
   const rejectPending=error=>complete(error),timeout=setTimeout(()=>{complete(fault('timeout'));fail('timeout');},5000);pending.add(rejectPending);
   try{socket.write(data,error=>{if(error){complete(fault('network_error'));fail('network_error');}else complete();});}catch{complete(fault('network_error'));fail('network_error');}
  })).finally(()=>{queuedBytes-=data.length;});
  tail=job.catch(()=>{});return job;
 }
 const send=event=>{let value;try{value=JSON.stringify(event);}catch{return Promise.reject(fault('provider_protocol_invalid'));}if(Buffer.byteLength(value)>131072)return Promise.reject(fault('input_backpressure'));return rawWrite(encodeClientFrame(value));};
 const connection={send,close:()=>finish('closed',false)};
 function secured(){
  if(ended)return;if(socket.authorized!==true){fail('tls_failed');return;}secure=true;
  const request='GET /v1/realtime?model='+encodeURIComponent(model)+' HTTP/1.1\r\nHost: api.openai.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+nonce+'\r\nAuthorization: Bearer '+configuration.api_key+'\r\n\r\n';
  void rawWrite(Buffer.from(request)).catch(()=>fail('network_error'));
 }
 function incoming(chunk){
  if(ended)return;lastReceived=Date.now();
  try{
   if(!upgraded){
    const room=16384-header.length;if(room<=0)throw fault('network_error');const piece=chunk.subarray(0,room);header=Buffer.concat([header,piece]);const end=header.indexOf('\r\n\r\n');
    if(end<0){if(chunk.length>=room)throw fault('network_error');return;}
    const lines=header.subarray(0,end).toString('latin1').split('\r\n'),status=/^HTTP\/1\.1 (\d{3})\b/.exec(lines.shift());
    if(!status)throw fault('network_error');if(status[1]!=='101')throw fault(status[1]==='401'?'authentication_required':status[1]==='429'?'quota_or_rate_limit':'network_error');
    const fields=new Map();for(const line of lines){const p=line.indexOf(':');if(p<1)throw fault('network_error');const name=line.slice(0,p).toLowerCase();if(fields.has(name))throw fault('network_error');fields.set(name,line.slice(p+1).trim());}
    if(fields.get('upgrade')?.toLowerCase()!=='websocket'||!fields.get('connection')?.toLowerCase().split(',').map(v=>v.trim()).includes('upgrade')||fields.get('sec-websocket-accept')!==expected||fields.has('sec-websocket-extensions')||fields.has('sec-websocket-protocol'))throw fault('network_error');
    chunk=Buffer.concat([header.subarray(end+4),chunk.subarray(piece.length)]);header=Buffer.alloc(0);upgraded=true;resolved=true;clearTimeout(timer);resolveOpen(connection);
    heartbeat=setInterval(()=>{if(Date.now()-lastReceived>60000){fail('timeout');return;}const mask=randomBytes(4);void rawWrite(Buffer.concat([Buffer.from([0x89,0x80]),mask])).catch(()=>fail('network_error'));},20000);heartbeat.unref?.();
   }
   if(chunk.length)for(const message of decoder.push(chunk)){
    if(message.opcode===8){fail('network_error');return;}
    if(message.opcode===9){void rawWrite(encodeClientFrame(message.payload,10)).catch(()=>fail('network_error'));continue;}
    if(message.opcode===10)continue;
    const event=JSON.parse(message.payload.toString('utf8'));if(!event||typeof event!=='object'||typeof event.type!=='string')throw fault('provider_protocol_invalid');
    Promise.resolve(onEvent?.(event)).catch(()=>fail('provider_protocol_invalid'));
   }
  }catch(error){fail(['authentication_required','quota_or_rate_limit','provider_protocol_invalid'].includes(error?.code)?error.code:'network_error');}
 }
 signal?.addEventListener('abort',abort,{once:true});
 try{
  socket=connectTls({host:'api.openai.com',port:443,servername:'api.openai.com',rejectUnauthorized:true,minVersion:'TLSv1.2',checkServerIdentity:tls.checkServerIdentity});
  socket.on('data',incoming);socket.on('error',()=>fail(secure?'network_error':'tls_failed'));socket.on('close',()=>fail('network_error'));socket.once('secureConnect',secured);
 }catch{fail('network_error');}
 return opened;
}
