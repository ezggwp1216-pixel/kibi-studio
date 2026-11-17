import {initStudioAccountUI} from './studio-account.js';
import {initServerModulesUI} from './server-modules.js';
import {loadLocalInstallSource} from './local-install-source.js';
import {parsePartitions,validateLocalPartitions} from './vendor/flash-core.js';
// Local runtime client. Public state only; credentials stay in private settings.
export function createStudioClient({ getToken, getProject = () => undefined, fetcher = globalThis.fetch.bind(globalThis) }) {
  return async (url, { method = 'GET', body, signal } = {}) => {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') { headers['X-Studio-Token'] = getToken() || ''; const projectId = getProject(); if (typeof projectId === 'string' && projectId) headers['X-Studio-Project'] = projectId; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store', credentials: 'same-origin' }); }
    catch (cause) { throw new Error('Локальный Studio недоступен. Проверьте, что сервер запущен.', { cause }); }
    let result; try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) { const error = new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `Ошибка Studio (${response.status})`); error.status = response.status; error.details = result; throw error; }
    return result;
  };
}
export function rgbToRgba(rgb, width, height) {
  if (!(rgb instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgb.length !== width * height * 3) throw new Error('Некорректный RGB888 кадр');
  const result = new Uint8ClampedArray(width * height * 4);
  for (let input = 0, output = 0; input < rgb.length; input += 3, output += 4) { result[output] = rgb[input]; result[output + 1] = rgb[input + 1]; result[output + 2] = rgb[input + 2]; result[output + 3] = 255; }
  return result;
}
export function pointerInput(start, end, bounds) {
  if (!bounds?.width || !bounds?.height) throw new Error('Размер экрана предпросмотра недоступен');
  const point = event => ({ x: Math.min(239, Math.max(0, Math.floor((event.clientX - bounds.left) * 240 / bounds.width))), y: Math.min(295, Math.max(0, Math.floor((event.clientY - bounds.top) * 296 / bounds.height))) });
  const first = point(start), last = point(end), dx = last.x - first.x, dy = last.y - first.y;
  const durationMs = Math.min(10000, Math.max(0, Math.round(end.at - start.at)));
  if (Math.max(Math.abs(dx), Math.abs(dy)) > 10) return { type: 'swipe', dx, dy, durationMs };
  return { type: 'tap', ...last, dx, dy, durationMs };
}
export function wheelInput({ deltaX, deltaY }) {
  const direction = Math.abs(deltaX || 0) > Math.abs(deltaY || 0) ? deltaX : deltaY;
  return Number.isFinite(direction) && direction !== 0 ? { type: 'swipe', dx: direction > 0 ? -48 : 48, dy: 0, durationMs: 200 } : null;
}
export function createPreviewPlayback({ render, isVisible, isBusy, onError = () => {}, schedule = (callback, delay) => globalThis.setInterval(callback, delay), cancel = timer => globalThis.clearInterval(timer) }) {
  let playing = false, running = false, timer = null;
  const tick = async () => {
    if (!playing || running || !isVisible() || isBusy()) return;
    running = true; try { await render(); } catch (error) { onError(error); } finally { running = false; }
  };
  return {
    get playing() { return playing; },
    play() { if (playing) return; playing = true; timer = schedule(tick, 1000); },
    pause() { playing = false; if (timer !== null) cancel(timer); timer = null; }
  };
}
export function projectSwitchStatus(runtime) {
  const reason = runtime.flashing ? 'Дождитесь завершения записи прошивки.'
    : runtime.sourceDirty ? 'Сохраните изменения в исходнике или перечитайте файл перед сменой проекта.'
    : runtime.flashPreparing || runtime.connecting ? 'Дождитесь завершения операции с Киби.'
    : runtime.pendingSend || runtime.readyPreparing || runtime.buildPreparing || runtime.state?.chat?.busy ? 'Дождитесь завершения текущего действия или ответа ИИ.'
    : ['queued', 'building', 'running'].includes(runtime.state?.build?.status) ? 'Дождитесь завершения сборки прошивки.'
    : runtime.sourceLoading || runtime.inputPending > 0 ? 'Дождитесь завершения текущего действия.'
    : !runtime.state?.project || !runtime.online ? 'Дождитесь подключения к локальной Studio.' : '';
  return { allowed: !reason, reason };
}
export function createProjectDrafts() {
  const drafts = new Map();
  return { switch(from, to, currentText) { if (from && from !== to) drafts.set(from, String(currentText || '')); return drafts.get(to) || ''; }, clear(projectId) { drafts.delete(projectId); } };
}
export function previewNeedsRefresh(previous, next) {
  const beforeConnected = previous?.cloud?.connected ?? previous?.cloud?.signedIn, afterConnected = next?.cloud?.connected ?? next?.cloud?.signedIn;
  return !previous || previous.project?.id !== next.project?.id || previous.sourceHash !== next.sourceHash || beforeConnected !== true && afterConnected === true;
}
export function staleProjectState(current, next) {
  return current?.csrfToken === next?.csrfToken && Number.isInteger(current?.projectEpoch) && Number.isInteger(next?.projectEpoch) && next.projectEpoch < current.projectEpoch;
}
export function compositionCanSend({ ready, text = '', photos = { ids: [], blocked: false } }) {
  return !!ready && !photos.blocked && (!!text.trim() || photos.ids.length > 0);
}
export function messageAttachmentUrl(value, projectId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId || '') || !/^[a-f0-9]{32}$/.test(value?.id || '') || !['image/jpeg', 'image/png', 'image/webp'].includes(value?.mime)) return null;
  const expected = `/api/attachments/${projectId}/${value.id}`;
  return value.url === expected ? expected : null;
}
export const PROJECT_READY_TEXT = 'Проект готов. Создай код для Киби. Проверь ошибки и удобство управления: тач, свайпы и кнопки.';
const preparationIdentity = state => JSON.stringify([state?.project?.id, state?.revision, state?.sourceHash, state?.configuration?.revision, state?.projectEpoch, state?.csrfToken]);
function capturePreparation(getState) {
  const state = getState(); if (!state?.project?.id || state.chat?.busy) throw new Error('Дождитесь подключения проекта и завершения ответа ИИ.');
  const identity = preparationIdentity(state);
  return { state, assertCurrent() { if (preparationIdentity(getState()) !== identity) throw new Error('Проект или его код изменились. Повторите действие для текущей версии.'); } };
}
export async function requestProjectCode({ getState, api, refresh, send }) {
  const captured = capturePreparation(getState);
  await api('/api/project/ready', { method: 'POST', body: { revision: captured.state.revision } });
  await refresh(); captured.assertCurrent();
  return send(PROJECT_READY_TEXT);
}
export async function buildCurrentProject({ getState, api, refresh, onPhase = () => {}, onChecks = () => {}, onMissing = () => {} }) {
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
const success = job => job?.status === 'succeeded';
const configurationRevision = job => job?.configurationRevision ?? job?.configRevision;
const appArtifact = job => job?.artifacts?.find(file => file.name === 'app.bin');
function flashIdentity(state) { const job = state?.build; return JSON.stringify([state?.project?.id, state?.revision, state?.sourceHash, state?.configuration?.revision, state?.projectEpoch, state?.csrfToken, job?.projectId, job?.id, job?.sourceRevision, job?.sourceHash, configurationRevision(job), job?.status, job?.artifacts?.map(file => [file.name, file.sha256, file.size, file.offset])]); }
export function currentBuildStatus(state) {
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
export class FlashApproval {
  constructor() { this.invalidate(); }
  invalidate() { this.plan = null; this.identity = null; this.approved = false; this.sha256 = null; }
  prepare(state, plan, sha256) {
    const job = state?.build, artifact = appArtifact(job);
    if (!currentBuildStatus(state).ready || artifact?.sha256 !== sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Исходники, настройки или сборка изменились. Подготовьте установку заново.');
    this.identity = flashIdentity(state); this.plan = plan; this.sha256 = sha256; this.approved = false;
  }
  valid(state) { return !!this.plan && this.identity === flashIdentity(state); }
  approve(state) { if (!this.valid(state)) throw new Error('Сборка изменилась; подготовьте установку заново.'); this.approved = true; }
  take(state) {
    if (!this.valid(state)) { this.invalidate(); throw new Error('Подготовьте установку заново: состояние изменилось.'); }
    if (!this.approved) throw new Error('Подтвердите точную сборку перед записью.');
    const plan = this.plan; this.invalidate(); return plan;
  }
}

async function startStudio() {
  const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
  const canvas = $('#device-canvas'), context = canvas.getContext('2d', { alpha: false });
  const runtime = { state: null, online: false, power: true, frame: null, frameVersion: 0, frameRequest: null, framePending: false, inputPending: 0, scenario: 'ready', source: null, sourceDirty: false, sourceLoading: false, sourceRequest: 0, flasher: null, flasherApi: null, connecting: false, connected: false, flashing: false, flashPreparing: false, stream: null, delta: null, deltaKey: null, pendingSend: false, readyPreparing: false, buildPreparing: false, buildPhase: '', buildError: '', buildPoll: null, stateRefresh: null };
  const gate = new FlashApproval(), approvals = new Map(), api = createStudioClient({ getToken: () => runtime.state?.csrfToken, getProject: () => runtime.state?.project?.id });
  const projectDrafts = createProjectDrafts(), sourceDrafts = new Map();
  const previewPane = $('.preview-pane'), previewDialog = $('#preview-dialog'), previewHome = document.createComment('native preview home'); previewPane.before(previewHome);
  let pointer = null, lastWheel = -Infinity, inputQueue = Promise.resolve(), previewBodyOverflow = '';
  let toastTimer, stateRequestVersion = 0;
  const notice = (message, error = false) => { $('#toast').textContent = message; $('#toast').hidden = false; $('#toast').classList.toggle('is-error', error); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, error ? 9000 : 4500); };
  const errorText = error => error?.message || String(error);
  const statusText = (selector, text, error = false) => { $(selector).textContent = text; $(selector).classList.toggle('is-error', error); };
  const report = error => { notice(errorText(error), true); if (error.status === 403) refreshState().catch(() => {}); };
  const run = callback => async event => { try { await callback(event); } catch (error) { report(error); } };
  const revision = () => runtime.state?.revision ?? '—';
  const phase = name => $$('[data-phase]').forEach(element => element.classList.toggle('is-active', element.dataset.phase === name));
  function paintFrame() { if (runtime.power && runtime.frame) context.putImageData(runtime.frame, 0, 0); else { context.fillStyle = '#0b0b0b'; context.fillRect(0, 0, 240, 296); } }
  function invalidateFlash(message) { const hadPlan = !!gate.plan; gate.invalidate(); $('#flash-confirm').checked = false; $('#flash-confirm').disabled = true; $('#write-firmware').disabled = true; $('#flash-plan').hidden = true; if (hadPlan && message) statusText('#flash-status', message); }
  function isCurrentBuild() { return currentBuildStatus(runtime.state).ready; }
  function renderFlashControls() {
    $('#connect-device').disabled = runtime.flashing || runtime.flashPreparing || runtime.connecting || runtime.connected || !runtime.flasherApi?.supportsUsb();
    $('#disconnect-device').disabled = runtime.flashing || runtime.flashPreparing || !runtime.connected;
    $('#prepare-flash').disabled = runtime.flashing || runtime.flashPreparing || !runtime.connected || !isCurrentBuild();
    $('#flash-confirm').disabled = runtime.flashing || !gate.valid(runtime.state);
    $('#write-firmware').disabled = runtime.flashing || !gate.valid(runtime.state) || !gate.approved; $('#close-flash').disabled = runtime.flashing;
  }
  function renderComposerControls() {
    const chat = runtime.state?.chat || {}, busy = !!chat.busy || runtime.pendingSend, canChat = !!chat.ready && !!chat.authenticated && !busy && !runtime.flashing && !runtime.readyPreparing && !runtime.buildPreparing;
    const photos = window.studio?.attachments?.snapshot(runtime.state?.project?.id) || { ids: [], blocked: false };
    $('#chat-input').disabled = !canChat; $('#send-message').disabled = !compositionCanSend({ ready: canChat, text: $('#chat-input').value, photos });
    $('#composer-attach').disabled = !canChat; $('#stop-chat').hidden = !busy; $('#stop-chat').disabled = !chat.busy;
    $('#project-ready').disabled = !canChat || runtime.sourceDirty; $('#project-ready').setAttribute('aria-busy', String(runtime.readyPreparing));
  }
  function messageNode(message) {
    const role = message.role || message.type || 'assistant', node = document.createElement('article'); node.className = `message ${role === 'user' ? 'user-message' : 'ai-message'}`;
    const byline = document.createElement('div'); byline.className = 'message-byline'; const name = document.createElement('strong'); name.textContent = role === 'user' ? 'Вы' : role === 'system' ? 'Studio' : 'Киби · ChatGPT';
    const body = document.createElement('p'); body.textContent = typeof message.content === 'string' ? message.content : message.text || ''; byline.append(name); node.append(byline);
    const images = (Array.isArray(message.attachments) ? message.attachments : []).map(photo => ({ photo, url: messageAttachmentUrl(photo, runtime.state?.project?.id) })).filter(item => item.url).slice(0, 4);
    if (images.length) { const gallery = document.createElement('div'); gallery.className = 'message-attachments'; for (const { photo, url } of images) { const link = document.createElement('a'), image = document.createElement('img'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; image.src = url; image.alt = photo.name || 'Фото к сообщению'; image.loading = 'lazy'; link.append(image); gallery.append(link); } node.append(gallery); }
    node.append(body); return node;
  }
  function renderMessages(messages) {
    const container = $('#conversation'), nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120, nodes = messages.map(messageNode);
    if (!nodes.length) { const empty = document.createElement('div'); empty.className = 'chat-empty'; empty.textContent = 'Что сделаем? Опишите идею приложения — вместе продумаем функции, дизайн и управление на Киби.'; nodes.push(empty); }
    const streamed = runtime.delta?.querySelector('p').textContent || '';
    const streamedIndex = messages.findIndex(message => message.role === 'assistant' && (message.itemId === runtime.deltaKey || (streamed && (message.text || message.content || '') === streamed)));
    if (runtime.delta && runtime.state?.chat?.busy) {
      if (streamedIndex >= 0) { runtime.delta = nodes[streamedIndex]; const body = runtime.delta.querySelector('p'); if (streamed.length > body.textContent.length) body.textContent = streamed; }
      else nodes.push(runtime.delta);
    }
    nodes.push(...approvals.values());
    container.replaceChildren(...nodes); if (nearBottom) container.scrollTop = container.scrollHeight;
  }
  function renderState(state) {
    if (!state?.project || staleProjectState(runtime.state, state)) return;
    if (gate.plan && !gate.valid(state)) invalidateFlash('Исходники, настройки или сборка изменились. Подготовьте план заново.');
    const previous = runtime.state; runtime.state = state; runtime.online = true;
    const projectChanged = !!previous?.project?.id && previous.project.id !== state.project.id;
    if (projectChanged || previous?.sourceHash !== state.sourceHash || previous?.configuration?.revision !== state.configuration?.revision) runtime.buildError = '';
    if (previous?.sourceHash !== state.sourceHash) { $('#check-detail').hidden = true; $('#check-detail').textContent = ''; }
    if (projectChanged) {
      $('#chat-input').value = projectDrafts.switch(previous.project.id, state.project.id, $('#chat-input').value);
      if (runtime.sourceDirty && runtime.source) sourceDrafts.set(previous.project.id, { source: { ...runtime.source }, content: $('#source-content').value });
      const draft = sourceDrafts.get(state.project.id);
      runtime.sourceRequest++; runtime.sourceLoading = false; runtime.source = draft?.source || null; runtime.sourceDirty = !!draft;
      $('#source-content').value = draft?.content || ''; $('#source-content').readOnly = !draft?.source?.editable; $('#source-save').disabled = true;
      if (draft) $('#source-path').value = draft.source.path;
      $('#source-sha').textContent = draft ? `SHA-256 ${draft.source.sha256}` : ''; $('#source-conflict').hidden = true;
      statusText('#source-status', draft ? 'Восстановлены несохранённые изменения этого проекта' : 'Откройте файл выбранного проекта');
      runtime.delta = null; runtime.deltaKey = null; approvals.clear();
      runtime.frameRequest?.abort(); runtime.frameVersion++; runtime.framePending = false; runtime.frame = null; paintFrame();
      $('#check-detail').hidden = true; $('#check-detail').textContent = ''; $('#preview-error-details').hidden = true; $('#preview-error').textContent = '';
      statusText('#input-feedback', 'Открыт другой проект · ожидаем его нативный экран');
    }
    const chat = state.chat || {}, config = state.configuration || {}, approved = state.implementationRequested === true, workflow = projectWorkflowView(state);
    $('#project-name').textContent = state.project.name || 'Киби · Новый проект'; $('#version-stamp').textContent = `V.${String(state.revision).padStart(2, '0')}`;
    $('#composer-context').textContent = approved ? `Макет утверждён · исходники V.${state.revision}` : `Обсуждаем макет V.${state.revision}`;
    $('#design-summary').textContent = approved ? `Макет V.${state.approvedDesignRevision} утверждён` : 'Проверьте нативный экран и утвердите макет';
    $('#approve-button').textContent = approved ? 'Макет утверждён ✓' : `Утвердить V.${state.revision} ✓`; $('#approve-button').disabled = approved || chat.busy || runtime.flashing || runtime.buildPreparing || runtime.readyPreparing;
    $('#code-request').hidden = !approved; $('#code-request').disabled = chat.busy || runtime.flashing || runtime.buildPreparing || runtime.readyPreparing;
    const busy = !!chat.busy || runtime.pendingSend; renderComposerControls();
    $('#chat-mode').textContent = chat.busy ? 'Работает…' : !chat.available ? 'Codex недоступен' : !chat.authenticated ? 'Нужен вход' : chat.ready ? 'ChatGPT подключён' : 'Подключение…';
    $('#connection-help').hidden = (!!chat.available && !!chat.authenticated && !!chat.ready) && !chat.error;
    $('#connection-detail').textContent = chat.error || (!chat.available ? 'Установите Codex и запустите локальный Studio заново.' : !chat.authenticated ? 'Откройте Codex, войдите через свою учётную запись ChatGPT и перезапустите локальный Studio. Ключ API для чата не нужен.' : !chat.ready ? 'Studio устанавливает соединение с локальным Codex.' : '');
    $('#composer-status').textContent = chat.busy ? 'Ответ и изменения поступают от локального Codex · можно остановить' : chat.authenticated && chat.ready ? 'Ваш ChatGPT · локальный проект · ⌘/Ctrl + Enter' : 'Нужен вход в Codex через ChatGPT';
    $('#runtime-status').textContent = 'Локально'; $('#runtime-status').classList.remove('is-error');
    if (state.cloud?.mode === 'remote' && (state.cloud.connected ?? state.cloud.signedIn) !== true) { playback.pause(); syncPlaybackControl(); }
    const environment = state.environment || {}, issues = environment.issues || []; $('#environment-help').hidden = environment.ready !== false;
    $('#environment-detail').textContent = issues.map(issue => typeof issue === 'string' ? issue : issue.message || issue.detail || JSON.stringify(issue)).join('\n') || 'Сервер сборки недоступен. Проверьте интернет и повторите подключение.';
    const requiresWifi = state.project.requiresWifi === true || state.project.requirements?.wifi === true, requiresApi = state.project.requirements?.api === true;
    $('#wifi-build-help').hidden = !requiresWifi || !!config.wifiConfigured;
    $('#api-build-help').hidden = !requiresApi || !!config.apiConfigured;
    const building = state.build && ['queued', 'building', 'running'].includes(state.build.status);
    const photoWork = window.studio?.attachments?.snapshot(state.project.id).items?.some(item => ['preparing', 'uploading'].includes(item.status));
    $('#build-button').disabled = !workflow.canBuild || building || busy || runtime.flashing || runtime.sourceDirty || runtime.buildPreparing || runtime.readyPreparing || !!photoWork;
    $('#build-ready').hidden = !workflow.showAction; $('#build-ready').disabled = building || busy || runtime.flashing || runtime.sourceDirty || runtime.buildPreparing || runtime.readyPreparing || !!photoWork; $('#build-ready').textContent = workflow.label;
    $('#build-button').textContent = runtime.buildPreparing ? ({ approve: 'Подготавливаем…', check: 'Проверяем код…', build: 'Запускаем сборку…' }[runtime.buildPhase] || 'Подготавливаем…') : building ? 'Собираем прошивку…' : isCurrentBuild() ? 'Собрать заново' : 'Собрать прошивку';
    $('#open-flash').disabled = !isCurrentBuild() || runtime.flashing || runtime.buildPreparing; $('#download-build').hidden = !isCurrentBuild();
    if (isCurrentBuild()) $('#download-build').href = `/api/build/${encodeURIComponent(state.build.id)}/app.bin`;
    $('#build-summary').textContent = runtime.buildPreparing ? 'Проверяем текущий код и готовим прошивку.' : building ? `Собираем проект V.${state.build.sourceRevision}…` : runtime.buildError || (isCurrentBuild() ? `Проект собран · V.${state.build.sourceRevision} · ${Math.ceil((appArtifact(state.build)?.size || 0) / 1024)} КБ` : state.build?.error ? errorText(state.build.error) : state.build ? 'Код изменился — соберите новую версию.' : 'Соберите текущий код проекта, чтобы установить его на Киби.');
    $('#build-summary').classList.toggle('is-ready', isCurrentBuild() && !runtime.buildError); $('#build-summary').classList.toggle('is-error', !!runtime.buildError);
    const log = state.build?.log; $('#build-log').textContent = Array.isArray(log) ? log.join('\n') : typeof log === 'string' ? log : ''; $('#build-log-details').hidden = !log || !log.length;
    if (!building && !runtime.buildPreparing && !runtime.buildError && !workflow.ready && !workflow.canBuild) { const blockers = state.workflow?.blockers || []; $('#build-summary').textContent = blockers.find(item => typeof item?.message === 'string')?.message || (approved ? 'Дождитесь проверки текущего кода с ИИ.' : 'Согласуйте макет и нажмите «Проект готов».'); }
    if (state.files?.length) {
      const select = $('#source-path'), value = select.value, items = state.files;
      select.replaceChildren(...items.map(file => { const option = document.createElement('option'); option.value = file.path; option.textContent = `${file.editable ? '' : '▣ '}${file.path}`; return option; }));
      select.value = items.some(file => file.path === value) ? value : items.some(file => file.path === value.replace(/^firmware\//, '')) ? value.replace(/^firmware\//, '') : items.some(file => file.path === 'app_view.h') ? 'app_view.h' : items[0].path;
      if (runtime.source) { const entry = items.find(file => file.path === runtime.source.path); runtime.source.editable = !!entry?.editable; $('#source-content').readOnly = !entry?.editable; $('#source-save').disabled = runtime.sourceLoading || !runtime.sourceDirty || !entry?.editable || runtime.flashing || busy; }
    }
    $$('[data-settings-open]').forEach(button => button.disabled = runtime.flashing);
    if (Array.isArray(chat.approvals)) { const pending = new Set(chat.approvals.map(approval => approval.requestId)); for (const [id, node] of approvals) if (!pending.has(id)) { node.remove(); approvals.delete(id); } chat.approvals.forEach(showAgentApproval); }
    renderMessages(state.messages || []); renderFlashControls(); phase(approved ? 'code' : 'mockup'); window.dispatchEvent(new CustomEvent('studio:state', { detail: state }));
    if (previewNeedsRefresh(previous, state)) refreshFrame();
    clearTimeout(runtime.buildPoll); if (building) runtime.buildPoll = setTimeout(() => refreshState().catch(report), 1600);
  }
  async function refreshState() { const request = ++stateRequestVersion, state = await api('/api/state'); if (request === stateRequestVersion) renderState(state); return runtime.state || state; }
  function disconnected() {
    runtime.online = false; statusText('#runtime-status', 'Нет связи', true); $('#chat-mode').textContent = 'Нет связи'; $('#composer-status').textContent = 'Нет связи с локальным Studio · проверьте сервер'; $('#connection-help').hidden = false; $('#connection-detail').textContent = 'Локальный Studio недоступен. Запустите сервер и обновите подключение.';
    $('#chat-input').disabled = true; $('#send-message').disabled = true; $('#composer-attach').disabled = true; $('#approve-button').disabled = true; $('#build-button').disabled = true;
    if (!runtime.state) $('#conversation').replaceChildren(Object.assign(document.createElement('div'), { className: 'chat-empty', textContent: 'История появится после соединения с локальным Studio.' }));
    statusText('#preview-state', runtime.frame ? 'Нет связи · показан последний кадр' : 'Ожидаем локальный сервер', true); invalidateFlash('Связь с локальным Studio прервана. Проверьте сервер и подготовьте план заново.');
  }
  async function refreshFrame() {
    runtime.frameRequest?.abort(); const controller = new AbortController(); runtime.frameRequest = controller; runtime.framePending = true; const version = ++runtime.frameVersion;
    try {
      statusText('#preview-state', 'Обновляем экран…'); const response = await fetch(`/api/preview/frame?scenario=${encodeURIComponent(runtime.scenario)}`, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) { let result = {}; try { result = await response.json(); } catch {} throw new Error(result.error || `Ошибка нативного предпросмотра (${response.status})`); }
      const width = Number(response.headers.get('X-Width')), height = Number(response.headers.get('X-Height')); if (width !== 240 || height !== 296) throw new Error('Размер нативного экрана должен быть 240 × 296');
      const rgb = new Uint8Array(await response.arrayBuffer()); if (version !== runtime.frameVersion) return;
      runtime.frame = new ImageData(rgbToRgba(rgb, width, height), width, height); paintFrame();
      if (response.headers.get('X-Preview-State-Reset') === 'true') statusText('#input-feedback', 'Состояние макета сброшено после изменения кода');
      const errorHeader = response.headers.get('X-Preview-Error'), previewError = !!errorHeader && errorHeader !== 'false' && errorHeader !== '0';
      const feedback = frameInputFeedback($('#input-feedback').textContent, { sourceHash: response.headers.get('X-Source-Hash'), expectedSourceHash: runtime.state?.sourceHash, previewError });
      if (feedback !== $('#input-feedback').textContent) statusText('#input-feedback', feedback);
      const headerLabel = response.headers.get('X-Preview-Data-Label'), label = headerLabel === 'Native application' ? 'Нативный интерфейс' : headerLabel || (response.headers.get('X-Preview-Demo') === 'true' ? 'Данные сценария' : 'Нативный интерфейс');
      statusText('#preview-state', previewError ? 'Ошибка исходника · показан последний удачный кадр' : `${$('#preview-scenario').selectedOptions[0].textContent} · ${label}`, previewError);
      $('#preview-error-details').hidden = !previewError;
      if (previewError) { playback.pause(); syncPlaybackControl(); const latest = await api('/api/state'); if (version !== runtime.frameVersion) return; renderState(latest); $('#preview-error').textContent = latest.preview?.diagnostics?.error || 'Новый исходник не удалось скомпилировать. Исправьте ошибку и обновите кадр.'; }
      $('#reaction-label').textContent = runtime.power ? previewError ? 'Последний удачный кадр · текущая версия не скомпилирована' : `Нативный рендер · V.${revision()} · 240 × 296` : 'Экран скрыт · только предпросмотр'; $('#preview-hash').textContent = `Кадр из исходников ${(response.headers.get('X-Source-Hash') || runtime.state?.sourceHash || '').slice(0, 12)}`;
    } catch (error) { if (!controller.signal.aborted) { playback.pause(); syncPlaybackControl(); statusText('#preview-state', runtime.frame ? 'Ошибка предпросмотра · сохранён последний кадр' : 'Нативный предпросмотр недоступен', true); $('#preview-error-details').hidden = false; $('#preview-error').textContent = errorText(error); await refreshState().catch(() => {}); } }
    finally { if (version === runtime.frameVersion) runtime.framePending = false; }
  }
  const playback = createPreviewPlayback({ render: refreshFrame, isBusy: () => runtime.framePending || runtime.inputPending > 0 || !runtime.online || !runtime.power || runtime.flashing, isVisible: () => {
    const bounds = canvas.getBoundingClientRect(); return !document.hidden && $$('dialog[open]').every(dialog => dialog === previewDialog) && bounds.bottom > 0 && bounds.top < innerHeight;
  }, onError: report });
  function syncPlaybackControl() { $('#preview-play').setAttribute('aria-pressed', String(playback.playing)); $('#preview-play').setAttribute('aria-label', playback.playing ? 'Приостановить предпросмотр: 1 кадр в секунду' : 'Запустить предпросмотр: 1 кадр в секунду'); $('#preview-play').textContent = playback.playing ? 'Ⅱ 1 кадр/с' : '▶ 1 кадр/с'; }
  $('#preview-play').addEventListener('click', () => { if (playback.playing) playback.pause(); else playback.play(); syncPlaybackControl(); });
  function resizeExpandedPreview() {
    if (!previewDialog.open) return;
    const bounds = $('.preview-stage').getBoundingClientRect(), scale = Math.max(.35, Math.min(2.5, (bounds.width - 100) / 240, (bounds.height - 92) / 296));
    $('#device-shell').style.setProperty('--device-scale', String(scale));
  }
  function expandPreview() {
    if (previewDialog.open) { previewDialog.close(); return; }
    previewBodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; previewDialog.append(previewPane); $('#expand-preview').textContent = 'Свернуть ↙'; $('#expand-preview').setAttribute('aria-expanded', 'true'); previewDialog.showModal(); resizeExpandedPreview(); canvas.focus();
  }
  previewDialog.addEventListener('close', () => { pointer = null; canvas.classList.remove('is-gesturing'); document.body.style.overflow = previewBodyOverflow; previewHome.after(previewPane); $('#device-shell').style.removeProperty('--device-scale'); $('#expand-preview').textContent = 'Развернуть ↗'; $('#expand-preview').setAttribute('aria-expanded', 'false'); $('#expand-preview').focus(); });
  const previewResize = new ResizeObserver(resizeExpandedPreview); previewResize.observe($('.preview-stage'));
  $('#expand-preview').addEventListener('click', expandPreview);
  async function nativeInput(input, origin = 'Экран') {
    if (!runtime.power || !runtime.online) { statusText('#input-feedback', runtime.power ? 'Нет связи с локальным Studio' : 'Включите экран предпросмотра, чтобы проверить жест', true); return; }
    const projectId = runtime.state?.project?.id;
    runtime.inputPending++; inputQueue = inputQueue.catch(() => {}).then(async () => {
      if (runtime.state?.project?.id !== projectId) return;
      statusText('#input-feedback', `${origin} · проверяем действие…`);
      const result = await api('/api/preview/input', { method: 'POST', body: input });
      if (runtime.state?.project?.id !== projectId) return;
      const descriptions = { nextScreen: 'Следующий экран', previousScreen: 'Предыдущий экран', openModule: 'Открыт пример модуля', closeModule: 'Закрыт пример модуля', toggle: 'Переключено состояние примера', select: 'Выбран пункт приложения', home: 'Открыт главный экран', modules: 'Открыты модули', settings: 'Открыты настройки', openModules: 'Открыты модули', openSettings: 'Открыты настройки', showHome: 'Открыт главный экран' };
      const noAction = input.type === 'swipe' ? 'Жест передан приложению; экран не изменился' : input.type === 'tap' ? 'В этой точке экрана нет действия' : 'Приложение не изменило экран';
      const action = result.action && result.action !== 'none' ? descriptions[result.action] || `Действие приложения: ${result.action}` : noAction;
      statusText('#input-feedback', `${origin} · ${action}`); await refreshFrame();
    }).catch(error => { statusText('#input-feedback', errorText(error), true); throw error; }).finally(() => { runtime.inputPending--; });
    return inputQueue;
  }
  function connectEvents() {
    runtime.stream?.close(); const events = new EventSource('/api/events'); runtime.stream = events;
    events.addEventListener('open', () => refreshState().catch(report)); events.addEventListener('error', disconnected);
    for (const type of ['state', 'chat.delta', 'chat.completed', 'chat.status', 'chat.error', 'chat.tool', 'preview.updated', 'build.progress', 'build.completed', 'approval.request']) events.addEventListener(type, event => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (type === 'state') { stateRequestVersion++; renderState(data.state || data); return; }
      if (type === 'chat.delta') { const key = data.itemId || data.turnId || 'active'; if (!runtime.delta || key !== runtime.deltaKey) { runtime.delta = messageNode({ role: 'assistant', text: '' }); runtime.deltaKey = key; $('#conversation .chat-empty')?.remove(); $('#conversation').append(runtime.delta); } runtime.delta.querySelector('p').textContent += data.text || data.delta || ''; $('#conversation').scrollTop = $('#conversation').scrollHeight; return; }
      if (type === 'preview.updated') { if (!runtime.inputPending) refreshFrame(); return; }
      if (type === 'approval.request') { showAgentApproval(data); return; }
      if (type === 'chat.error') notice(data.error?.message || data.error || data.text || 'Codex сообщил об ошибке', true);
      if (type === 'chat.completed' || type === 'chat.error') { runtime.delta = null; runtime.deltaKey = null; }
      if (type === 'chat.tool') statusText('#composer-status', data.text || `Codex: ${data.tool || 'работает с проектом'}`);
      clearTimeout(runtime.stateRefresh); runtime.stateRefresh = setTimeout(() => refreshState().catch(report), 100);
    });
  }
  async function sendMessage(text, { includePhotos = false } = {}) {
    if (runtime.pendingSend || runtime.state?.chat?.busy || !runtime.state?.chat?.ready || !runtime.state?.chat?.authenticated) return;
    const projectId = runtime.state?.project?.id;
    const selection = includePhotos ? window.studio?.attachments?.snapshot(projectId) || { projectId, ids: [], blocked: false } : { projectId, ids: [], blocked: false };
    if (selection.blocked) throw new Error('Дождитесь добавления фото или уберите изображения с ошибкой.');
    if (!text.trim() && !selection.ids.length) return;
    runtime.pendingSend = true; renderComposerControls();
    try { await api('/api/chat', { method: 'POST', body: { text: text.trim(), ...(selection.ids.length ? { attachments: selection.ids } : {}) } }); if (includePhotos) { window.studio?.attachments?.consume(selection); projectDrafts.clear(projectId); if (runtime.state?.project?.id === projectId) $('#chat-input').value = ''; } await refreshState(); } finally { runtime.pendingSend = false; if (runtime.state) renderState(runtime.state); }
  }
  async function projectReady() {
    const guard = projectSwitchStatus(runtime); if (!guard.allowed || runtime.readyPreparing || runtime.buildPreparing) throw new Error(guard.reason || 'Дождитесь текущего действия.');
    if (!runtime.state?.chat?.ready || !runtime.state.chat.authenticated) throw new Error('Подключите ChatGPT перед созданием кода.');
    runtime.readyPreparing = true; renderState(runtime.state);
    try { return await requestProjectCode({ getState: () => runtime.state, api, refresh: refreshState, send: text => sendMessage(text) }); }
    finally { runtime.readyPreparing = false; if (runtime.state) renderState(runtime.state); }
  }
  function showChecks(result) { $('#check-detail').hidden = false; $('#check-detail').textContent = (result.checks || []).map(check => `${check.passed ? '✓' : '×'} ${check.name}${check.detail ? `: ${check.detail}` : ''}`).join('\n') || (result.passed ? 'Проверки выполнены' : 'Проверки не пройдены'); $('#check-detail').classList.toggle('is-error', !result.passed); }
  function showAgentApproval(data) {
    if (data.requestId === undefined || data.requestId === null || approvals.has(data.requestId)) return;
    const card = document.createElement('article'); card.className = 'message runtime-approval'; const text = document.createElement('p'); text.textContent = data.description || `Codex запрашивает действие: ${data.kind || 'подтверждение'}`; card.append(text);
    for (const [decision, label] of [['accept', 'Разрешить это действие'], ['decline', 'Отклонить']]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', run(async () => { await api('/api/approvals', { method: 'POST', body: { requestId: data.requestId, decision } }); approvals.delete(data.requestId); card.remove(); await refreshState(); })); card.append(button); } approvals.set(data.requestId, card); $('#conversation').append(card);
  }
  async function loadSource(path) {
    const request = ++runtime.sourceRequest; runtime.sourceLoading = true; runtime.source = null; $('#source-save').disabled = true; $('#source-content').readOnly = true; statusText('#source-status', 'Загружаем исходник…');
    try { const file = await api(`/api/source?path=${encodeURIComponent(path)}`); if (request !== runtime.sourceRequest) return; runtime.source = file; runtime.sourceDirty = false; sourceDrafts.delete(runtime.state?.project?.id); $('#source-content').value = file.content; $('#source-content').readOnly = !file.editable; $('#source-sha').textContent = `SHA-256 ${file.sha256}`; statusText('#source-status', file.editable ? 'Можно редактировать · сохранение создаст новую версию' : 'Защищённый файл · драйверы и платформа только для чтения'); $('#source-conflict').hidden = true; }
    finally { if (request === runtime.sourceRequest) { runtime.sourceLoading = false; $('#source-save').disabled = true; } }
  }
  async function saveSource() {
    const file = runtime.source; if (!file?.editable || !runtime.sourceDirty) return; $('#source-save').disabled = true;
    try { await api('/api/source', { method: 'POST', body: { path: file.path, content: $('#source-content').value, expectedSha256: file.sha256 } }); invalidateFlash('Исходник сохранён. Нужна новая сборка и новый план.'); await refreshState(); await loadSource(file.path); await refreshFrame(); notice('Исходник сохранён'); }
    catch (error) { statusText('#source-status', errorText(error), true); $('#source-conflict').hidden = error.status !== 409; $('#source-save').disabled = false; }
  }
  async function prepareFlash() {
    if (runtime.flashPreparing || runtime.flashing) return; runtime.flashPreparing = true; invalidateFlash(); renderFlashControls();
    try {
      statusText('#flash-status', 'Проверяем текущую сборку, SHA-256 и полный план установки Киби…');
      const { plan, state: latest, artifact } = await prepareCurrentInstall({ refresh: refreshState, device: runtime.flasher.device, flasherApi: runtime.flasherApi, flasher: runtime.flasher, fetcher: fetch, parsePartitions, validateLocalPartitions, approval: gate });
      $('#flash-plan').hidden = false; $('#flash-revision').textContent = `${latest.project.name || 'Киби'} · V.${latest.revision} · ${artifact.size.toLocaleString('ru-RU')} байт`;
      $('#flash-sha').textContent = artifact.sha256; $('#flash-source-hash').textContent = latest.sourceHash;
      $('#flash-ranges').textContent = plan.files.map(item => `${item.name}: 0x${item.offset.toString(16)} · ${item.data.length.toLocaleString('ru-RU')} байт`).join('\n'); $('#flash-impact').textContent = plan.dataWarning;
      statusText('#flash-status', 'План подготовлен. Проверьте точную сборку и подтвердите установку. Запись ещё не началась.');
    } catch (error) { invalidateFlash(); statusText('#flash-status', errorText(error), true); } finally { runtime.flashPreparing = false; renderFlashControls(); }
  }
  function connectDevice() {
    // requestPort stays in the original click activation; the library is preloaded.
    if (!runtime.flasher || runtime.connecting || runtime.connected || runtime.flashing || runtime.flashPreparing) return; runtime.connecting = true; $('#connect-device').disabled = true; statusText('#device-summary', 'Подключаемся к ROM-загрузчику…');
    const connection = runtime.flasher.connect(); connection.then(info => { runtime.connected = true; statusText('#device-summary', `${info.chip} · ${info.flashBytes / 1048576} МиБ · ${info.mac}`); }).catch(error => { runtime.connected = false; statusText('#device-summary', errorText(error), true); }).finally(() => { runtime.connecting = false; renderFlashControls(); });
  }
  async function disconnectDevice() { invalidateFlash('Порт отключён. Подключите Киби и подготовьте план заново.'); await runtime.flasher?.disconnect(); runtime.connected = false; statusText('#device-summary', 'Киби не подключён'); renderFlashControls(); }
  async function writeFirmware() {
    if (runtime.flashing || !gate.approved || !gate.valid(runtime.state)) return; runtime.flashing = true; renderFlashControls(); renderState(runtime.state);
    let submittedToFlasher = false;
    try {
      const latest = await refreshState(), plan = gate.take(latest); $('#flash-confirm').checked = false; $('#flash-progress').hidden = false; $('#flash-progress').value = 0; statusText('#flash-status', 'Записываем утверждённую сборку. Оставьте кабель подключённым и страницу открытой.');
      submittedToFlasher = true; const result = await runtime.flasher.write(plan); if (!result.verified) throw new Error('Запись не подтверждена чтением'); $('#flash-progress').value = 100; statusText('#flash-status', 'Запись сверена чтением и SHA-256. Перезапустите Киби вручную. Запуск приложения ещё не проверен.');
    } catch (error) { statusText('#flash-status', `${errorText(error)} ${submittedToFlasher ? 'Запись могла остаться частичной; подключитесь в режиме ROM и подготовьте установку заново.' : 'Запись не начиналась. Подготовьте установку заново.'}`, true); }
    finally { await runtime.flasher.disconnect().catch(() => {}); runtime.connected = false; runtime.flashing = false; invalidateFlash(); statusText('#device-summary', 'Порт отключён. Для следующей установки подключитесь заново.'); renderState(runtime.state); }
  }
  $('#chat-form').addEventListener('submit', run(async event => { event.preventDefault(); await sendMessage($('#chat-input').value, { includePhotos: true }); }));
  $('#chat-input').addEventListener('input', renderComposerControls);
  $('#chat-input').addEventListener('keydown', run(async event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); await sendMessage(event.target.value, { includePhotos: true }); } }));
  window.addEventListener('studio:attachments', () => { if (runtime.state) renderState(runtime.state); else renderComposerControls(); });
  $('#stop-chat').addEventListener('click', run(async () => { $('#stop-chat').disabled = true; await api('/api/chat/interrupt', { method: 'POST' }); await refreshState(); }));
  $('#reconnect-chat').addEventListener('click', run(async () => { await refreshState(); connectEvents(); }));
  $('#approve-button').addEventListener('click', run(async () => { await api('/api/design/approve', { method: 'POST', body: { revision: runtime.state.revision } }); await refreshState(); }));
  $('#request-changes').addEventListener('click', () => { $('#chat-input').focus(); $('#chat-input').placeholder = 'Что изменить во внешнем виде приложения Киби?'; });
  $('#code-request').addEventListener('click', run(() => sendMessage('Макет утверждён. Реализуй приложение Киби по согласованному макету. Используй базовый проект и добавляй только согласованные функции. Используй реальные исходники проекта, проверь нативный предпросмотр и доступные проверки. Сборку и запись на устройство я запущу отдельно.')));
  $$('[data-suggestion]').forEach(button => button.addEventListener('click', () => { $('#chat-input').value = button.dataset.suggestion; $('#chat-input').focus(); renderComposerControls(); }));
  $('#plus-button').addEventListener('click', run(() => nativeInput({ type: 'plus' }, 'Кнопка +'))); $('#minus-button').addEventListener('click', run(() => nativeInput({ type: 'minus' }, 'Кнопка −')));
  $('#power-button').addEventListener('click', () => { runtime.power = !runtime.power; if (!runtime.power) { playback.pause(); syncPlaybackControl(); } $('#power-button').setAttribute('aria-pressed', String(!runtime.power)); $('#power-button').setAttribute('aria-label', runtime.power ? 'Скрыть экран предпросмотра' : 'Показать экран предпросмотра'); $('#reaction-label').textContent = runtime.power ? `Нативный рендер · V.${revision()}` : 'Экран скрыт · только предпросмотр'; paintFrame(); });
  canvas.addEventListener('pointerdown', event => {
    if (pointer || event.button !== 0) return; event.preventDefault(); canvas.focus();
    pointer = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, at: event.timeStamp, bounds: canvas.getBoundingClientRect() }; canvas.setPointerCapture(event.pointerId); canvas.classList.add('is-gesturing');
  });
  canvas.addEventListener('pointerup', run(event => {
    if (!pointer || pointer.pointerId !== event.pointerId) return; const start = pointer; pointer = null; canvas.classList.remove('is-gesturing');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const input = pointerInput(start, { clientX: event.clientX, clientY: event.clientY, at: event.timeStamp }, start.bounds); return nativeInput(input, input.type === 'tap' ? 'Касание' : 'Свайп');
  }));
  canvas.addEventListener('pointercancel', event => { if (pointer?.pointerId === event.pointerId) { pointer = null; canvas.classList.remove('is-gesturing'); statusText('#input-feedback', 'Жест отменён'); } });
  canvas.addEventListener('wheel', event => {
    const input = wheelInput(event); if (!input) return; event.preventDefault(); const now = performance.now(); if (now - lastWheel < 350) return; lastWheel = now;
    nativeInput(input, 'Колесо / трекпад').catch(report);
  }, { passive: false });
  canvas.addEventListener('keydown', run(event => {
    if (event.repeat && ['ArrowLeft', 'ArrowRight', '+', '=', '-', '−', 'Enter', ' '].includes(event.key)) { event.preventDefault(); return; }
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); return nativeInput({ type: 'swipe', dx: event.key === 'ArrowLeft' ? -48 : 48, dy: 0, durationMs: 200 }, 'Клавиатура'); }
    if (['+', '=', '-', '−', 'Enter', ' '].includes(event.key)) { event.preventDefault(); return nativeInput({ type: ['-', '−'].includes(event.key) ? 'minus' : ['+', '='].includes(event.key) ? 'plus' : 'tap', x: 120, y: 148 }, 'Клавиатура'); }
  }));
  $('#preview-scenario').addEventListener('change', event => { runtime.scenario = event.target.value; refreshFrame(); }); $('#reset-reaction').addEventListener('click', () => refreshFrame());
  $('#open-source').addEventListener('click', run(async () => { $('#source-dialog').showModal(); if (!runtime.sourceDirty) await loadSource($('#source-path').value); })); $('#close-source').addEventListener('click', () => $('#source-dialog').close());
  $('#source-path').addEventListener('change', run(event => { if (runtime.sourceDirty && runtime.source) { event.target.value = runtime.source.path; statusText('#source-status', 'Сначала сохраните изменения или нажмите «Перечитать», чтобы их отменить.'); return; } return loadSource(event.target.value); })); $('#source-reload').addEventListener('click', run(() => loadSource($('#source-path').value)));
  $('#source-content').addEventListener('input', () => { runtime.sourceDirty = true; $('#source-save').disabled = !runtime.source?.editable || runtime.flashing || runtime.state?.chat?.busy; statusText('#source-status', 'Есть несохранённые изменения'); }); $('#source-save').addEventListener('click', run(saveSource));
  $('#build-ready').addEventListener('click', () => { if (currentBuildStatus(runtime.state).ready) { $('#flash-dialog').showModal(); renderFlashControls(); } else if (projectWorkflowView(runtime.state).canBuild) { $('#open-build').click(); $('#build-button').click(); } });
  $('#build-button').addEventListener('click', run(async () => {
    if (runtime.buildPreparing || !projectWorkflowView(runtime.state).canBuild) return; runtime.buildPreparing = true; runtime.buildError = ''; invalidateFlash('Начата новая сборка; подготовьте план после завершения.'); renderState(runtime.state);
    try { await buildCurrentProject({ getState: () => runtime.state, api, refresh: refreshState, onPhase: phase => { runtime.buildPhase = phase; renderState(runtime.state); }, onChecks: showChecks, onMissing: service => { runtime.buildError = service === 'wifi' ? 'Для этого приложения добавьте Wi-Fi в настройках.' : 'Для этого приложения добавьте API сервиса в настройках.'; $(`[data-settings-open="${service}"]`).click(); } }); }
    catch (error) { runtime.buildError = errorText(error); throw error; }
    finally { runtime.buildPreparing = false; runtime.buildPhase = ''; if (runtime.state) renderState(runtime.state); }
  }));
  $('#native-check').addEventListener('click', run(async () => { $('#native-check').disabled = true; try { showChecks(await api('/api/check', { method: 'POST' })); } finally { $('#native-check').disabled = false; } }));
  $('#build-reconnect').addEventListener('click', () => $('#cloud-reconnect').click());
  $('#open-flash').addEventListener('click', () => { $('#flash-dialog').showModal(); renderFlashControls(); }); $('#close-flash').addEventListener('click', () => $('#flash-dialog').close()); $('#flash-dialog').addEventListener('cancel', event => { if (runtime.flashing) event.preventDefault(); });
  $('#connect-device').addEventListener('click', connectDevice); $('#disconnect-device').addEventListener('click', run(disconnectDevice)); $('#prepare-flash').addEventListener('click', run(prepareFlash));
  $('#flash-confirm').addEventListener('change', run(event => { if (event.target.checked) gate.approve(runtime.state); else gate.approved = false; renderFlashControls(); })); $('#write-firmware').addEventListener('click', run(writeFirmware));
  window.addEventListener('beforeunload', event => { if (runtime.flashing || runtime.sourceDirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { playback.pause(); syncPlaybackControl(); runtime.stream?.close(); runtime.frameRequest?.abort(); previewResize.disconnect(); clearTimeout(runtime.buildPoll); clearTimeout(runtime.stateRefresh); runtime.flasher?.disconnect().catch(() => {}); });
  window.studio = { api, refresh: refreshState, invalidateFlash, getState: () => runtime.state, canSwitchProject: () => projectSwitchStatus(runtime), projectReady, notice }; initStudioAccountUI({api,mount:document.querySelector('.header-utilities')}); initServerModulesUI({api,mount:document.querySelector('.header-utilities')}); paintFrame();
  try { await refreshState(); connectEvents(); } catch (error) { disconnected(); statusText('#connection-detail', errorText(error), true); $('#connection-help').hidden = false; }
  // Preloading retains user activation for the later explicit USB connect click.
  try {
    runtime.flasherApi = await import('./vendor/kibi-flasher.js'); runtime.flasher = new runtime.flasherApi.KibiFlasher({ onLog: line => { const log = $('#flash-log'); log.textContent = `${log.textContent}\n${line}`.slice(-18000); log.scrollTop = log.scrollHeight; }, onProgress: (index, written, total) => { $('#flash-progress').value = total ? Math.round(written / total * 100) : 0; } });
    $('#usb-help').textContent = runtime.flasherApi.supportsUsb() ? 'Подключение откроет выбор USB-порта. Если окно не появляется во встроенном браузере, откройте этот localhost-адрес в Chrome или Edge.' : 'Для USB-прошивки откройте этот localhost-адрес в Chrome или Edge на компьютере. В этом браузере Web Serial недоступен; файл можно скачать.'; renderFlashControls();
  } catch (error) { statusText('#usb-help', `Модуль прошивки недоступен: ${errorText(error)}. Выполните npm run bundle:flasher.`, true); }
}
if (typeof document !== 'undefined') startStudio().catch(error => { console.error('Studio initialization failed', error.message); const status = document.querySelector('#connection-detail'); if (status) status.textContent = `Studio не запустился: ${error.message}`; });

// KIBI_FRESH_PUBLIC_UI_20261117
