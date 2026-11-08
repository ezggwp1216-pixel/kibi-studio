/** Causal 63-tap windowed-sinc anti-alias FIR followed by rational interpolation.
 * State and output are bounded by the supplied chunk. No whole utterance buffering.
 * A continuous stream emits exactly floor(inputSamples * destination/source) samples.
 */
export class PcmResampler {
 constructor(source,destination){
  if(![[16000,24000],[24000,16000]].some(pair=>pair[0]===source&&pair[1]===destination))throw new Error('pcm_rate_invalid');
  this.source=source;this.destination=destination;this.history=new Float64Array(63);this.coefficients=new Float64Array(63);this.reset();
  const cutoff=0.45*Math.min(source,destination)/source;let sum=0;
  for(let n=0;n<63;n++){const k=n-31;const sinc=k===0?2*cutoff:Math.sin(2*Math.PI*cutoff*k)/(Math.PI*k);const window=0.42-0.5*Math.cos(2*Math.PI*n/62)+0.08*Math.cos(4*Math.PI*n/62);this.coefficients[n]=sinc*window;sum+=this.coefficients[n];}
  for(let n=0;n<63;n++)this.coefficients[n]/=sum;
 }
 reset(){this.history.fill(0);this.cursor=0;this.phase=0;this.previous=0;}
 process(pcm){
  if(!Buffer.isBuffer(pcm)||pcm.length%2||pcm.length>192000)throw new Error('pcm_invalid');
  const samples=pcm.length/2,count=Math.floor((this.phase+samples*this.destination)/this.source),out=Buffer.alloc(count*2);let used=0;
  for(let at=0;at<samples;at++){
   this.history[this.cursor]=pcm.readInt16LE(at*2);let filtered=0;
   for(let tap=0;tap<63;tap++)filtered+=this.coefficients[tap]*this.history[(this.cursor-tap+63)%63];
   this.cursor=(this.cursor+1)%63;this.phase+=this.destination;
   while(this.phase>=this.source){const fraction=1-(this.phase-this.source)/this.destination;const value=Math.round(this.previous+(filtered-this.previous)*fraction);out.writeInt16LE(Math.max(-32768,Math.min(32767,value)),used);used+=2;this.phase-=this.source;}
   this.previous=filtered;
  }
  return out;
 }
}
