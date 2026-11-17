import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const OpusScript=require('../../resources/xiaozhi/codec/opusscript-0.1.1/index.js');

/** Stateful 16kHz mono / 60ms Opus. No file, network or credential access. */
export function createOpusCodec(){
 let encoder=new OpusScript(16000,1,OpusScript.Application.VOIP);
 let decoder=new OpusScript(16000,1,OpusScript.Application.VOIP);
 encoder.setBitrate(24000);
 encoder.encoderCTL(4010,5); // OPUS_SET_COMPLEXITY: bounded local CPU work.
 const alive=()=>{if(!encoder||!decoder)throw new Error('codec_closed');};
 return {
  encode(pcm){alive();if(!Buffer.isBuffer(pcm)||pcm.length!==1920)throw new Error('codec_frame_invalid');try{return encoder.encode(pcm,960);}catch{throw new Error('codec_encode_failed');}},
  decode(packet){alive();if(!Buffer.isBuffer(packet)||!packet.length||packet.length>1275)throw new Error('codec_packet_invalid');try{const pcm=decoder.decode(packet);if(pcm.length!==1920)throw new Error();return pcm;}catch{throw new Error('codec_packet_invalid');}},
  resetEncoder(){alive();encoder.encoderCTL(4028,0);},
  resetDecoder(){alive();decoder.decoderCTL(4028,0);},
  close(){if(encoder){encoder.delete();encoder=null;}if(decoder){decoder.delete();decoder=null;}}
 };
}
