import {randomBytes} from 'node:crypto';
const invalid=()=>new Error('websocket_protocol');
const utf8=new TextDecoder('utf-8',{fatal:true});
export function encodeClientFrame(payload,opcode=1){
 const b=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
 if(![1,8,10].includes(opcode)||b.length>1200000||(opcode>=8&&b.length>125))throw invalid();
 const header=Buffer.alloc(b.length<126?6:b.length<=65535?8:14);header[0]=0x80|opcode;
 let p=2;if(b.length<126)header[1]=0x80|b.length;else if(b.length<=65535){header[1]=0xfe;header.writeUInt16BE(b.length,2);p=4;}else{header[1]=0xff;header.writeBigUInt64BE(BigInt(b.length),2);p=10;}
 const mask=randomBytes(4);mask.copy(header,p);const data=Buffer.allocUnsafe(b.length);for(let i=0;i<b.length;i++)data[i]=b[i]^mask[i%4];return Buffer.concat([header,data]);
}
export class WebSocketDecoder{
 constructor({maxMessageBytes=1200000}={}){this.max=maxMessageBytes;this.buffer=Buffer.alloc(0);this.storage=Buffer.alloc(0);this.parts=[];this.fragmentBytes=0;this.fragmented=false;}
 push(chunk){
  if(!Buffer.isBuffer(chunk))throw invalid();
  const result=[];let frames=0,offset=0;
  // Retain only the current frame. A TLS chunk may finish it and also contain
  // following frames; those bytes do not count against this message's limit.
  const fill=size=>{
   if(this.buffer.length>=size)return true;
   const take=Math.min(size-this.buffer.length,chunk.length-offset);if(!take)return false;
   if(this.storage.length<size){const next=Buffer.allocUnsafe(size);this.buffer.copy(next);this.storage=next;}
   chunk.copy(this.storage,this.buffer.length,offset,offset+take);offset+=take;this.buffer=this.storage.subarray(0,this.buffer.length+take);return this.buffer.length>=size;
  };
  while(this.buffer.length||offset<chunk.length){
   if(!fill(2))break;
   const fin=!!(this.buffer[0]&128),opcode=this.buffer[0]&15;let n=this.buffer[1]&127,p=2;
   if((this.buffer[0]&0x70)||(this.buffer[1]&128)||![0,1,8,9,10].includes(opcode))throw invalid();
   if(opcode>=8&&(!fin||n>125))throw invalid();
   if(n===126){if(!fill(4))break;n=this.buffer.readUInt16BE(2);p=4;if(n<126)throw invalid();}
   else if(n===127){if(!fill(10))break;const size=this.buffer.readBigUInt64BE(2);if(size<65536n||size>BigInt(this.max))throw invalid();n=Number(size);p=10;}
   if(n>this.max||((opcode<8)&&n+this.fragmentBytes>this.max))throw invalid();if(!fill(p+n))break;
   if(++frames>2048)throw invalid();
   const payload=this.buffer.subarray(p,p+n);this.buffer=Buffer.alloc(0);this.storage=Buffer.alloc(0);
   if(opcode>=8){if(opcode===8){if(n===1)throw invalid();if(n>=2){const code=payload.readUInt16BE(0);if(code<1000||code>=5000||[1004,1005,1006,1015].includes(code)||(code>=1016&&code<3000))throw invalid();utf8.decode(payload.subarray(2));}}result.push({opcode,payload});continue;}
   if(opcode===1){if(this.fragmented)throw invalid();if(fin){utf8.decode(payload);result.push({opcode:1,payload});}else{this.fragmented=true;this.parts=[payload];this.fragmentBytes=n;}}
   else{if(!this.fragmented||this.parts.length>=1024)throw invalid();this.parts.push(payload);this.fragmentBytes+=n;if(fin){const text=Buffer.concat(this.parts,this.fragmentBytes);utf8.decode(text);result.push({opcode:1,payload:text});this.parts=[];this.fragmentBytes=0;this.fragmented=false;}}
  }return result;
 }
}
