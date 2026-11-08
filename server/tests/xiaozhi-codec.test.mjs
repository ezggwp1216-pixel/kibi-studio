import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpusCodec} from '../src/xiaozhi/codec.mjs';
import {PcmResampler} from '../src/xiaozhi/resample.mjs';

const tone=(rate,samples,hz=440)=>{const pcm=Buffer.alloc(samples*2);for(let n=0;n<samples;n++)pcm.writeInt16LE(Math.round(9000*Math.sin(2*Math.PI*hz*n/rate)),n*2);return pcm;};
const energy=pcm=>{let value=0;for(let n=0;n<pcm.length;n+=2)value+=Math.abs(pcm.readInt16LE(n));return value/(pcm.length/2);};

test('real pinned Opus codec emits decodable nonzero 60 ms mono speech frames',()=>{
 const codec=createOpusCodec();
 try{const packet=codec.encode(tone(16000,960));assert.ok(packet.length>5&&packet.length<=1275);const decoded=codec.decode(packet);assert.equal(decoded.length,1920);assert.ok(energy(decoded)>1000);assert.throws(()=>codec.encode(Buffer.alloc(640)),{message:'codec_frame_invalid'});assert.throws(()=>codec.decode(Buffer.alloc(0)),{message:'codec_packet_invalid'});}
 finally{codec.close();codec.close();}
 assert.throws(()=>codec.encode(tone(16000,960)),{message:'codec_closed'});
});

test('streaming resampling preserves duration across odd chunk boundaries and attenuates aliasing',()=>{
 const source=tone(24000,24000);const whole=new PcmResampler(24000,16000).process(source);
 const streamed=new PcmResampler(24000,16000),chunks=[];
 for(let at=0;at<source.length;at+=734)chunks.push(streamed.process(source.subarray(at,at+734)));
 assert.equal(whole.length,32000);assert.deepEqual(Buffer.concat(chunks),whole);assert.ok(energy(whole)>4000);
 const alias=new PcmResampler(24000,16000).process(tone(24000,24000,10000));assert.ok(energy(alias)<300);
 assert.equal(new PcmResampler(16000,24000).process(tone(16000,960)).length,2880);
 assert.throws(()=>streamed.process(Buffer.alloc(1)),{message:'pcm_invalid'});
});
