/** Static PNG -> bounded portable raster. Node built-ins only; no remote code,
 * host programs, device decoder, ICC profile execution or image-library install.
 * Pixel conversion uses PNG sample values (no gamma/ICC transform). */
import {inflateSync} from 'node:zlib';

export const PNG_RASTER_VERSION='host-png-raster-v1';
const SIGNATURE=Buffer.from('89504e470d0a1a0a','hex');
const MAX_INPUT=4*1024*1024,MAX_PIXELS=4*1024*1024,MAX_INFLATED=32*1024*1024;
const MAX_WIDTH=240,MAX_HEIGHT=296,MAX_HEADER=300000;
export class PngRasterError extends Error{
 constructor(code){super(code);this.name='PngRasterError';this.code=code;}
}
const check=(condition,code)=>{if(!condition)throw new PngRasterError(code);};
const CRC_TABLE=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=CRC_TABLE[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function parsePng(bytes){
 check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_INPUT,'BYTE_LIMIT');
 check(bytes.subarray(0,8).equals(SIGNATURE),'IMAGE_FORMAT');
 let at=8,count=0,width,height,depth,color,channels,rowBytes,palette=null,transparency=null,idatSeen=false,idatEnded=false,ended=false;
 const idat=[];
 while(at+12<=bytes.length&&++count<=4096){
  const length=bytes.readUInt32BE(at),end=at+length+12;
  check(end<=bytes.length,'IMAGE_STRUCTURE');
  const type=bytes.toString('ascii',at+4,at+8),payload=bytes.subarray(at+8,end-4);
  check(/^[A-Za-z]{4}$/.test(type),'IMAGE_STRUCTURE');
  check(crc32(bytes.subarray(at+4,end-4))===bytes.readUInt32BE(end-4),'IMAGE_CRC');
  if(count===1)check(type==='IHDR'&&length===13,'IMAGE_STRUCTURE');
  if(type==='IHDR'){
   check(count===1&&length===13,'IMAGE_STRUCTURE');
   width=payload.readUInt32BE(0);height=payload.readUInt32BE(4);depth=payload[8];color=payload[9];
   check(width>0&&height>0&&width<=4096&&height<=4096&&width*height<=MAX_PIXELS,'IMAGE_DIMENSIONS');
   channels=({0:1,2:3,3:1,4:2,6:4})[color];
   check(channels&&(color===0?[1,2,4,8,16]:color===3?[1,2,4,8]:[8,16]).includes(depth)&&payload[10]===0&&payload[11]===0&&payload[12]===0,'IMAGE_FORMAT');
   rowBytes=Math.ceil(width*channels*depth/8);
   check((rowBytes+1)*height<=MAX_INFLATED,'IMAGE_DIMENSIONS');
  }else if(type==='PLTE'){
   check(!idatSeen&&!palette&&!transparency&&color!==0&&color!==4&&length>=3&&length<=768&&length%3===0,'IMAGE_STRUCTURE');
   if(color===3)check(length/3<=2**depth,'IMAGE_STRUCTURE');
   palette=payload;
  }else if(type==='tRNS'){
   check(!idatSeen&&!transparency,'IMAGE_STRUCTURE');
   check(color===0?length===2:color===2?length===6:color===3?palette&&length>=1&&length<=palette.length/3:false,'IMAGE_STRUCTURE');
   if(color===0)check(payload.readUInt16BE(0)<2**depth,'IMAGE_STRUCTURE');
   if(color===2)for(let c=0;c<3;c++)check(payload.readUInt16BE(c*2)<2**depth,'IMAGE_STRUCTURE');
   transparency=payload;
  }else if(type==='IDAT'){
   check(!idatEnded&&(color!==3||palette),'IMAGE_STRUCTURE');idatSeen=true;idat.push(payload);
  }else if(type==='IEND'){
   check(length===0&&idatSeen&&end===bytes.length,'IMAGE_STRUCTURE');ended=true;break;
  }else{
   check(!['acTL','fcTL','fdAT'].includes(type),'IMAGE_ANIMATION_UNSUPPORTED');
   check(type[0]===type[0].toLowerCase(),'IMAGE_FORMAT');
   if(idatSeen)idatEnded=true;
  }
  at=end;
 }
 check(ended,'IMAGE_STRUCTURE');
 const compressed=Buffer.concat(idat);let inflated;
 try{
  const result=inflateSync(compressed,{maxOutputLength:(rowBytes+1)*height,info:true});
  check(result.engine.bytesWritten===compressed.length,'IMAGE_STRUCTURE');inflated=result.buffer;
 }catch(error){if(error instanceof PngRasterError)throw error;throw new PngRasterError('IMAGE_COMPRESSION');}
 check(inflated.length===(rowBytes+1)*height,'IMAGE_STRUCTURE');
 for(let y=0;y<height;y++)check(inflated[y*(rowBytes+1)]<=4,'IMAGE_STRUCTURE');
 return{width,height,depth,color,channels,rowBytes,palette,transparency,inflated,encodedBytes:bytes.length};
}
export function inspectPng(bytes){
 const p=parsePng(bytes);return{format:'png',width:p.width,height:p.height,frames:1,encodedBytes:p.encodedBytes,conversion:'none'};
}
function paeth(a,b,c){const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;}
function sample(row,index,depth){
 if(depth===8)return row[index];
 if(depth===16)return row.readUInt16BE(index*2);
 const bit=index*depth;return(row[bit>>>3]>>>(8-depth-(bit&7)))&((1<<depth)-1);
}
const to8=(value,depth)=>depth===16?value>>>8:depth===8?value:Math.round(value*255/((1<<depth)-1));
export function rasterizePng(bytes){
 const p=parsePng(bytes),scale=Math.min(1,MAX_WIDTH/p.width,MAX_HEIGHT/p.height);
 const width=Math.max(1,Math.floor(p.width*scale)),height=Math.max(1,Math.floor(p.height*scale));
 const pixels=Buffer.alloc(width*height*3),bpp=Math.max(1,Math.ceil(p.channels*p.depth/8));
 let previous=Buffer.alloc(p.rowBytes),row=Buffer.alloc(p.rowBytes),outY=0,nextY=Math.floor(p.height/(2*height));
 for(let y=0;y<p.height;y++){
  const start=y*(p.rowBytes+1),filter=p.inflated[start];
  for(let i=0;i<p.rowBytes;i++){
   const left=i>=bpp?row[i-bpp]:0,up=previous[i],upperLeft=i>=bpp?previous[i-bpp]:0;
   const prediction=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,upperLeft);
   row[i]=(p.inflated[start+1+i]+prediction)&255;
  }
  // Validate all palette indices, including pixels omitted by downsampling.
  if(p.color===3)for(let x=0;x<p.width;x++)check(sample(row,x,p.depth)<p.palette.length/3,'IMAGE_PALETTE');
  if(y===nextY&&outY<height){
   for(let x=0;x<width;x++){
    const sourceX=Math.min(p.width-1,Math.floor((x+0.5)*p.width/width)),index=sourceX*p.channels;
    let r,g,b,a=255;
    if(p.color===3){const i=sample(row,sourceX,p.depth);r=p.palette[i*3];g=p.palette[i*3+1];b=p.palette[i*3+2];a=p.transparency&&i<p.transparency.length?p.transparency[i]:255;
    }else if(p.color===0||p.color===4){const gray=sample(row,index,p.depth);r=g=b=to8(gray,p.depth);if(p.color===4)a=to8(sample(row,index+1,p.depth),p.depth);else if(p.transparency&&gray===p.transparency.readUInt16BE(0))a=0;
    }else{
     const red=sample(row,index,p.depth),green=sample(row,index+1,p.depth),blue=sample(row,index+2,p.depth);
     r=to8(red,p.depth);g=to8(green,p.depth);b=to8(blue,p.depth);
     if(p.color===6)a=to8(sample(row,index+3,p.depth),p.depth);
     else if(p.transparency&&red===p.transparency.readUInt16BE(0)&&green===p.transparency.readUInt16BE(2)&&blue===p.transparency.readUInt16BE(4))a=0;
    }
    const value=((r>>>3)<<11)|((g>>>2)<<5)|(b>>>3),at=(outY*width+x)*3;
    pixels[at]=value&255;pixels[at+1]=value>>>8;pixels[at+2]=a;
   }
   outY++;nextY=Math.floor((outY+0.5)*p.height/height);
  }
  const swap=previous;previous=row;row=swap;
 }
 check(outY===height,'IMAGE_STRUCTURE');
 return{width,height,pixels,sourceWidth:p.width,sourceHeight:p.height,sourceFormat:'png',conversion:PNG_RASTER_VERSION};
}

/** Data-only immutable C++ asset with a constant-time pixel accessor. The source
 * has one base64 group per RGB565-LE/straight-alpha pixel; no heap or image decoder
 * is needed on either native preview or Arduino. Application code owns clipping,
 * scaling and alpha blending into its existing framebuffer. */
export function generateRasterHeader(raster,namespace){
 const {width,height,pixels}=raster||{};
 check(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(namespace)&&Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width<=MAX_WIDTH&&height<=MAX_HEIGHT&&Buffer.isBuffer(pixels)&&pixels.length===width*height*3,'ASSET_METADATA');
 const base64=pixels.toString('base64'),literal=base64.match(/.{1,120}/g).map(s=>` "${s}"`).join('\n');
 const header=`#pragma once
#include <cstddef>
#include <cstdint>
// ${PNG_RASTER_VERSION}: RGB565 little-endian + straight alpha8; no runtime PNG decoder.
namespace ${namespace} {
static constexpr size_t kWidth=${width},kHeight=${height};
static const char kPixelsBase64[]=
${literal};
inline uint32_t RasterDigit(char c) { return c>='A'&&c<='Z'?uint32_t(c-'A'):c>='a'&&c<='z'?uint32_t(c-'a'+26):c>='0'&&c<='9'?uint32_t(c-'0'+52):c=='+'?62u:63u; }
inline bool ReadPixel(size_t x,size_t y,uint16_t* color,uint8_t* alpha) {
 if(x>=kWidth||y>=kHeight||!color||!alpha) return false;
 const size_t at=(y*kWidth+x)*4;
 const uint32_t bits=(RasterDigit(kPixelsBase64[at])<<18)|(RasterDigit(kPixelsBase64[at+1])<<12)|(RasterDigit(kPixelsBase64[at+2])<<6)|RasterDigit(kPixelsBase64[at+3]);
 *color=uint16_t((bits>>16)|((bits&0xff00u))); *alpha=uint8_t(bits); return true;
}
inline bool DecodeRow(size_t y,uint16_t* colors,uint8_t* alpha,size_t capacity) {
 if(y>=kHeight||!colors||!alpha||capacity<kWidth) return false;
 for(size_t x=0;x<kWidth;x++) ReadPixel(x,y,colors+x,alpha+x);
 return true;
}
}
`;
 check(Buffer.byteLength(header)<=MAX_HEADER,'ASSET_LIMIT');return header;
}
