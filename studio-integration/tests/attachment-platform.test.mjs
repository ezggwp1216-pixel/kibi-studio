import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';

const ID='a'.repeat(32),OTHER='b'.repeat(32);
function chunk(type,bytes){const tag=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(bytes.length);let c=0xffffffff;for(const x of Buffer.concat([tag,bytes])){c^=x;for(let i=0;i<8;i++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}sum.writeUInt32BE((c^0xffffffff)>>>0);return Buffer.concat([size,tag,bytes,sum]);}
function png(){const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);}
async function fixture(t,{stale=false}={}){
 const root=await mkdtemp(join(tmpdir(),'kibi-photo-platform-')),src=join(root,'src');await mkdir(src);
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const n of ['studio-platform.mjs','studio-account.mjs','studio-plugins.mjs'])await copyFile(new URL('../src/'+n,import.meta.url),join(src,n));
 for(const n of ['attachment-assets.mjs','png-raster.mjs','managed-assets.mjs'])await copyFile(new URL('../../server/studio/'+n,import.meta.url),join(src,n)).catch(e=>{if(e.code!=='ENOENT')throw e;});
 await writeFile(join(src,'public-resources.mjs'),"export class PublicResourceError extends Error{};export const SDK_HEADERS={};export const PUBLIC_ASSET_RECIPES=[];export const createPublicResourceService=()=>({importPublicAsset(){throw Error('URL path must not handle an attachment');}});");
 await writeFile(join(src,'device-modules.mjs'),"export const createDeviceModuleService=()=>({status:async()=>({modules:[]})});");
 await writeFile(join(src,'portable-design-upgrade.mjs'),"export const PORTABLE_DESIGN_INSTRUCTIONS='';");
 const {createStudioPlatform,platformTools}=await import(pathToFileURL(join(src,'studio-platform.mjs')));
 const bytes=png(),sha256=createHash('sha256').update(bytes).digest('hex');
 const descriptors=[{id:ID,index:1,mime:'image/png',width:1,height:1,sha256}];let epoch=1,reads=0;const installed=[];
 const store={projectId:'photo-fixture',installPublicAssets:async input=>{installed.push(input);return{files:[{path:'embedded_assets.h'}]};}};
 const platform=await createStudioPlatform({root,getStore:()=>store,getEpoch:()=>epoch,getAttachmentDescriptors:async()=>descriptors,resolveAttachment:async({id,projectId,generation})=>{reads++;assert.equal(projectId,store.projectId);assert.equal(generation,epoch);assert.equal(id,ID);return{id,mimeType:'image/png',dataBuffer:bytes,width:1,height:1};},mutate:async action=>{if(stale)epoch++;return action();}});
 t.after(()=>platform.close());return{platform,platformTools,descriptors,installed,reads:()=>reads};
}
test('project context provides sent-photo IDs so an image can become an application asset',async t=>{
 const f=await fixture(t);const info=await f.platform.context();assert.deepEqual(info.platform.chatAttachments,f.descriptors);
 const tool=f.platformTools.find(x=>x.name==='kibi_import_asset');assert.ok(tool.inputSchema.properties.attachmentId);
});
test('a sent photo imports through the local asset bank without a public URL',async t=>{
 const f=await fixture(t);const result=await f.platform.tool('kibi_import_asset',{attachmentId:ID});
 assert.equal(result.result.ok,true);assert.equal(f.reads(),1);assert.equal(f.installed.length,1);
 assert.equal(f.installed[0].files[0].path,'embedded_assets.h');assert.match(f.installed[0].files[0].content,/KIBI_ASSET_BEGIN/);
 assert.equal(result.result.source.kind,'attachment');assert.equal(result.result.source.id,ID);assert.equal(result.result.api.constants.kWidth,1);
 assert.equal(JSON.stringify(result).includes('kPixelsBase64'),false);
});
test('unknown or mixed-source photo IDs never resolve a private file',async t=>{
 const f=await fixture(t);
 for(const args of [{attachmentId:OTHER},{attachmentId:ID,url:'https://example.test/photo.png'}]){
  const r=await f.platform.tool('kibi_import_asset',args);assert.equal(r.result.ok,false);assert.match(r.result.code,/^ATTACHMENT_/);
 }
 assert.equal(f.reads(),0);assert.equal(f.installed.length,0);
});
test('changing project before commit prevents the photo from being installed',async t=>{
 const f=await fixture(t,{stale:true});await assert.rejects(()=>f.platform.tool('kibi_import_asset',{attachmentId:ID}),e=>e.status===409);assert.equal(f.installed.length,0);
});
