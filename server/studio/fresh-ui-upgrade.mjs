// Explicit migration of the immutable PUBLIC full Studio browser lineage.
// This never discovers, reads or authorizes private installed programs.
import {createHash} from 'node:crypto';

const failure=code=>Object.assign(new Error(code),{code});
const digest=value=>createHash('sha256').update(value).digest('hex');
export const FRESH_UI_BASELINES=Object.freeze({
 'web/app.js':Object.freeze({beforeSha256:'828fc31a99fe46e257b0cb3f535572627f331907166e17abdbf55914acc6ed19',afterSha256:'12ef062c92e14e451624be9e4073cda5dad5bd59d831f855f3e7f2e295921ef2'}),
 'web/index.html':Object.freeze({beforeSha256:'ffc0900c403c4f6aef7147a4bf651edf98a842f37ae0676bcfd221b52cd2ed6d',afterSha256:'3e138bc2e6b8dd10b1c6c803866903888d1ae557acf41ac4d5e55ed45500e6c2'}),
 'web/settings.js':Object.freeze({beforeSha256:'a537a45e745267ab777252d0b49e828a0bf6d9c4192730334471b8533006ae56',afterSha256:'d10e7bb8d9ba2c60be175b670b3c9a62d1977cb3e9a41d8af5e6976c75962d7c'}),
 'web/settings.css':Object.freeze({beforeSha256:'8a9d1cbddab62797c66b581655e195f744684051cef7493eb2de3e1ace29f428',afterSha256:'ee776436afa8f154201ede412917c9b0d368f1c4773dad38828f803a2294a6ce'}),
});
const imports="import {initStudioAccountUI} from './studio-account.js';\nimport {loadLocalInstallSource} from './local-install-source.js';\nimport {parsePartitions,validateLocalPartitions} from './vendor/flash-core.js';\n";
const buildFunction=`export async function buildCurrentProject({ getState, api, refresh, onPhase = () => {}, onChecks = () => {}, onMissing = () => {} }) {
  const captured = capturePreparation(getState);
  if (captured.state.implementationRequested !== true) throw new Error('Сначала согласуйте макет и нажмите «Проект готов».');
  const requirements = captured.state.project.requirements || {}, config = captured.state.configuration || {};
  const missing = (requirements.wifi || captured.state.project.requiresWifi) && !config.wifiConfigured ? 'wifi' : requirements.api && !config.apiConfigured ? 'api' : null;
  if (missing) { onMissing(missing); return { blocked: missing }; }
  onPhase('check');
  const checks = await api('/api/check', { method: 'POST', body: {} });
  await refresh(); captured.assertCurrent(); onChecks(checks);
  if (checks.passed !== true || checks.readiness && checks.readiness.passed !== true) throw new Error(checks.nextAction || 'Проверка кода не пройдена. Исправьте ошибки с ИИ и повторите сборку.');
  onPhase('build');
  const job = await api('/api/build', { method: 'POST', body: { revision: captured.state.revision } });
  await refresh(); captured.assertCurrent(); return job;
}
`;
const currentStatus=`export function currentBuildStatus(state) {
  const job = state?.build, artifacts = Array.isArray(job?.artifacts) ? job.artifacts : [], apps = artifacts.filter(file => file?.name === 'app.bin'), artifact = apps[0];
  const ready = !!state?.project?.id && job?.projectId === state.project.id && job.status === 'succeeded'
    && Number.isSafeInteger(state.revision) && job.sourceRevision === state.revision && /^[a-f0-9]{64}$/.test(state.sourceHash || '') && job.sourceHash === state.sourceHash
    && Number.isSafeInteger(state.configuration?.revision) && configurationRevision(job) === state.configuration.revision
    && apps.length === 1 && /^[a-f0-9]{64}$/.test(artifact?.sha256 || '') && Number.isSafeInteger(artifact?.size) && artifact.size > 0 && artifact.size <= 2097152 && artifact.offset === 0x10000;
  return { ready, artifact: ready ? artifact : null };
}
export function projectWorkflowView(state) {
  const ready = currentBuildStatus(state).ready, canBuild = state?.implementationRequested === true && state?.workflow?.canBuild === true, building = ['queued','building','running'].includes(state?.build?.status);
  return { canBuild, ready, building, showAction: canBuild || ready || building, action: ready ? 'install' : building ? 'status' : 'build', label: ready ? 'Установить на Киби' : building ? 'Собираем прошивку…' : 'Собрать прошивку' };
}
export function frameInputFeedback(current, {sourceHash,expectedSourceHash,previewError = false} = {}) {
  if (current !== 'Открыт другой проект · ожидаем его нативный экран' || previewError !== false || !/^[a-f0-9]{64}$/.test(sourceHash || '') || sourceHash !== expectedSourceHash) return current;
  return 'Коснитесь экрана или проведите по нему';
}
export async function prepareCurrentInstall({ refresh, device, flasherApi, flasher, fetcher = globalThis.fetch, parsePartitions, validateLocalPartitions, approval }) {
  if (typeof refresh !== 'function' || typeof flasher?.prepare !== 'function' || !(approval instanceof FlashApproval)) throw new Error('Подготовка установки недоступна.');
  approval.invalidate();
  const state = await refresh(), current = currentBuildStatus(state), expectedIdentity = flashIdentity(state);
  if (!current.ready) throw new Error('Сначала соберите текущую версию проекта.');
  const source = await loadLocalInstallSource({ job: state.build, device, flasherApi, fetcher, parsePartitions, validateLocalPartitions });
  const plan = await flasher.prepare(source), latest = await refresh();
  if (expectedIdentity !== flashIdentity(latest)) throw new Error('Проект изменился во время подготовки. Подготовьте план заново.');
  approval.prepare(latest, plan, current.artifact.sha256);
  return { plan, state: latest, artifact: current.artifact };
}
`;
const prepareFunction=`  async function prepareFlash() {
    if (runtime.flashPreparing || runtime.flashing) return; runtime.flashPreparing = true; invalidateFlash(); renderFlashControls();
    try {
      statusText('#flash-status', 'Проверяем текущую сборку, SHA-256 и полный план установки Киби…');
      const { plan, state: latest, artifact } = await prepareCurrentInstall({ refresh: refreshState, device: runtime.flasher.device, flasherApi: runtime.flasherApi, flasher: runtime.flasher, fetcher: fetch, parsePartitions, validateLocalPartitions, approval: gate });
      $('#flash-plan').hidden = false; $('#flash-revision').textContent = \\LATEST_LABEL;
      $('#flash-sha').textContent = artifact.sha256; $('#flash-source-hash').textContent = latest.sourceHash;
      $('#flash-ranges').textContent = plan.files.map(item => \\RANGE_LABEL).join('\\n'); $('#flash-impact').textContent = plan.dataWarning;
      statusText('#flash-status', 'План подготовлен. Проверьте точную сборку и подтвердите установку. Запись ещё не началась.');
    } catch (error) { invalidateFlash(); statusText('#flash-status', errorText(error), true); } finally { runtime.flashPreparing = false; renderFlashControls(); }
  }
`.replace('\\LATEST_LABEL',"`${latest.project.name || 'Киби'} · V.${latest.revision} · ${artifact.size.toLocaleString('ru-RU')} байт`")
 .replace('\\RANGE_LABEL',"`${item.name}: 0x${item.offset.toString(16)} · ${item.data.length.toLocaleString('ru-RU')} байт`");
function once(source,before,after){if(source.split(before).length!==2)throw failure('upgrade_anchor_mismatch');return source.replace(before,after);}
function between(source,start,end,replacement){
 const first=source.indexOf(start),last=source.indexOf(end,first+start.length);
 if(first<0||last<0||source.indexOf(start,first+1)>=0||source.indexOf(end,last+1)>=0)throw failure('upgrade_anchor_mismatch');
 return source.slice(0,first)+replacement+source.slice(last);
}
function browser(source){
 source=imports+source;
 source=once(source,"await api('/api/design/approve', { method: 'POST', body: { revision: captured.state.revision } });\n  await refresh(); captured.assertCurrent();\n  return send(PROJECT_READY_TEXT);","await api('/api/project/ready', { method: 'POST', body: { revision: captured.state.revision } });\n  await refresh(); captured.assertCurrent();\n  return send(PROJECT_READY_TEXT);");
 source=between(source,'export async function buildCurrentProject(',"const success = job =>",buildFunction);
 source=once(source,"const success = job => ['completed', 'succeeded', 'success'].includes(job?.status);","const success = job => job?.status === 'succeeded';");
 source=once(source,"const appArtifact = job => job?.artifacts?.find(file => file.kind === 'app' || /(?:app|project|firmware).*\\.bin$/i.test(file.name)) || job?.artifacts?.find(file => /\\.bin$/i.test(file.name) && !/bootloader|partition|otadata/i.test(file.name));","const appArtifact = job => job?.artifacts?.find(file => file.name === 'app.bin');");
 source=once(source,'JSON.stringify([state?.project?.id, state?.revision, state?.sourceHash, state?.configuration?.revision, job?.id,','JSON.stringify([state?.project?.id, state?.revision, state?.sourceHash, state?.configuration?.revision, state?.projectEpoch, state?.csrfToken, job?.projectId, job?.id,');
 source=once(source,'export class FlashApproval {',currentStatus+'export class FlashApproval {');
 source=once(source,"if (!success(job) || job.sourceHash !== state.sourceHash || job.sourceRevision !== state.revision || (configurationRevision(job) !== undefined && configurationRevision(job) !== state.configuration?.revision) || artifact?.sha256 !== sha256 || !/^[a-f0-9]{64}$/.test(sha256))","if (!currentBuildStatus(state).ready || artifact?.sha256 !== sha256 || !/^[a-f0-9]{64}$/.test(sha256))");
 source=once(source,"function isCurrentBuild() { const state = runtime.state, job = state?.build; return success(job) && job.sourceHash === state.sourceHash && job.sourceRevision === state.revision && (configurationRevision(job) === undefined || configurationRevision(job) === state.configuration?.revision); }","function isCurrentBuild() { return currentBuildStatus(runtime.state).ready; }");
 source=once(source,"$('#connect-device').disabled = runtime.flashing || runtime.connecting || runtime.connected || !runtime.flasherApi?.supportsUsb();","$('#connect-device').disabled = runtime.flashing || runtime.flashPreparing || runtime.connecting || runtime.connected || !runtime.flasherApi?.supportsUsb();");
 source=once(source,"$('#disconnect-device').disabled = runtime.flashing || !runtime.connected;","$('#disconnect-device').disabled = runtime.flashing || runtime.flashPreparing || !runtime.connected;");
 source=once(source,"const chat = state.chat || {}, config = state.configuration || {}, approved = state.approvedDesignRevision !== null && state.approvedDesignRevision !== undefined;","const chat = state.chat || {}, config = state.configuration || {}, approved = state.implementationRequested === true, workflow = projectWorkflowView(state);");
 source=once(source,"$('#build-button').disabled = building || busy || runtime.flashing || runtime.sourceDirty || runtime.buildPreparing || runtime.readyPreparing || !!photoWork;","$('#build-button').disabled = !workflow.canBuild || building || busy || runtime.flashing || runtime.sourceDirty || runtime.buildPreparing || runtime.readyPreparing || !!photoWork;\n    $('#build-ready').hidden = !workflow.showAction; $('#build-ready').disabled = building || busy || runtime.flashing || runtime.sourceDirty || runtime.buildPreparing || runtime.readyPreparing || !!photoWork; $('#build-ready').textContent = workflow.label;");
 source=once(source,"building ? 'Собираем проект…' : isCurrentBuild() ? 'Собрать заново' : 'Собрать проект'","building ? 'Собираем прошивку…' : isCurrentBuild() ? 'Собрать заново' : 'Собрать прошивку'");
 source=once(source,"if (state.files?.length) {","if (!building && !runtime.buildPreparing && !runtime.buildError && !workflow.ready && !workflow.canBuild) { const blockers = state.workflow?.blockers || []; $('#build-summary').textContent = blockers.find(item => typeof item?.message === 'string')?.message || (approved ? 'Дождитесь проверки текущего кода с ИИ.' : 'Согласуйте макет и нажмите «Проект готов».'); }\n    if (state.files?.length) {");
 source=once(source,"      const errorHeader = response.headers.get('X-Preview-Error'), previewError = !!errorHeader && errorHeader !== 'false' && errorHeader !== '0';","      const errorHeader = response.headers.get('X-Preview-Error'), previewError = !!errorHeader && errorHeader !== 'false' && errorHeader !== '0';\n      const feedback = frameInputFeedback($('#input-feedback').textContent, { sourceHash: response.headers.get('X-Source-Hash'), expectedSourceHash: runtime.state?.sourceHash, previewError });\n      if (feedback !== $('#input-feedback').textContent) statusText('#input-feedback', feedback);");
 source=between(source,'  async function prepareFlash() {','  function connectDevice() {',prepareFunction);
 source=once(source,'if (!runtime.flasher || runtime.connecting || runtime.connected || runtime.flashing) return;','if (!runtime.flasher || runtime.connecting || runtime.connected || runtime.flashing || runtime.flashPreparing) return;');
 source=once(source,"  $('#build-button').addEventListener('click', run(async () => {","  $('#build-ready').addEventListener('click', () => { if (currentBuildStatus(runtime.state).ready) { $('#flash-dialog').showModal(); renderFlashControls(); } else if (projectWorkflowView(runtime.state).canBuild) { $('#open-build').click(); $('#build-button').click(); } });\n  $('#build-button').addEventListener('click', run(async () => {");
 source=once(source,"if (runtime.buildPreparing) return; runtime.buildPreparing = true;","if (runtime.buildPreparing || !projectWorkflowView(runtime.state).canBuild) return; runtime.buildPreparing = true;");
 source=once(source,"}; paintFrame();","}; initStudioAccountUI({api,mount:document.querySelector('.header-utilities')}); paintFrame();");
 return source+'\n// KIBI_FRESH_PUBLIC_UI_20261117\n';
}
function html(source){
 source=once(source,'</head>','<link rel="stylesheet" href="./studio-account.css">\n</head>');
 source=once(source,'<span class="chat-mode" id="chat-mode" role="status">','<button type="button" id="build-ready" class="project-ready" hidden disabled>Собрать прошивку</button><span class="chat-mode" id="chat-mode" role="status">');
 source=once(source,'<div class="design-actions">','<div class="design-actions" hidden>');
 source=once(source,'Соберите текущий код приложения. Проверим ошибки и подготовим прошивку; установка на Киби запускается отдельно.','Согласуйте макет и нажмите «Проект готов». После проверки кода появится сборка прошивки. Установку на Киби подтвердите отдельно.');
 source=once(source,'id="build-button">Собрать проект','id="build-button" disabled>Собрать прошивку');
 return source+'\n<!-- KIBI_FRESH_PUBLIC_UI_20261117 -->\n';
}
const variantFunctions=`const DEVICE_VARIANT_LABELS = Object.freeze({basic:'Киби без динамика',speaker:'Киби с динамиком'});
export function deviceVariantView(configuration = {}, draft) {
  const saved = typeof configuration?.deviceVariant === 'string' && Object.hasOwn(DEVICE_VARIANT_LABELS, configuration.deviceVariant) ? configuration.deviceVariant : 'basic';
  const value = typeof draft === 'string' && Object.hasOwn(DEVICE_VARIANT_LABELS, draft) ? draft : saved;
  return {saved,value,label:DEVICE_VARIANT_LABELS[saved],dirty:value !== saved};
}
export async function saveDeviceVariant({variant,operation,scope,api,refresh,invalidateFlash} = {}) {
  if (typeof variant !== 'string' || !Object.hasOwn(DEVICE_VARIANT_LABELS, variant)) throw new Error('Выберите вариант Киби: с динамиком или без.');
  if (!operation || typeof scope?.isCurrent !== 'function' || typeof scope?.dispatch !== 'function' || !scope.isCurrent(operation)) throw new Error('Проект изменился. Откройте настройки нужного проекта заново.');
  if (typeof api !== 'function' || typeof refresh !== 'function' || typeof invalidateFlash !== 'function') throw new Error('Настройки Киби пока недоступны.');
  await scope.dispatch(operation, () => api('/api/device/variant', {method:'POST',body:{variant}}));
  if (!scope.isCurrent(operation)) return {applied:false,stale:true};
  invalidateFlash('Вариант Киби изменён. Соберите новую прошивку и подготовьте план заново.');
  const latest = await refresh();
  if (!scope.isCurrent(operation)) return {applied:false,stale:true};
  if ((latest?.configuration?.deviceVariant ?? latest?.project?.deviceVariant) !== variant) throw new Error('Не удалось подтвердить вариант Киби. Обновите настройки перед повтором.');
  return {applied:true,variant};
}
`;
const deviceTab='<button id="settings-device-tab" class="settings-tab is-selected" role="tab" aria-selected="true" aria-controls="settings-device-panel" type="button" data-settings-tab="device">Киби</button>';
const wifiTabBefore='<button id="settings-wifi-tab" class="settings-tab is-selected" role="tab" aria-selected="true" aria-controls="settings-wifi-panel" type="button" data-settings-tab="wifi">Wi-Fi</button>';
const wifiTabAfter='<button id="settings-wifi-tab" class="settings-tab" role="tab" aria-selected="false" aria-controls="settings-wifi-panel" tabindex="-1" type="button" data-settings-tab="wifi">Wi-Fi</button>';
const devicePanel=`<section id="settings-device-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-device-tab"><div class="settings-section-heading"><div><h3>Ваша Киби</h3><p>Укажите, есть ли у платы штатный динамик. Микрофон есть в обоих вариантах.</p></div><span class="settings-status" id="settings-device-current">Киби без динамика</span></div>
<form id="settings-device-form" class="settings-form"><label for="settings-device-variant">Вариант платы</label><select id="settings-device-variant" name="variant"><option value="basic">Киби без динамика</option><option value="speaker">Киби с динамиком</option></select><p class="settings-field-help">Для голосовых ответов выберите «Киби с динамиком». После смены варианта потребуется новая сборка прошивки.</p><button class="settings-apply" type="submit" disabled>Сохранить вариант</button></form></section>
`;
const deviceSaveHandler=`$('#settings-device-variant').addEventListener('change', () => {
  const view = deviceVariantView(window.studio?.getState()?.configuration, $('#settings-device-variant').value); deviceDraftDirty = view.dirty;
  $('#settings-device-form [type="submit"]').disabled = !view.dirty || !!variantOperation && projectScope.isCurrent(variantOperation);
});
$('#settings-device-form').addEventListener('submit', async event => {
  event.preventDefault(); if (variantOperation && projectScope.isCurrent(variantOperation)) return;
  let operation;
  try {
    if (!window.studio) throw new Error('Studio ещё подключается. Повторите сохранение после подключения.');
    operation = projectScope.capture(); variantOperation = operation; sync(window.studio.getState()?.configuration);
    $('#settings-result').textContent = 'Сохраняем вариант Киби…';
    const result = await saveDeviceVariant({variant:$('#settings-device-variant').value,operation,scope:projectScope,api:window.studio.api,refresh:window.studio.refresh,invalidateFlash:window.studio.invalidateFlash});
    if (!result.applied || !projectScope.isCurrent(operation)) return;
    clearForms(); sync(window.studio.getState()?.configuration); $('#settings-result').textContent = 'Вариант Киби сохранён. Для установки соберите новую прошивку.'; $('#settings-result').classList.remove('is-error');
  } catch (error) { if (!operation || projectScope.isCurrent(operation)) { $('#settings-result').textContent = error.message; $('#settings-result').classList.add('is-error'); } }
  finally { if (variantOperation === operation) variantOperation = null; if (!operation || projectScope.isCurrent(operation)) sync(window.studio?.getState()?.configuration); }
});
`;
function settings(source){
 source=once(source,"if (typeof document !== 'undefined') {",variantFunctions+"\nif (typeof document !== 'undefined') {");
 source=once(source,'Wi-Fi необязателен для базового проекта. Добавьте его, если вашему приложению понадобится сеть.','Сначала выберите вариант своей Киби. Wi-Fi добавьте, если приложению понадобится сеть.');
 source=once(source,wifiTabBefore,deviceTab+wifiTabAfter);
 source=once(source,'<section id="settings-wifi-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-wifi-tab">',devicePanel+'<section id="settings-wifi-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-wifi-tab" hidden>');
 source=once(source,'function sync(configuration = {}) {',`let deviceDraftDirty = false, variantOperation = null;
function sync(configuration = {}) {
  const device = deviceVariantView(configuration, deviceDraftDirty ? $('#settings-device-variant').value : undefined), saving = !!variantOperation && projectScope.isCurrent(variantOperation);
  $('#settings-device-variant').value = device.value; $('#settings-device-variant').disabled = saving; deviceDraftDirty = device.dirty;
  $('#settings-device-current').textContent = device.label; $('#settings-device-form [type="submit"]').disabled = saving || !device.dirty;`);
 source=once(source,'function clearForms() {','function clearForms() { deviceDraftDirty = false;');
 source=once(source,"if (['wifi', 'api'].includes(button.dataset.settingsOpen)) selectTab(button.dataset.settingsOpen);","if (['device', 'wifi', 'api'].includes(button.dataset.settingsOpen)) selectTab(button.dataset.settingsOpen);");
 source=once(source,"selectTab(event.key === 'Home' ? 'wifi' : event.key === 'End' ? 'api' : tab.dataset.settingsTab === 'wifi' ? 'api' : 'wifi', true);","const tabs = ['device','wifi','api'], index = tabs.indexOf(tab.dataset.settingsTab), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; selectTab(tabs[next], true);");
 source=once(source,"for (const service of ['wifi', 'api']) $(`#settings-${service}-form`).addEventListener",deviceSaveHandler+"for (const service of ['wifi', 'api']) $(`#settings-${service}-form`).addEventListener");
 return source+'\n// KIBI_FRESH_PUBLIC_VARIANT_SETTINGS_20261117\n';
}
function settingsStyles(source){
 const rules=[
  ['.project-settings button,.project-settings input{','.project-settings button,.project-settings input,.project-settings select{',2],
  ['.project-settings button:focus-visible,.project-settings input:focus-visible{','.project-settings button:focus-visible,.project-settings input:focus-visible,.project-settings select:focus-visible{',1],
  ['.settings-form>input,.settings-secret input{','.settings-form>input,.settings-form>select,.settings-secret input{',2],
  ['.settings-form>input:hover,.settings-secret:hover input{','.settings-form>input:hover,.settings-form>select:hover,.settings-secret:hover input{',1],
  ['.settings-form>input:focus,.settings-secret input:focus{','.settings-form>input:focus,.settings-form>select:focus,.settings-secret input:focus{',1],
 ];
 for(const[before,after,count]of rules){if(source.split(before).length!==count+1)throw failure('upgrade_anchor_mismatch');source=source.split(before).join(after);}
 return source+'\n/* KIBI_FRESH_PUBLIC_VARIANT_FIELD_20261117 */\n';
}
export function upgradeFreshUiProgram(path,bytes){
 const baseline=FRESH_UI_BASELINES[path];
 if(!baseline||!(bytes instanceof Uint8Array))throw failure('upgrade_unknown_baseline');
 const actual=digest(bytes);
 if(actual===baseline.afterSha256)return Buffer.from(bytes);
 if(actual!==baseline.beforeSha256)throw failure('upgrade_unknown_baseline');
 let source;try{source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw failure('upgrade_invalid_program');}
 const result=Buffer.from(path==='web/app.js'?browser(source):path==='web/settings.js'?settings(source):path==='web/settings.css'?settingsStyles(source):html(source));
 if(digest(result)!==baseline.afterSha256)throw failure('upgrade_transform_mismatch');
 return result;
}
