/** Host-only attachment import. The model supplies an opaque authorized ID, never
 * a filename, URL, image payload or executable source. The trusted resolver owns
 * private storage and full upload validation; this service checks its boundary,
 * prepares a static raster, and delegates the existing guarded atomic append. */
import {constants} from 'node:fs';
import {mkdtemp,chmod,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {rasterizePng,generateRasterHeader,PNG_RASTER_VERSION} from './png-raster.mjs';
import {MANAGED_ASSET_PATH,createManagedAssetBlock} from './managed-assets.mjs';

const run=promisify(execFile),ID=/^[a-f0-9]{32}$/,PROJECT=/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MAX_INPUT=256*1024,MAX_PNG=1024*1024,VERSION='chat-attachment-raster-v1';
const PNG=Buffer.from('89504e470d0a1a0a','hex');
const MIME=Object.freeze({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export class AttachmentAssetError extends Error{
 constructor(code){super('Не удалось импортировать фото. Проверьте вложение и текущий проект.');this.code=code;this.name='AttachmentAssetError';}
}
const fail=code=>{throw new AttachmentAssetError(code);};
const check=(value,code='ATTACHMENT_INVALID_IMAGE')=>{if(!value)fail(code);};

// Ceiling/magic checks supplement, rather than replace, the trusted attachment
// store's full JPEG/WebP validation. No decoder or filesystem path comes from AI.
function imageSize(bytes,mime){
 if(mime==='image/png'){
  check(bytes.length>=33&&bytes.subarray(0,8).equals(PNG)&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR');
  return[bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
 }
 if(mime==='image/jpeg'){
  check(bytes.length>=20&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217);
  let at=2;
  while(at+4<=bytes.length){
   check(bytes[at++]===255);while(bytes[at]===255)at++;
   const marker=bytes[at++];check(marker!==218&&marker!==217&&at+2<=bytes.length);
   const size=bytes.readUInt16BE(at);check(size>=2&&at+size<=bytes.length);
   if(marker===192||marker===194){check(size>=11&&bytes[at+2]===8&&[1,3].includes(bytes[at+7])&&size===8+bytes[at+7]*3);return[bytes.readUInt16BE(at+5),bytes.readUInt16BE(at+3)];}
   at+=size;
  }
 }else if(mime==='image/webp'){
  check(bytes.length>=26&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.readUInt32LE(4)===bytes.length-8&&bytes.toString('ascii',8,12)==='WEBP');
  for(let at=12;at+8<=bytes.length;){
   const type=bytes.toString('ascii',at,at+4),size=bytes.readUInt32LE(at+4),start=at+8;check(start+size<=bytes.length);
   if(type==='VP8X'){check(size===10);return[bytes.readUIntLE(start+4,3)+1,bytes.readUIntLE(start+7,3)+1];}
   if(type==='VP8 '){check(size>=10&&bytes.subarray(start+3,start+6).equals(Buffer.from([157,1,42])));return[bytes.readUInt16LE(start+6)&16383,bytes.readUInt16LE(start+8)&16383];}
   if(type==='VP8L'){check(size>=5&&bytes[start]===47);const bits=bytes.readUInt32LE(start+1);return[(bits&16383)+1,((bits>>>14)&16383)+1];}
   at=start+size+(size&1);
  }
 }
 fail('ATTACHMENT_INVALID_IMAGE');
}
function inputImage(value,id){
 check(value&&value.id===id&&Object.hasOwn(MIME,value.mimeType)&&Buffer.isBuffer(value.dataBuffer));
 check(value.dataBuffer.length>0&&value.dataBuffer.length<=MAX_INPUT,'ATTACHMENT_LIMIT');
 const dimensions=[value.width,value.height];
 check(dimensions.every(n=>Number.isSafeInteger(n)&&n>0&&n<=2048)&&value.width*value.height<=4*1024*1024,'ATTACHMENT_LIMIT');
 const dataBuffer=Buffer.from(value.dataBuffer),actual=imageSize(dataBuffer,value.mimeType);
 check(actual[0]===value.width&&actual[1]===value.height);
 return{dataBuffer,mimeType:value.mimeType,width:value.width,height:value.height};
}
async function readPng(filename){
 const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await handle.stat();check(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=MAX_PNG,'ATTACHMENT_CONVERSION_FAILED');
  const bytes=Buffer.alloc(before.size+1);let size=0;
  while(size<bytes.length){const read=await handle.read(bytes,size,bytes.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}
  const after=await handle.stat();check(size===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs,'ATTACHMENT_CONVERSION_FAILED');
  return bytes.subarray(0,size);
 }finally{await handle.close();}
}
async function macImageToPng({dataBuffer,mimeType,width,height}){
 if(process.platform!=='darwin')fail('ATTACHMENT_CONVERTER_UNAVAILABLE');
 let temporary;
 try{
  temporary=await mkdtemp(join(tmpdir(),'kibi-attachment-raster-'));await chmod(temporary,0o700);
  const input=join(temporary,'input.'+MIME[mimeType]),output=join(temporary,'raster.png');
  await writeFile(input,dataBuffer,{flag:'wx',mode:0o600});
  // Fixed trusted executable/arguments only. The 296-pixel ceiling bounds image
  // output independently of compressed input size. Stdout/stderr and output reads
  // are capped, the child is killed on timeout, and all owned files are removed.
  const maximum=String(Math.min(296,Math.max(width,height)));
  await run('/usr/bin/sips',['-s','format','png','--resampleHeightWidthMax',maximum,input,'--out',output],{
   timeout:8000,killSignal:'SIGKILL',maxBuffer:16384,windowsHide:true,
   env:{PATH:'/usr/bin:/bin',TMPDIR:temporary,LANG:'C',LC_ALL:'C'},
  });
  return await readPng(output);
 }catch(error){if(error instanceof AttachmentAssetError)throw error;fail('ATTACHMENT_CONVERSION_FAILED');}
 finally{if(temporary)try{await rm(temporary,{recursive:true,force:true});}catch{fail('ATTACHMENT_CLEANUP_FAILED');}}
}

export function createAttachmentAssetService({getProjectContext,resolveAttachment,installAsset,convertImage=macImageToPng}={}){
 check([getProjectContext,resolveAttachment,installAsset,convertImage].every(fn=>typeof fn==='function'),'ATTACHMENT_CONFIG');
 async function context(){
  let value;try{value=await getProjectContext();}catch{fail('ATTACHMENT_PROJECT_CHANGED');}
  check(value&&PROJECT.test(value.id)&&((typeof value.generation==='string'&&value.generation.length>0&&value.generation.length<=128)||Number.isSafeInteger(value.generation)),'ATTACHMENT_SCOPE_INVALID');
  check(value.attachmentAssetImportsAllowed===true,'ATTACHMENT_IMPORT_REVOKED');
  check(Array.isArray(value.attachmentIds)&&value.attachmentIds.length<=32&&value.attachmentIds.every(id=>typeof id==='string'&&ID.test(id))&&new Set(value.attachmentIds).size===value.attachmentIds.length,'ATTACHMENT_SCOPE_INVALID');
  return{id:value.id,generation:value.generation,attachmentIds:[...value.attachmentIds]};
 }
 return Object.freeze({
  async importAttachment(id,{expectedProjectId}={}){
   check(typeof id==='string'&&ID.test(id),'ATTACHMENT_INVALID_ID');
   const expected=await context();check(expected.id===expectedProjectId,'ATTACHMENT_PROJECT_CHANGED');
   const assertProjectCurrent=async()=>{const current=await context();check(current.id===expected.id&&current.generation===expected.generation,'ATTACHMENT_PROJECT_CHANGED');check(current.attachmentIds.includes(id),'ATTACHMENT_NOT_ALLOWED');};
   await assertProjectCurrent(); // Membership is checked before any private read.
   let resolved;try{resolved=await resolveAttachment({id,projectId:expected.id,generation:expected.generation});}catch{await assertProjectCurrent();fail('ATTACHMENT_NOT_FOUND');}
   await assertProjectCurrent();const source=inputImage(resolved,id),sourceSha256=sha(source.dataBuffer);
   let raster;
   try{
    let png=source.dataBuffer;
    if(source.mimeType!=='image/png'){
     png=await convertImage(source);await assertProjectCurrent();
     check(Buffer.isBuffer(png)&&png.length>0&&png.length<=MAX_PNG,'ATTACHMENT_CONVERSION_FAILED');
     const converted=imageSize(png,'image/png');check(converted.every(n=>n>0&&n<=296),'ATTACHMENT_CONVERSION_FAILED');
    }
    raster=rasterizePng(png);
   }catch(error){if(error instanceof AttachmentAssetError)throw error;fail('ATTACHMENT_CONVERSION_FAILED');}
   await assertProjectCurrent();
   const rasterSha256=sha(raster.pixels),identity=sha(Buffer.from(`${VERSION}\0${PNG_RASTER_VERSION}\0${sourceSha256}\0${rasterSha256}\0${raster.width}x${raster.height}`));
   const assetId='public_image_'+identity.slice(0,16),namespace='KibiChatRaster_'+identity.slice(0,16);
   const image={format:'rgb565-alpha8',width:raster.width,height:raster.height,frames:1,pixelBytes:3,alpha:'straight-8bit',sourceMimeType:source.mimeType,sourceWidth:source.width,sourceHeight:source.height,conversion:VERSION};
   const metadata={sourceKind:'attachment',sourceSha256,rasterSha256,image,rasterization:PNG_RASTER_VERSION};
   let files;
   try{const header=generateRasterHeader(raster,namespace);files=[{path:MANAGED_ASSET_PATH,content:createManagedAssetBlock(assetId,header+'\n/* CHAT ATTACHMENT METADATA\n'+JSON.stringify(metadata,null,2)+'\n*/\n')}];}
   catch{fail('ATTACHMENT_LIMIT');}
   await assertProjectCurrent();
   try{await installAsset({expectedProjectId:expected.id,expectedProjectGeneration:expected.generation,mode:'append-only',assetId,files,metadata,assertProjectCurrent});}
   catch(error){if(error instanceof AttachmentAssetError)throw error;await assertProjectCurrent();fail(error?.code==='ASSET_LIMIT'?'ATTACHMENT_LIMIT':'ATTACHMENT_INSTALL_FAILED');}
   await assertProjectCurrent();
   return{ok:true,projectId:expected.id,assetId,paths:[MANAGED_ASSET_PATH],source:{kind:'attachment',id,sha256:sourceSha256},rasterSha256,
    api:{include:MANAGED_ASSET_PATH,namespace,renderable:true,access:'bool ReadPixel(size_t x,size_t y,uint16_t* color,uint8_t* alpha); bool DecodeRow(size_t y,uint16_t* colors,uint8_t* alpha,size_t capacity)',constants:{kWidth:raster.width,kHeight:raster.height},image},
    summary:`Фото подготовлено как статический RGB565/alpha ресурс ${raster.width}×${raster.height}. Используйте ReadPixel/DecodeRow; работа на физической Киби отдельно не проверялась.`};
  },
 });
}
