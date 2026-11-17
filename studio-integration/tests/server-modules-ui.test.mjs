import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const playwrightModule=process.env.KIBI_STUDIO_PLAYWRIGHT_MODULE;
const playwright=await import(playwrightModule?pathToFileURL(playwrightModule).href:'playwright');
const {chromium}=playwright.default||playwright;
const source=await readFile(new URL('../web/server-modules.js',import.meta.url),'utf8');
async function fixture(t){
  const browser=await chromium.launch({headless:true,...(process.env.KIBI_STUDIO_BROWSER_EXECUTABLE?{executablePath:process.env.KIBI_STUDIO_BROWSER_EXECUTABLE}:{})});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://127.0.0.1:49150')return route.abort();
    return route.fulfill({contentType:url.pathname==='/server-modules.js'?'application/javascript':'text/html',body:url.pathname==='/server-modules.js'?source:'<!doctype html><header></header>'});
  });
  await page.goto('http://127.0.0.1:49150/');
  await page.evaluate(async()=>{
    const {initServerModulesUI}=await import('/server-modules.js');
    const id='live-frame',device='33333333-3333-4333-8333-333333333333';
    let binding={pluginId:id,version:'1.0.0',revision:1,enabled:true,settings:{fit:'contain'},updatedAt:'2026-11-17T00:00:00.000Z'};
    const history=new Map([[1,structuredClone(binding)]]);window.requests=[];
    const api=async(path,options)=>{
      if(!options){
        if(path==='/api/account')return {connected:true,scopes:['plugins.read','plugins.bind'],account:{email:'fixture@example.test'}};
        if(path==='/api/account/plugins')return {supported:true,plugins:['1.0.0','2.0.0'].map(version=>({id,version,name:'Трансляция',sha256:'a'.repeat(64),createdAt:'2026-11-17T00:00:00.000Z'})),capabilities:{protocol:1,publish:false,bind:true,rollback:true,runtime:{configured:false,available:false},media:{configured:false,available:false}}};
        if(path==='/api/account/devices')return {devices:[{id:device,name:'Тестовый Киби',status:'offline'}]};
        if(path===`/api/account/devices/${device}/plugins`)return {bindings:[structuredClone(binding)]};
        throw new Error('Unexpected read');
      }
      if(options.method!=='POST'||!path.startsWith(`/api/account/devices/${device}/plugins/${id}`))throw new Error('Unexpected mutation');
      window.requests.push({path,body:structuredClone(options.body)});
      if(options.body.expectedRevision!==binding.revision)throw new Error('Wrong revision');
      binding=path.endsWith('/rollback')?{...structuredClone(history.get(options.body.toRevision)),revision:binding.revision+1}:{pluginId:id,...structuredClone(options.body),revision:binding.revision+1};
      history.set(binding.revision,structuredClone(binding));return {binding:structuredClone(binding)};
    };
    window.ui=initServerModulesUI({api,mount:document.querySelector('header')});window.ui.open();
  });
  await page.waitForFunction(()=>document.querySelector('[data-part="current"]').textContent.includes('ревизия 1'));
  return page;
}
async function save(page,revision){
  await page.locator('[data-form="binding"] button[type="submit"]').click();
  await page.waitForFunction(revision=>document.querySelector('[data-part="current"]').textContent.includes(`ревизия ${revision}`),revision);
}
async function rollbackV1(page){
  await page.locator('[name="module"]').selectOption('live-frame@2.0.0');await save(page,2);
  await page.locator('[name="enabled"]').uncheck();await save(page,3);
  await page.locator('[name="toRevision"]').fill('1');await page.locator('[data-form="rollback"] button').click();
  await page.waitForFunction(()=>document.querySelector('[data-part="current"]').textContent==='Текущая версия 1.0.0 · ревизия 4');
}
test('disabling after rollback preserves the restored version and uses its new revision',async t=>{
  const page=await fixture(t);await rollbackV1(page);
  assert.equal(await page.locator('[name="module"]').inputValue(),'live-frame@1.0.0');
  assert.equal(await page.locator('[name="enabled"]').isChecked(),true);
  await page.locator('[name="enabled"]').uncheck();await save(page,5);
  assert.deepEqual(await page.evaluate(()=>window.requests.at(-1).body),{version:'1.0.0',expectedRevision:4,enabled:false,settings:{fit:'contain'}});
});
test('an explicit version choice after rollback still upgrades the binding',async t=>{
  const page=await fixture(t);await rollbackV1(page);
  await page.locator('[name="module"]').selectOption('live-frame@2.0.0');await save(page,5);
  assert.deepEqual(await page.evaluate(()=>window.requests.at(-1).body),{version:'2.0.0',expectedRevision:4,enabled:true,settings:{fit:'contain'}});
});
