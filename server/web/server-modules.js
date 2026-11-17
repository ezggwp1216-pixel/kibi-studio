let moduleUISequence = 0;

export const workerAvailabilityLabel=value=>value.available?'Доступен':value.configured?'Доступность не подтверждена':'Не настроен';

export const YOUTUBE_EXAMPLE = {
  format: 'kibi-plugin', manifestVersion: 2, sdkVersion: '1.1',
  id: 'youtube-live', version: '0.1.0', name: 'YouTube · прямой эфир',
  description: 'Один кадр прямого эфира для экрана Киби 240 × 296. Без звука.',
  capabilities: ['request-handler'], permissions: ['media:youtube-frame'],
  settings: [
    {key:'videoId',label:'YouTube video ID',type:'text',required:true,default:'4t4AQ15yj1M'},
    {key:'fit',label:'Вписывание кадра',type:'text',required:true,default:'contain'},
  ],
  secrets: [],
  server: {language:'javascript',source:"export async function onDeviceRequest(input, context) {\n  return { youtubeFrame: { videoId: context.settings.videoId, fit: context.settings.fit || 'contain' } };\n}"},
};

const messages = {
  account_not_connected: 'Сначала подключите Studio в окне «Аккаунт». Для модулей создайте ключ с разрешением «Серверные модули».',
  account_plugin_scope_required: 'У подключения нет разрешения на модули. В личном кабинете создайте новый ключ с разрешением «Серверные модули» и подключите его в окне «Аккаунт».',
  account_plugins_unsupported: 'Этот сервер пока не поддерживает публикацию модулей из Studio. Обновите сервер и повторите проверку.',
  account_expired: 'Подключение истекло. Создайте новый ключ в кабинете и подключите Studio в окне «Аккаунт».',
  account_revoked: 'Подключение отозвано. Подключите Studio заново в окне «Аккаунт».',
  account_session_changed: 'Подключение изменилось. Обновите список перед следующим действием.',
  account_plugin_conflict: 'Версия или привязка уже изменились. Обновите список, проверьте ревизию и повторите действие.',
  account_plugin_not_found: 'Модуль или устройство не найдены в вашем аккаунте. Обновите список.',
  account_plugin_invalid_package: 'Пакет не прошёл проверку. Проверьте формат, версию и исходник модуля.',
  account_plugin_invalid_settings: 'Укажите JSON-объект настроек: до 16 полей со строками, числами или true/false. Поля должны соответствовать модулю.',
  account_invalid_input: 'Проверьте пакет, выбранную версию и ревизию привязки.',
  account_invalid_response: 'Не удалось проверить ответ сервера. Обновите список перед повтором действия.',
  account_network_error: 'Нет соединения с сервером. Проверьте сеть и обновите список.',
  account_timeout: 'Сервер не ответил вовремя. Обновите список: действие могло завершиться на сервере.',
  account_busy: 'Дождитесь завершения текущей операции.',
  account_plugin_runtime_unavailable: 'Изолированный исполнитель недоступен. Пакет можно подготовить, запуск потребует настройки сервера.',
  account_plugin_media_unavailable: 'Видеообработчик недоступен. Для кадров YouTube его нужно подключить на сервере.',
  account_plugin_unavailable: 'Сервис модулей временно недоступен. Обновите список позже.',
  package_too_large: 'Пакет должен занимать не более 128 КиБ в UTF-8.',
  package_invalid_json: 'Пакет должен быть JSON-объектом. Исправьте текст и повторите публикацию.',
  browser_sha_unavailable: 'Браузер не может вычислить SHA-256. Откройте Studio через localhost или HTTPS.',
};
const disconnectedCodes = new Set(['account_not_connected','account_expired','account_revoked','account_session_changed']);
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const errorCode = error => [error?.code,error?.details?.code,error?.details?.error?.code].find(code=>typeof code==='string'&&own(messages,code));
const object = value => value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid = code => Object.assign(new Error('module_ui_validation'),{code});
const scopes = info => Array.isArray(info?.scopes)?info.scopes:[];
const stateLabel = device => ({online:'В сети',offline:'Не в сети',not_seen:'Ещё не подключался'}[device.status]||'Статус неизвестен');

// The local api helper owns CSRF and never exposes the server bearer to this UI.
export function initServerModulesUI({api=globalThis.window?.studio?.api,mount=document.querySelector('.header-utilities')||document.querySelector('header')}={}) {
  if(typeof api!=='function')throw new Error('Studio module API is unavailable');
  if(typeof mount==='string')mount=document.querySelector(mount);
  if(!mount?.append)throw new Error('Studio module mount is unavailable');
  const prefix=`server-modules-${++moduleUISequence}`;
  const button=document.createElement('button');button.type='button';button.className='ksm-launch';button.textContent='Серверные модули';button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls',`${prefix}-dialog`);
  const dialog=document.createElement('dialog');dialog.id=`${prefix}-dialog`;dialog.className='ksm-dialog';dialog.setAttribute('aria-labelledby',`${prefix}-title`);dialog.setAttribute('aria-describedby',`${prefix}-intro`);
  dialog.innerHTML=`
    <div class="ksm-heading"><div><p class="ksm-eyebrow">Киби Studio / сервер</p><h2 id="${prefix}-title">Серверные модули</h2><p id="${prefix}-intro" class="ksm-intro">Подготовьте обработчик, опубликуйте версию и назначьте своей Киби.</p></div><button type="button" data-action="close" class="ksm-close" aria-label="Закрыть серверные модули" autofocus>×</button></div>
    <div class="ksm-body">
      <div class="ksm-status-heading"><p data-part="connection">Проверяем подключение…</p><button type="button" data-action="refresh" class="ksm-secondary">Обновить</button></div>
      <p class="ksm-feedback" data-part="feedback" role="status" aria-live="polite" tabindex="-1"></p>
      <div class="ksm-availability" data-part="availability" hidden><div><span>Изолированный исполнитель</span><strong data-part="runtime"></strong></div><div><span>Видео YouTube</span><strong data-part="media"></strong></div></div>
      <p class="ksm-help ksm-runtime-note" data-part="runtime-note" hidden></p>
      <div class="ksm-workspace" data-part="workspace" hidden>
        <section class="ksm-library" aria-labelledby="${prefix}-library"><div class="ksm-section-heading"><h3 id="${prefix}-library">Версии модулей</h3><span data-part="package-count"></span></div><ul class="ksm-packages" data-part="packages"></ul><p class="ksm-empty" data-part="packages-empty">Пока нет опубликованных версий. Загрузите пакет или начните с примера YouTube.</p>
          <details class="ksm-publish" open><summary>Опубликовать новую версию</summary><form data-form="publish" class="ksm-form"><div class="ksm-toolbar"><label class="ksm-file-label" for="${prefix}-file">Загрузить .kibiplugin<input id="${prefix}-file" type="file" accept=".kibiplugin,application/json" data-part="file"></label><button type="button" class="ksm-secondary" data-action="example">Пример YouTube</button></div><label for="${prefix}-package">Текст пакета</label><textarea id="${prefix}-package" name="packageText" rows="12" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder='{"format":"kibi-plugin", …}' maxlength="131072" required aria-describedby="${prefix}-package-help"></textarea><p class="ksm-help" id="${prefix}-package-help">Публичный JSON до 128 КиБ. Ключи и пароли вводите только в предназначенных настройках сервиса.</p><div class="ksm-publish-footer"><button type="submit" class="ksm-primary">Опубликовать версию</button><span class="ksm-help" data-part="package-size">0 байт</span></div><p class="ksm-help ksm-digest" data-part="digest"></p></form></details>
        </section>
        <section class="ksm-assignment" aria-labelledby="${prefix}-assignment"><h3 id="${prefix}-assignment">Назначить своей Киби</h3><p class="ksm-help">Устройство остаётся привязанным к вашему аккаунту. Каждое изменение создаёт новую ревизию.</p><label class="ksm-label" for="${prefix}-device">Ваш Киби</label><select id="${prefix}-device" data-part="device"><option value="">Выберите устройство</option></select><p class="ksm-empty" data-part="devices-empty" hidden>Устройств пока нет. Привяжите Киби по коду в окне «Аккаунт».</p><ul class="ksm-bindings" data-part="bindings" aria-label="Текущие привязки"></ul><p class="ksm-help" data-part="bindings-empty" hidden>У этого устройства пока нет серверных модулей.</p>
          <form data-form="binding" class="ksm-form"><label for="${prefix}-module">Модуль и версия</label><select id="${prefix}-module" name="module" required></select><p class="ksm-current" data-part="current">Новая привязка · ревизия 0</p><label for="${prefix}-settings">Настройки модуля · JSON</label><textarea id="${prefix}-settings" name="settings" rows="5" spellcheck="false" autocapitalize="off" autocomplete="off" required>{}</textarea><label class="ksm-check"><input type="checkbox" name="enabled" checked><span>Модуль включён для этого устройства</span></label><button type="submit" class="ksm-primary">Сохранить привязку</button><p class="ksm-help">Сохранение привязки не запускает обработчик. Его вызывает приложение на Киби.</p></form>
          <form data-form="rollback" class="ksm-rollback"><label for="${prefix}-revision">Вернуть предыдущую ревизию привязки</label><div class="ksm-rollback-row"><input id="${prefix}-revision" name="toRevision" type="number" min="1" step="1" inputmode="numeric" required aria-describedby="${prefix}-rollback-help"><button type="submit" class="ksm-secondary">Восстановить</button></div><p class="ksm-help" id="${prefix}-rollback-help">Восстановятся версия, настройки и состояние выбранной ревизии.</p></form>
        </section>
      </div>
    </div>`;
  mount.append(button);document.body.append(dialog);
  const part=name=>dialog.querySelector(`[data-part="${name}"]`),form=name=>dialog.querySelector(`[data-form="${name}"]`);
  const packageField=form('publish').elements.namedItem('packageText'),moduleField=form('binding').elements.namedItem('module'),settingsField=form('binding').elements.namedItem('settings'),enabledField=form('binding').elements.namedItem('enabled'),revisionField=form('rollback').elements.namedItem('toRevision');
  let info=null,catalog=null,devices=[],bindings=[],device='',busy=false,bindingBusy=false,destroyed=false,generation=0,bindingSequence=0,lastFocus=null;
  const listeners=[];
  const on=(node,type,handler)=>{node.addEventListener(type,handler);listeners.push(()=>node.removeEventListener(type,handler));};
  const connected=()=>info?.connected===true;
  const permitted=scope=>connected()&&scopes(info).includes(scope);
  const usable=()=>catalog?.supported===true;
  const selected=()=>catalog?.plugins?.find(item=>`${item.id}@${item.version}`===moduleField.value);
  const currentBinding=()=>bindings.find(item=>item.pluginId===selected()?.id);
  const isCurrent=stamp=>!destroyed&&dialog.open&&stamp===generation;
  function feedback(message='',error=false){part('feedback').textContent=message;part('feedback').classList.toggle('ksm-error',error);}
  function failure(error){const code=errorCode(error);if(disconnectedCodes.has(code)){info=null;catalog=null;devices=[];bindings=[];device='';bindingSequence++;}feedback(messages[code]||'Не удалось выполнить действие. Обновите список и повторите.',true);render();}
  function render(){
    const access=usable(),blocked=busy||bindingBusy;
    part('workspace').hidden=!access;
    part('availability').hidden=!access;part('runtime-note').hidden=!access;
    part('connection').textContent=connected()?`Аккаунт подключён${info.account?.email?' · '+info.account.email:''}`:'Studio не подключена к аккаунту';
    if(access){
      const label=workerAvailabilityLabel;
      part('runtime').textContent=label(catalog.capabilities.runtime);part('media').textContent=label(catalog.capabilities.media);
      part('runtime').dataset.ready=String(catalog.capabilities.runtime.available);part('media').dataset.ready=String(catalog.capabilities.media.available);
      part('runtime-note').textContent=catalog.capabilities.runtime.available?(catalog.capabilities.media.available?'Сервер готов принимать запросы модулей. Кадры и работа приложения проверяются отдельно.':catalog.capabilities.media.configured?'Обработчики доступны. Видеообработчик настроен; его доступность пока не подтверждена.':'Обработчики доступны. Для YouTube нужно настроить видеообработчик на сервере.'):catalog.capabilities.runtime.configured?'Публикация и настройка доступны. Исполнитель настроен; доступность ещё не подтверждена.':'Публикация и настройка доступны. Запуск потребует изолированного исполнителя на сервере.';
    }
    dialog.setAttribute('aria-busy',String(blocked));
    dialog.querySelector('[data-action="refresh"]').disabled=busy;
    const canPublish=access&&permitted('plugins.publish')&&catalog.capabilities.publish;
    for(const control of form('publish').querySelectorAll('input,textarea,button'))control.disabled=blocked||!canPublish;
    part('device').disabled=blocked||!devices.length||!access;
    const bindAllowed=access&&permitted('plugins.bind')&&catalog.capabilities.bind&&Boolean(device)&&Boolean(selected());
    for(const control of form('binding').querySelectorAll('input,select,textarea,button'))control.disabled=blocked||!bindAllowed;
    // Keep the selector reachable when a package exists but a device is not selected.
    moduleField.disabled=blocked||!access||!catalog?.plugins?.length;
    const binding=currentBinding(),canRollback=bindAllowed&&catalog.capabilities.rollback&&binding?.revision>1;
    for(const control of form('rollback').querySelectorAll('input,button'))control.disabled=blocked||!canRollback;
    form('rollback').hidden=!binding||binding.revision<2;
  }
  function renderPackages(){
    const previous=moduleField.value;part('packages').replaceChildren();moduleField.replaceChildren();
    const packages=catalog?.plugins||[];part('package-count').textContent=String(packages.length);part('packages-empty').hidden=packages.length>0;
    for(const item of packages){
      const li=document.createElement('li'),top=document.createElement('div'),name=document.createElement('strong'),version=document.createElement('span'),id=document.createElement('p'),hash=document.createElement('code'),option=document.createElement('option');
      name.textContent=item.name;version.textContent=`v${item.version}`;top.append(name,version);id.textContent=item.id;hash.textContent=`SHA-256 ${item.sha256.slice(0,16)}…`;hash.title=item.sha256;li.append(top,id,hash);part('packages').append(li);
      option.value=`${item.id}@${item.version}`;option.textContent=`${item.name} · ${item.version}`;moduleField.append(option);
    }
    if(packages.some(item=>`${item.id}@${item.version}`===previous))moduleField.value=previous;
    if(!packages.length){const option=document.createElement('option');option.value='';option.textContent='Сначала опубликуйте модуль';moduleField.append(option);}
  }
  function renderDevices(){
    part('device').replaceChildren();
    if(!devices.some(item=>item.id===device))device=devices[0]?.id||'';
    for(const item of devices){const option=document.createElement('option');option.value=item.id;option.textContent=`${item.name} · ${stateLabel(item)}`;part('device').append(option);}
    part('device').value=device;part('devices-empty').hidden=devices.length>0;
  }
  function renderBindings(){
    part('bindings').replaceChildren();part('bindings-empty').hidden=!device||bindings.length>0;
    for(const item of bindings){const li=document.createElement('li'),name=document.createElement('strong'),detail=document.createElement('span');name.textContent=item.pluginId;detail.textContent=`${item.version} · ревизия ${item.revision} · ${item.enabled?'включён':'выключен'}`;li.append(name,detail);part('bindings').append(li);}
  }
  function applySelection(){
    const item=selected(),binding=currentBinding();part('current').textContent=binding?`Текущая версия ${binding.version} · ревизия ${binding.revision}`:'Новая привязка · ревизия 0';
    settingsField.value=JSON.stringify(binding?.settings||(item?.id==='youtube-live'?{videoId:'4t4AQ15yj1M',fit:'contain'}:{}),null,2);enabledField.checked=binding?binding.enabled:true;
    revisionField.value=binding?.revision>1?String(binding.revision-1):'';revisionField.max=binding?String(binding.revision-1):'';render();
  }
  async function loadBindings(stamp=generation){
    const sequence=++bindingSequence,target=device;bindings=[];bindingBusy=true;renderBindings();render();
    try{if(target&&usable()&&permitted('plugins.read')){const result=await api(`/api/account/devices/${target}/plugins`);if(!isCurrent(stamp)||sequence!==bindingSequence||device!==target)return;bindings=Array.isArray(result.bindings)?result.bindings:[];}}
    catch(error){if(isCurrent(stamp)&&sequence===bindingSequence)failure(error);}
    finally{if(isCurrent(stamp)&&sequence===bindingSequence){bindingBusy=false;renderBindings();applySelection();}}
  }
  async function refresh(){
    const stamp=++generation;bindingSequence++;busy=true;bindingBusy=false;feedback('Проверяем аккаунт и возможности сервера…');render();
    try{
      const account=await api('/api/account');if(!isCurrent(stamp))return;info=account;catalog=null;devices=[];bindings=[];
      if(!connected()){feedback(messages.account_not_connected);return;}
      const [modules,owned]=await Promise.all([api('/api/account/plugins'),api('/api/account/devices')]);if(!isCurrent(stamp))return;
      catalog=modules;devices=Array.isArray(owned.devices)?owned.devices:[];renderPackages();renderDevices();
      if(!usable()){feedback(messages[modules.code]||messages.account_plugins_unsupported);return;}
      feedback('');await loadBindings(stamp);
    }catch(error){if(isCurrent(stamp))failure(error);}
    finally{if(isCurrent(stamp)){busy=false;render();}}
  }
  function parseSettings(){
    let value;try{value=JSON.parse(settingsField.value);}catch{throw invalid('account_plugin_invalid_settings');}
    if(!object(value)||Object.keys(value).length>16||Object.entries(value).some(([key,item])=>!/^[a-z][A-Za-z0-9_]{0,47}$/.test(key)||['constructor','prototype','__proto__'].includes(key)||!(typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)||typeof item==='string'&&item.length<=2000)))throw invalid('account_plugin_invalid_settings');return value;
  }
  function updatePackageSize(){const bytes=new TextEncoder().encode(packageField.value).byteLength;part('package-size').textContent=bytes<1024?`${bytes} байт`:`${(bytes/1024).toFixed(1)} / 128 КиБ`;packageField.setAttribute('aria-invalid',String(bytes>128*1024));part('digest').textContent='';}
  async function publish(event){
    event.preventDefault();if(busy||bindingBusy||!usable()||!permitted('plugins.publish'))return;
    const stamp=generation,text=packageField.value;busy=true;feedback('Проверяем пакет и вычисляем SHA-256…');render();
    try{
      const bytes=new TextEncoder().encode(text);if(bytes.byteLength>128*1024)throw invalid('package_too_large');
      let value;try{value=JSON.parse(text);}catch{throw invalid('package_invalid_json');}if(!object(value))throw invalid('package_invalid_json');
      if(!globalThis.crypto?.subtle)throw invalid('browser_sha_unavailable');
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(!isCurrent(stamp))return;const result=await api('/api/account/plugins',{method:'POST',body:{packageText:text,sha256}});if(!isCurrent(stamp))return;
      const next=await api('/api/account/plugins');if(!isCurrent(stamp))return;catalog=next;renderPackages();moduleField.value=`${result.plugin.id}@${result.plugin.version}`;applySelection();
      part('digest').textContent=`SHA-256 ${sha256}`;feedback(`Версия ${result.plugin.version} опубликована. Назначьте её устройству; запуск проверяется отдельно.`);
    }catch(error){if(isCurrent(stamp))failure(error);}
    finally{if(isCurrent(stamp)){busy=false;render();}}
  }
  async function saveBinding(event,rollback=false){
    event.preventDefault();const item=selected();if(busy||bindingBusy||!item||!device||!usable()||!permitted('plugins.bind'))return;
    const stamp=generation,target=device,binding=currentBinding(),expectedRevision=binding?.revision||0;busy=true;feedback(rollback?'Восстанавливаем привязку…':'Сохраняем привязку…');render();
    try{
      const body=rollback?{toRevision:Number(revisionField.value),expectedRevision}:{version:item.version,expectedRevision,enabled:enabledField.checked,settings:parseSettings()};
      if(rollback&&(!Number.isSafeInteger(body.toRevision)||body.toRevision<1||body.toRevision>=expectedRevision))throw invalid('account_invalid_input');
      await api(`/api/account/devices/${target}/plugins/${item.id}${rollback?'/rollback':''}`,{method:'POST',body});if(!isCurrent(stamp)||device!==target)return;
      await loadBindings(stamp);if(!isCurrent(stamp)||device!==target)return;
      if(rollback){const restored=bindings.find(binding=>binding.pluginId===item.id);if(restored){moduleField.value=`${restored.pluginId}@${restored.version}`;applySelection();}}
      feedback(rollback?'Предыдущая привязка восстановлена как новая ревизия.':'Привязка сохранена. Обработчик вызывается приложением на Киби.');
    }catch(error){if(isCurrent(stamp))failure(error);}
    finally{if(isCurrent(stamp)){busy=false;render();}}
  }
  function close(){generation++;bindingSequence++;busy=false;bindingBusy=false;if(dialog.open)dialog.close();if(lastFocus?.isConnected)lastFocus.focus();}
  on(button,'click',()=>{if(destroyed)return;lastFocus=document.activeElement;dialog.showModal();dialog.querySelector('[data-action="close"]').focus();void refresh();});
  on(dialog.querySelector('[data-action="close"]'),'click',close);
  on(dialog,'cancel',event=>{event.preventDefault();close();});
  on(dialog,'close',()=>{generation++;bindingSequence++;busy=false;bindingBusy=false;if(lastFocus?.isConnected)lastFocus.focus();});
  on(dialog.querySelector('[data-action="refresh"]'),'click',()=>void refresh());
  on(dialog.querySelector('[data-action="example"]'),'click',()=>{packageField.value=JSON.stringify(YOUTUBE_EXAMPLE,null,2);updatePackageSize();feedback('Пример готов к редактированию. Публикация создаст версию; видео требует доступного исполнителя и видеообработчика.');packageField.focus();});
  on(part('file'),'change',async()=>{const file=part('file').files?.[0],stamp=generation;if(!file)return;try{if(file.size>128*1024)throw invalid('package_too_large');const text=await file.text();if(!isCurrent(stamp))return;packageField.value=text;updatePackageSize();feedback('Пакет загружен в редактор. Проверьте текст перед публикацией.');}catch(error){if(isCurrent(stamp))failure(error);}finally{part('file').value='';}});
  on(packageField,'input',updatePackageSize);
  on(part('device'),'change',()=>{device=part('device').value;void loadBindings();});
  on(moduleField,'change',applySelection);
  on(form('publish'),'submit',event=>void publish(event));
  on(form('binding'),'submit',event=>void saveBinding(event));
  on(form('rollback'),'submit',event=>void saveBinding(event,true));
  return {open:()=>button.click(),refresh,destroy(){destroyed=true;generation++;bindingSequence++;for(const remove of listeners)remove();if(dialog.open)dialog.close();dialog.remove();button.remove();}};
}
