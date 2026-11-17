import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectPng,rasterizePng,generateRasterHeader,PngRasterError} from './png-raster.mjs';

// Synthetic PNG fixtures only; expected pixels below are hand-derived RGB565/alpha.
function crc(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return(n^0xffffffff)>>>0;}
function chunk(type,payload){const name=Buffer.from(type),n=Buffer.alloc(4),sum=Buffer.alloc(4);n.writeUInt32BE(payload.length);sum.writeUInt32BE(crc(Buffer.concat([name,payload])));return Buffer.concat([n,name,payload,sum]);}
function png({width=2,height=1,depth=8,color=2,rows,palette,transparency,extra=[],compressed}={}){
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=depth;ihdr[9]=color;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),...(palette?[chunk('PLTE',Buffer.from(palette))]:[]),...(transparency?[chunk('tRNS',Buffer.from(transparency))]:[]),...extra.map(([type,data])=>chunk(type,Buffer.from(data))),chunk('IDAT',compressed??deflateSync(Buffer.from(rows))),chunk('IEND',Buffer.alloc(0))]);
}
const bad=code=>error=>error instanceof PngRasterError&&error.code===code;
const pixels=r=>Array.from(r.pixels);

test('PNG raster restores all five filters to identical RGB565 colors',()=>{
 const secondRows=[[15,25,35,45,55,65],[15,25,35,30,30,30],[5,5,5,5,5,5],[10,15,20,18,18,18],[5,5,5,5,5,5]];
 for(let filter=0;filter<5;filter++){
  const r=rasterizePng(png({height:2,rows:[0,10,20,30,40,50,60,filter,...secondRows[filter]]}));
  assert.deepEqual(pixels(r),[0xa3,0x08,255,0x87,0x29,255,0xc4,0x08,255,0xa8,0x29,255],`filter ${filter}`);
 }
});
test('Paeth filter selects left and upper-left predictors rather than treating it as Up',()=>{
 const left=rasterizePng(png({color:0,height:2,rows:[0,10,20,4,20,10]}));
 assert.deepEqual(pixels(left).slice(-6),[0xe3,0x18,255,0x45,0x29,255]);
 const upperLeft=rasterizePng(png({color:0,height:2,rows:[0,25,20,4,5,15]}));
 assert.deepEqual(pixels(upperLeft).slice(-6),[0xe3,0x18,255,0x45,0x29,255]);
});
test('filter byte distances remain correct for packed and sixteen bit samples',()=>{
 const packed=rasterizePng(png({color:0,depth:1,height:2,rows:[0,0x80,2,0xc0]}));
 assert.deepEqual(pixels(packed),[255,255,255,0,0,255,0,0,255,255,255,255]);
 const rgb16=rasterizePng(png({color:2,depth:16,rows:[1,255,255,0,0,0,0,1,1,255,255,0,0]}));
 assert.deepEqual(pixels(rgb16),[0,248,255,224,7,255]);
});
test('grayscale and indexed PNG support each permitted packed bit depth',()=>{
 for(const [depth,samples]of [[1,[0x40]],[2,[0x30]],[4,[0x0f]],[8,[0,255]],[16,[0,0,255,255]]]){
  assert.deepEqual(pixels(rasterizePng(png({depth,color:0,rows:[0,...samples]}))),[0,0,255,255,255,255]);
 }
 for(const [depth,samples]of [[1,[0x40]],[2,[0x10]],[4,[0x01]],[8,[0,1]]]){
  const r=rasterizePng(png({depth,color:3,palette:[255,0,0,0,255,0],transparency:[0,128],rows:[0,...samples]}));
  assert.deepEqual(pixels(r),[0,0xf8,0,0xe0,7,128]);
 }
});
test('RGB, grayscale-alpha and RGBA PNG preserve eight and sixteen bit color/alpha semantics',()=>{
 const cases=[
  {color:2,depth:8,rows:[0,255,0,0,0,255,0],want:[0,0xf8,255,0xe0,7,255]},
  {color:2,depth:16,rows:[0,255,255,0,0,0,0,0,0,255,255,0,0],want:[0,0xf8,255,0xe0,7,255]},
  {color:4,depth:8,rows:[0,0,0,255,128],want:[0,0,0,255,255,128]},
  {color:4,depth:16,rows:[0,0,0,0,0,255,255,128,0],want:[0,0,0,255,255,128]},
  {color:6,depth:8,rows:[0,255,0,0,64,0,255,0,255],want:[0,0xf8,64,0xe0,7,255]},
  {color:6,depth:16,rows:[0,255,255,0,0,0,0,64,0,0,0,0,0,255,255,128,0],want:[0,0xf8,64,31,0,128]},
 ];
 for(const c of cases)assert.deepEqual(pixels(rasterizePng(png(c))),c.want,`${c.color}/${c.depth}`);
});
test('tRNS compares full source samples before sixteen bit reduction',()=>{
 const gray=rasterizePng(png({color:0,depth:16,transparency:[128,0],rows:[0,128,0,128,255]}));
 assert.deepEqual(pixels(gray),[16,132,0,16,132,255]);
 const rgb=rasterizePng(png({color:2,depth:16,transparency:[0,1,0,2,0,3],rows:[0,0,1,0,2,0,3,0,1,0,2,0,4]}));
 assert.deepEqual(pixels(rgb),[0,0,0,0,0,255]);
 const low=rasterizePng(png({color:0,depth:2,transparency:[0,3],rows:[0,0x30]}));
 assert.deepEqual(pixels(low),[0,0,255,255,255,0]);
});
test('host resize fits the native display with center-nearest sampling and no upscaling',()=>{
 const row=[0,...Array.from({length:480},(_,x)=>x<240?[255,0,0]:[0,255,0]).flat()];
 const r=rasterizePng(png({width:480,height:296,rows:Array.from({length:296},()=>row).flat()}));
 assert.deepEqual({width:r.width,height:r.height,sourceWidth:r.sourceWidth,sourceHeight:r.sourceHeight},{width:240,height:148,sourceWidth:480,sourceHeight:296});
 assert.deepEqual(Array.from(r.pixels.subarray(0,3)),[0,248,255]);
 assert.deepEqual(Array.from(r.pixels.subarray(-3)),[224,7,255]);
 const small=rasterizePng(png({rows:[0,255,0,0,0,255,0]}));assert.equal(small.width,2);assert.equal(small.height,1);
});
test('malformed palettes, transparency, compression and unsupported animation reject before raster generation',()=>{
 const valid=png({rows:[0,255,0,0,0,255,0]});const corrupt=Buffer.from(valid);corrupt[45]^=1;
 assert.throws(()=>rasterizePng(corrupt),bad('IMAGE_CRC'));
 assert.throws(()=>rasterizePng(png({rows:[5,255,0,0,0,255,0]})),bad('IMAGE_STRUCTURE'));
 assert.throws(()=>rasterizePng(png({color:3,depth:8,palette:[255,0,0],rows:[0,0,1]})),bad('IMAGE_PALETTE'));
 assert.throws(()=>rasterizePng(png({width:480,color:3,depth:8,palette:[255,0,0],rows:[0,1,...Array(479).fill(0)]})),bad('IMAGE_PALETTE'));
 assert.throws(()=>rasterizePng(png({color:3,palette:[255,0,0],transparency:[0,255],rows:[0,0,0]})),bad('IMAGE_STRUCTURE'));
 assert.throws(()=>rasterizePng(png({color:6,transparency:[0,0],rows:[0,0,0,0,0,0,0,0,0]})),bad('IMAGE_STRUCTURE'));
 assert.throws(()=>rasterizePng(png({color:0,depth:1,transparency:[0,2],rows:[0,0]})),bad('IMAGE_STRUCTURE'));
 assert.throws(()=>rasterizePng(png({compressed:deflateSync(Buffer.alloc(1000))})),bad('IMAGE_COMPRESSION'));
 assert.throws(()=>rasterizePng(png({rows:[0,255,0,0,0,255,0],extra:[['acTL',[0,0,0,2,0,0,0,0]]]})),bad('IMAGE_ANIMATION_UNSUPPORTED'));
 assert.throws(()=>rasterizePng(png({width:4096,height:4096,rows:[]})),bad('IMAGE_DIMENSIONS'));
 assert.equal(inspectPng(valid).conversion,'none');
});
test('portable raster helper preserves pixels, rejects invalid bounds and fits the managed header budget',async t=>{
 const raster=rasterizePng(png({color:6,rows:[0,255,0,0,64,0,255,0,255]}));
 const header=generateRasterHeader(raster,'RasterTest');assert.equal(header,generateRasterHeader(raster,'RasterTest'));
 assert.throws(()=>generateRasterHeader(raster,'bad\";exec()'),bad('ASSET_METADATA'));
 const max={width:240,height:296,pixels:Buffer.alloc(240*296*3,255)};
 assert.ok(Buffer.byteLength(generateRasterHeader(max,'WorstCase'))+1538725+2000<2*1024*1024);
 const compiler=spawnSync('c++',['--version']);if(compiler.error?.code==='ENOENT'){t.skip('No system C++ compiler');return;}
 const root=await mkdtemp('/private/tmp/kibi-png-raster-');t.after(()=>rm(root,{recursive:true,force:true}));const output=join(root,'raster-test');
 const program=`#include <cstdio>\n${header}\nint main(){uint16_t color=77,c[3]={0,0,77};uint8_t alpha=99,a[3]={0,0,99};if(RasterTest::ReadPixel(2,0,&color,&alpha)||RasterTest::ReadPixel(0,1,&color,&alpha)||RasterTest::ReadPixel(0,0,nullptr,&alpha)||RasterTest::ReadPixel(0,0,&color,nullptr)||color!=77||alpha!=99)return 1;if(RasterTest::DecodeRow(1,c,a,2)||RasterTest::DecodeRow(0,c,a,1)||RasterTest::DecodeRow(0,nullptr,a,2)||RasterTest::DecodeRow(0,c,nullptr,2))return 2;if(!RasterTest::ReadPixel(0,0,&color,&alpha)||color!=0xf800||alpha!=64)return 3;if(!RasterTest::DecodeRow(0,c,a,2)||c[0]!=0xf800||c[1]!=0x07e0||a[0]!=64||a[1]!=255||c[2]!=77||a[2]!=99)return 4;std::printf("%u %u %u %u",c[0],c[1],a[0],a[1]);return 0;}`;
 const built=spawnSync('c++',['-std=c++11','-x','c++','-','-o',output],{input:program,encoding:'utf8'});assert.equal(built.status,0,built.stderr);
 const ran=spawnSync(output,[],{encoding:'utf8'});assert.equal(ran.status,0,ran.stderr);assert.equal(ran.stdout,'63488 2016 64 255');
});
