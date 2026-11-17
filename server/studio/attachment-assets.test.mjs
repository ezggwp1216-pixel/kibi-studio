import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {createAttachmentAssetService} from './attachment-assets.mjs';

const id='a'.repeat(32),other='b'.repeat(32),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// A synthetic 1x1 red JPEG produced by macOS sips from a three-byte BMP pixel.
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z','base64');
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let n=0;n<8;n++)value=value&1?(value>>>1)^0xedb88320:value>>>1;}return(value^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,checksum]);}
function png(){const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);}
function fixture(options={}){
 const current={id:'public-test',generation:1,attachmentIds:[id,other],attachmentAssetImportsAllowed:true};
 const writes=[],reads=[];
 const service=createAttachmentAssetService({getProjectContext:()=>({...current}),resolveAttachment:async input=>{reads.push(input);return{id:input.id,mimeType:'image/png',dataBuffer:png(),width:1,height:1,name:'private-name.jpg',...options.attachment};},installAsset:async input=>{await input.assertProjectCurrent();writes.push(input);return{paths:['embedded_assets.h']};},...options.service});
 return{current,writes,reads,service,run:(selected=id,project='public-test')=>service.importAttachment(selected,{expectedProjectId:project})};
}
const code=expected=>error=>error.code===expected&&!/private|\/Users\/|\/tmp\//.test(error.message);

test('one selected attachment becomes a bounded managed RGB565 resource with compact provenance',async()=>{
 const f=fixture(),result=await f.run();
 assert.deepEqual(f.reads,[{id,projectId:'public-test',generation:1}]);
 assert.equal(result.ok,true);assert.equal(result.projectId,'public-test');
 assert.deepEqual(result.source,{kind:'attachment',id,sha256:hash(png())});
 assert.equal(result.rasterSha256,hash(Buffer.from([0,248,255])));
 assert.equal(result.api.renderable,true);assert.equal(result.api.include,'embedded_assets.h');
 assert.deepEqual(result.api.constants,{kWidth:1,kHeight:1});
 assert.match(result.api.access,/ReadPixel/);assert.match(result.api.access,/DecodeRow/);
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].mode,'append-only');
 assert.equal(f.writes[0].expectedProjectGeneration,1);
 assert.equal(f.writes[0].files[0].path,'embedded_assets.h');
 assert.match(f.writes[0].files[0].content,/KIBI_ASSET_BEGIN public_image_[a-f0-9]{16}/);
 assert.doesNotMatch(JSON.stringify(result),/private-name|#pragma|dataBuffer|base64|\/api\/attachments|\/tmp\//);
});

test('invalid, unknown and cross-project IDs are rejected before the private resolver',async()=>{
 const f=fixture();
 for(const invalid of ['../private','https://example.org/photo.png',id.toUpperCase(),'', 'c'.repeat(32)])await assert.rejects(f.run(invalid),error=>/^ATTACHMENT_/.test(error.code));
 await assert.rejects(f.run(id,'another-project'),code('ATTACHMENT_PROJECT_CHANGED'));
 assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
 f.current.attachmentAssetImportsAllowed=false;await assert.rejects(f.run(),code('ATTACHMENT_IMPORT_REVOKED'));
});

test('source bytes and MIME/dimension ceilings are checked before conversion or installation',async()=>{
 for(const attachment of [
  {dataBuffer:Buffer.alloc(256*1024+1)},
  {mimeType:'image/svg+xml',dataBuffer:Buffer.from('<svg/>')},
  {mimeType:'image/jpeg'},
  {width:2049},
  {height:2049},
  {id:other},
  {dataBuffer:Buffer.from('not an image')},
  {width:2},
 ]){
  const f=fixture({attachment,service:{convertImage:async()=>{throw Error('converter must not run');}}});
  await assert.rejects(f.run(),error=>/^ATTACHMENT_/.test(error.code));assert.equal(f.writes.length,0);
 }
});

test('the exact source and raster hashes give idempotent blocks across duplicate attachments',async()=>{
 const f=fixture(),first=await f.run(),second=await f.run(other);
 assert.equal(first.assetId,second.assetId);assert.equal(first.api.namespace,second.api.namespace);
 assert.deepEqual(f.writes[0].files,f.writes[1].files);
 assert.notEqual(first.source.id,second.source.id);
});

test('project, permission and turn membership are rechecked after trusted conversion',async()=>{
 for(const change of [f=>f.current.generation++,f=>f.current.attachmentAssetImportsAllowed=false,f=>f.current.attachmentIds=[]]){
  let f;
  f=fixture({attachment:{mimeType:'image/jpeg',dataBuffer:jpeg},service:{convertImage:async input=>{assert.equal(input.mimeType,'image/jpeg');assert.deepEqual(input.dataBuffer,jpeg);change(f);return png();}}});
  await assert.rejects(f.run(),error=>/^ATTACHMENT_/.test(error.code));assert.equal(f.writes.length,0);
 }
});

test('the installer receives a live project guard and never commits a stale or cancelled result',async()=>{
 let f,committed=false;
 f=fixture({service:{installAsset:async input=>{f.current.generation++;await input.assertProjectCurrent();committed=true;}}});
 await assert.rejects(f.run(),code('ATTACHMENT_PROJECT_CHANGED'));assert.equal(committed,false);
 const cancelled=fixture({service:{getProjectContext:()=>{throw Error('private cancelled turn internals');}}});
 await assert.rejects(cancelled.run(),code('ATTACHMENT_PROJECT_CHANGED'));
});

test('malformed or failed converter output and resolver/install exceptions remain fixed attachment errors',async()=>{
 for(const convertImage of [async()=>Buffer.from('not png'),async()=>Buffer.alloc(1024*1024+1),async()=>{throw Error('/tmp/private JPEG details');}]){
  const f=fixture({attachment:{mimeType:'image/jpeg',dataBuffer:jpeg},service:{convertImage}});
  await assert.rejects(f.run(),error=>/^ATTACHMENT_/.test(error.code)&&!error.message.includes('private'));assert.equal(f.writes.length,0);
 }
 await assert.rejects(fixture({service:{resolveAttachment:async()=>{throw Error('/tmp/private source');}}}).run(),code('ATTACHMENT_NOT_FOUND'));
 await assert.rejects(fixture({service:{installAsset:async()=>{throw Error('/tmp/private source');}}}).run(),code('ATTACHMENT_INSTALL_FAILED'));
});

test('macOS sips converts an already stored synthetic JPEG to the portable raster without a public URL',{skip:process.platform!=='darwin'},async()=>{
 const f=fixture({attachment:{mimeType:'image/jpeg',dataBuffer:jpeg}}),result=await f.run();
 assert.equal(result.ok,true);assert.deepEqual(result.source,{kind:'attachment',id,sha256:hash(jpeg)});
 assert.equal(result.api.renderable,true);assert.deepEqual(result.api.constants,{kWidth:1,kHeight:1});
 assert.match(result.rasterSha256,/^[a-f0-9]{64}$/);assert.equal(f.writes.length,1);
});

test('the real macOS converter removes its private temporary files after success and decode failure',{skip:process.platform!=='darwin'},async t=>{
 const parent=await mkdtemp('/private/tmp/kibi-attachment-cleanup-test-'),previous=process.env.TMPDIR;
 t.after(()=>rm(parent,{recursive:true,force:true}));process.env.TMPDIR=parent;
 try{
  await fixture({attachment:{mimeType:'image/jpeg',dataBuffer:jpeg}}).run();assert.deepEqual(await readdir(parent),[]);
  const noScan=Buffer.concat([jpeg.subarray(0,jpeg.indexOf(Buffer.from([255,218]))),Buffer.from([255,217])]);
  await assert.rejects(fixture({attachment:{mimeType:'image/jpeg',dataBuffer:noScan}}).run(),error=>/^ATTACHMENT_/.test(error.code));
  assert.deepEqual(await readdir(parent),[]);
 }finally{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;}
});
