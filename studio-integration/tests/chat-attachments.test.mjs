import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,rm,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {decodeReleaseZip} from '../../server/studio/full-release.mjs';

const overlay=fileURLToPath(new URL('../',import.meta.url));
const base=process.env.KIBI_STUDIO_PUBLIC_RELEASE||fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const stateMarker='\n\nCURRENT KIBI STATE:\n',photoMarker='\n\nCURRENT USER PHOTO ATTACHMENTS:\n';
const parseState=input=>JSON.parse(input.developerInstructions.split(stateMarker)[1].split(photoMarker)[0]);
const parseCurrentPhotos=input=>input.developerInstructions.includes(photoMarker)?JSON.parse(input.developerInstructions.split(photoMarker)[1]):[];
const status={available:true,ready:true,authenticated:true,busy:false};

async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'kibi-chat-attachments-')));let server;t.after(async()=>{if(server)await server.studio.shutdown();await rm(root,{recursive:true,force:true});});
 const files=decodeReleaseZip({archive:await readFile(join(base,'kibi-studio-local.zip')),manifest:JSON.parse(await readFile(join(base,'kibi-studio-local.manifest.json'),'utf8')),release:JSON.parse(await readFile(join(base,'release.json'),'utf8'))});
 for(const[name,bytes]of files){const target=join(root,name);await mkdir(join(target,'..'),{recursive:true});await writeFile(target,bytes,{flag:'wx'});}
 for(const directory of ['src','web'])for(const name of await readdir(join(overlay,directory)))if(/\.(mjs|js|html|css)$/.test(name))await copyFile(join(overlay,directory,name),join(root,directory,name));
 // Observe only the public constructor boundary, retaining the real platform.
 const key='attachment-options-'+randomUUID();await copyFile(join(root,'src/studio-platform.mjs'),join(root,'src/studio-platform-real.mjs'));
 await writeFile(join(root,'src/studio-platform.mjs'),`export * from './studio-platform-real.mjs';\nimport {createStudioPlatform as createReal} from './studio-platform-real.mjs';\nexport async function createStudioPlatform(options){globalThis[${JSON.stringify(key)}]=options;return createReal(options);}\n`);
 t.after(()=>{delete globalThis[key];});
 const {createStudioServer}=await import(pathToFileURL(join(root,'src/server.mjs'))),{rgbPng}=await import(pathToFileURL(join(root,'src/png.mjs')));
 const turns=[];let hook;
 const bridge={getStatus:()=>({...status}),start:async()=>({...status}),close:async()=>{},interrupt:async()=>{},send:async input=>{const context=await hook({tool:'kibi_project_context',arguments:{},projectId:input.projectId});turns.push({input,context});return {threadId:'synthetic-thread',turnId:'synthetic-turn-'+turns.length};}};
 server=await createStudioServer({root,mode:'local',bridgeFactory:options=>{hook=options.onToolCall;return bridge;},preview:{render:async()=>({rgb:Buffer.alloc(213120),width:240,height:296,sourceHash:(await server.studio.store.getState()).sourceHash,diagnostics:{}}),check:async()=>{throw Error('No compiler in attachment tests');}},builder:{environment:async()=>({ready:false,issues:['Synthetic compiler disabled']}),start:async()=>{throw Error('No builds in attachment tests');}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await server.studio.initialize();const origin='http://127.0.0.1:'+server.address().port;
 const callbacks=globalThis[key];
 async function api(route,body){const state=await server.studio.state(),response=await fetch(origin+route,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{'Content-Type':'application/json',Origin:origin,'X-Studio-Token':state.csrfToken,'X-Studio-Project':state.project.id}}),data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
 const scope=async()=>{const state=await server.studio.state();return{projectId:state.project.id,generation:state.projectEpoch};};
 const png=(color=1)=>{const rgb=Buffer.alloc(213120);for(let i=0;i<rgb.length;i+=3){rgb[i]=color;rgb[i+1]=(color*3)%256;rgb[i+2]=(color*7)%256;}return rgbPng(rgb);};
 const upload=async(color=1)=>api('/api/attachments',{name:'synthetic.png',mime:'image/png',dataBase64:png(color).toString('base64')});
 const tool=(name,args={})=>hook({tool:name,arguments:args,projectId:server.studio.store.projectId});
 const context=()=>tool('kibi_project_context');
 return{root,server,origin,callbacks,turns,api,scope,png,upload,context,tool};
}
function requireCallbacks(f){assert.equal(typeof f.callbacks.getAttachmentDescriptors,'function');assert.equal(typeof f.callbacks.resolveAttachment,'function');}
async function browserPage(t,f){
 const mod=await import(process.env.KIBI_STUDIO_PLAYWRIGHT_MODULE?pathToFileURL(process.env.KIBI_STUDIO_PLAYWRIGHT_MODULE).href:'playwright'),{chromium}=mod.default||mod;
 const browser=await chromium.launch({headless:true,...(process.env.KIBI_STUDIO_BROWSER_EXECUTABLE?{executablePath:process.env.KIBI_STUDIO_BROWSER_EXECUTABLE}:{})});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',route=>new URL(route.request().url()).origin===f.origin?route.continue():route.abort());await page.goto(f.origin);await page.waitForFunction(()=>window.studio?.getState()?.chat?.ready===true&&Boolean(window.studio?.attachments));return page;
}
async function choose(page,f,colors){await page.locator('#chat-photos').setInputFiles(colors.map((color,i)=>({name:'private-name-'+color+'.png',mimeType:'image/png',buffer:f.png(color)})));await page.waitForFunction(count=>{const s=window.studio.attachments.snapshot();return s.ids.length===count&&!s.blocked;},colors.length);return page.evaluate(()=>window.studio.attachments.snapshot().ids);}
async function send(page,text){await page.locator('#chat-input').fill(text);const response=page.waitForResponse(r=>r.url().endsWith('/api/chat')&&r.request().method()==='POST');await page.locator('#send-message').click();assert.equal((await response).status(),202);await page.waitForFunction(()=>!window.studio.getState().chat.busy);}
const attachmentError=code=>error=>error.code===code;
async function boundedImport(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Attachment import exceeded 10s; check recursive project-store transactions')),10000);})]);}finally{clearTimeout(timer);}}

test('real photo composer sends JPEG vision and exposes only sent photos with exact current-turn ordering',async t=>{
 const f=await fixture(t);requireCallbacks(f);const page=await browserPage(t,f);
 const [removed]=await choose(page,f,[2]);await page.locator('.attachment-remove').click();assert.deepEqual(await f.callbacks.getAttachmentDescriptors(await f.scope()),[]);
 await assert.rejects(f.callbacks.resolveAttachment({...await f.scope(),id:removed}),attachmentError('attachment_not_found'));
 const [previous]=await choose(page,f,[10]);await send(page,'Предыдущее фото');assert.equal(f.turns.length,1);
 const current=await choose(page,f,[90,180]);const before=await f.callbacks.getAttachmentDescriptors(await f.scope());assert.deepEqual(before.map(x=>x.id),[previous]);
 await assert.rejects(f.callbacks.resolveAttachment({...await f.scope(),id:current[0]}),attachmentError('attachment_not_found'));
 const unsentImport=await f.tool('kibi_import_asset',{attachmentId:current[0]});assert.equal(unsentImport.ok,false);assert.equal(unsentImport.code,'ATTACHMENT_NOT_ALLOWED');
 await send(page,'Используй эти два фото');assert.equal(f.turns.length,2);const {input,context}=f.turns[1],currentPhotos=parseCurrentPhotos(input),catalog=parseState(input).platform.chatAttachments;
 assert.equal(input.text,'Используй эти два фото');assert.equal(input.images.length,2);assert.deepEqual(catalog.map(x=>x.id),[previous,...current]);assert.deepEqual(context.platform.chatAttachments,catalog);
 assert.deepEqual(currentPhotos.map(x=>[x.index,x.id]),[[1,current[0]],[2,current[1]]]);
 for(const[i,photo]of currentPhotos.entries()){assert.match(input.images[i],/^data:image\/jpeg;base64,/);assert.equal(photo.mime,'image/jpeg');assert.equal(photo.sha256,sha(Buffer.from(input.images[i].split(',')[1],'base64')));assert.equal(photo.width,240);assert.equal(photo.height,296);assert.deepEqual(Object.keys(photo).sort(),['height','id','index','mime','sha256','width']);}
 assert.equal(input.developerInstructions.includes('private-name-'),false);assert.equal(catalog.some(x=>x.id===removed),false);
 const resolved=await f.callbacks.resolveAttachment({...await f.scope(),id:current[0]});assert.equal(resolved.id,current[0]);assert.equal(resolved.mimeType,'image/jpeg');assert.ok(Buffer.isBuffer(resolved.dataBuffer));assert.equal(sha(resolved.dataBuffer),currentPhotos[0].sha256);assert.equal(resolved.width,240);assert.equal(resolved.height,296);
 const imported=await boundedImport(f.tool('kibi_import_asset',{attachmentId:current[0]}));assert.equal(imported.ok,true,JSON.stringify(imported));assert.equal(imported.source.kind,'attachment');assert.equal(imported.source.id,current[0]);assert.equal(imported.source.sha256,currentPhotos[0].sha256);assert.equal(imported.api.renderable,true);assert.ok((await f.server.studio.store.getState()).files.some(file=>file.path===imported.api.include));
 for(const privateValue of ['private-name-','data:image/','/api/attachments/','.studio'])assert.equal(JSON.stringify(imported).includes(privateValue),false);
 await send(page,'Теперь только текст');assert.equal(f.turns.length,3);assert.equal(f.turns[2].input.images,undefined);assert.equal(f.turns[2].input.developerInstructions.includes(photoMarker),false);assert.equal(parseState(f.turns[2].input).platform.chatAttachments.length,3);
});

test('the descriptor window is bounded, excludes assistant-only photos and cannot resolve older unseen IDs',async t=>{
 const f=await fixture(t);requireCallbacks(f);const assistantOnly=await f.upload(1);await f.server.studio.store.addMessage({role:'assistant',text:'Synthetic assistant metadata',attachments:[assistantOnly]});assert.deepEqual(await f.callbacks.getAttachmentDescriptors(await f.scope()),[]);await assert.rejects(f.callbacks.resolveAttachment({...await f.scope(),id:assistantOnly.id}),attachmentError('attachment_not_found'));
 const ids=[];for(let batch=0;batch<9;batch++){const uploads=[];for(let i=0;i<4;i++)uploads.push(await f.upload(batch*4+i+2));const batchIds=uploads.map(x=>x.id);ids.push(...batchIds);await f.api('/api/chat',{text:'Synthetic sent batch',attachments:batchIds});}
 const descriptors=await f.callbacks.getAttachmentDescriptors(await f.scope());assert.equal(descriptors.length,32);assert.deepEqual(descriptors.map(x=>x.id),ids.slice(-32));assert.deepEqual(descriptors.map(x=>x.index),Array.from({length:32},(_,i)=>i+1));assert.equal(JSON.stringify(descriptors).includes('synthetic.png'),false);
 await assert.rejects(f.callbacks.resolveAttachment({...await f.scope(),id:ids[0]}),attachmentError('attachment_not_found'));assert.ok(Buffer.isBuffer((await f.callbacks.resolveAttachment({...await f.scope(),id:ids.at(-1)})).dataBuffer));
});

test('attachment callbacks reject stale project generations before and after asynchronous state reads',async t=>{
 const f=await fixture(t);requireCallbacks(f);const photo=await f.upload(5);await f.api('/api/chat',{text:'Synthetic sent photo',attachments:[photo.id]});const oldScope=await f.scope();
 await assert.rejects(f.callbacks.resolveAttachment({...oldScope,generation:99,id:photo.id}),attachmentError('attachment_project_changed'));
 await assert.rejects(f.callbacks.getAttachmentDescriptors({...oldScope,projectId:'foreign-project'}),attachmentError('attachment_project_changed'));
 const oldStore=f.server.studio.store,original=oldStore.getState;let entered,release;const entering=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});oldStore.getState=async()=>{entered();await gate;return original();};const pending=f.callbacks.getAttachmentDescriptors(oldScope);await entering;oldStore.getState=original;
 await f.api('/api/projects',{name:'Synthetic second project'});release();await assert.rejects(pending,attachmentError('attachment_project_changed'));
 const newScope=await f.scope();assert.notEqual(newScope.projectId,oldScope.projectId);await assert.rejects(f.callbacks.resolveAttachment({...oldScope,id:photo.id}),attachmentError('attachment_project_changed'));await assert.rejects(f.callbacks.resolveAttachment({...newScope,id:photo.id}),attachmentError('attachment_not_found'));assert.deepEqual(await f.callbacks.getAttachmentDescriptors(newScope),[]);
});
