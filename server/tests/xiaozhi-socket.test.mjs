import test from 'node:test';
import assert from 'node:assert/strict';
import {Duplex} from 'node:stream';
import {createHash} from 'node:crypto';
import {connectOpenAI} from '../src/xiaozhi/openai-socket.mjs';

class Peer extends Duplex{
 constructor(status=101){super();this.authorized=true;this.status=status;this.writes=[];queueMicrotask(()=>this.emit('secureConnect'));}
 _read(){}
 _write(bytes,_,done){this.writes.push(Buffer.from(bytes));if(!this.upgraded){this.upgraded=true;const request=bytes.toString('ascii');this.request=request;const key=/Sec-WebSocket-Key: (.*)\r\n/.exec(request)?.[1];const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');this.push(Buffer.from(`HTTP/1.1 ${this.status} Test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`));}done();}
 event(value){const data=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(data.length<126?2:4);header[0]=0x81;if(data.length<126)header[1]=data.length;else{header[1]=126;header.writeUInt16BE(data.length,2);}this.push(Buffer.concat([header,data]));}
}
const configuration={api_key:'test-secret',api_base_url:'https://api.openai.com/v1'};
test('trusted socket validates TLS/upgrade, writes masked events and closes without retaining credentials',async()=>{
 const peer=new Peer(),events=[];let options;const c=await connectOpenAI({configuration,onEvent:e=>events.push(e),connectTls:o=>{options=o;return peer;}});
 assert.equal(options.host,'api.openai.com');assert.equal(options.rejectUnauthorized,true);assert.ok(peer.request.startsWith('GET /v1/realtime?model=gpt-realtime HTTP/1.1\r\n'));
 await c.send({type:'input_audio_buffer.append',audio:'AAAA'});assert.equal(peer.writes[1][1]&128,128);peer.event({type:'session.created',session:{id:'safe-user-channel'}});assert.equal(events.length,1);c.close();assert.equal(peer.destroyed,true);
});
test('upgrade auth and quota failures are fixed codes without raw response text',async()=>{
 for(const [status,code] of [[401,'authentication_required'],[429,'quota_or_rate_limit'],[403,'network_error']])await assert.rejects(connectOpenAI({configuration,connectTls:()=>new Peer(status)}),{message:code});
 await assert.rejects(connectOpenAI({configuration:{...configuration,api_base_url:'http://api.openai.com/v1'},connectTls:()=>{throw new Error('must not connect');}}),{message:'unsupported_endpoint'});
});
test('actual provider socket delivers near-limit audio with adjacent transcript/audio TLS frames',async()=>{
 const peer=new Peer(),events=[],closed=[];const connection=await connectOpenAI({configuration,onEvent:event=>events.push(event),onClose:code=>closed.push(code),connectTls:()=>peer});
 try{
  const expected=[{type:'response.output_audio_transcript.delta',delta:'t'.repeat(7000)},{type:'response.output_audio.delta',response_id:'response',item_id:'item',content_index:0,delta:'A'.repeat(128000)},{type:'response.output_audio.delta',response_id:'response',item_id:'item',content_index:0,delta:'A'.repeat(8000)}];
  const frames=expected.map(event=>{const payload=Buffer.from(JSON.stringify(event)),header=Buffer.alloc(payload.length<=65535?4:10);header[0]=0x81;if(header.length===4){header[1]=126;header.writeUInt16BE(payload.length,2);}else{header[1]=127;header.writeBigUInt64BE(BigInt(payload.length),2);}return Buffer.concat([header,payload]);});
  const stream=Buffer.concat(frames);for(let at=0;at<stream.length;at+=16384)peer.push(stream.subarray(at,at+16384));
  assert.equal(peer.destroyed,false);assert.deepEqual(closed,[]);assert.deepEqual(events,expected);
 }finally{connection.close();}
});
