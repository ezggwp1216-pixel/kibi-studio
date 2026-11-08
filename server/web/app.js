'use strict';

const $ = (id) => document.getElementById(id);
const state = { authenticated: false, csrf: '', overview: null, settings: null, loadedSettings: false, refreshing: false, timer: null, section: 'overview', messageTarget: null, confirmAction: null, refreshFailed: false };
const labels = { overview: 'Обзор', devices: 'Устройства', modules: 'Модули', guide: 'Инструкция' };
const errorMessages = {
  origin_forbidden: 'Адрес панели не совпадает с KIBI_PUBLIC_ORIGIN. Откройте настроенный адрес сервера.',
  csrf_forbidden: 'Защита сессии не прошла проверку. Обновите страницу и войдите снова.',
  message_limit: 'В очереди уже 50 сообщений. Дождитесь, пока устройство их заберёт.',
  invalid_telegram_credentials: 'Проверьте формат токена бота и Chat ID. Поля в форме сохранены.',
  ai_invalid_key: 'Проверьте формат API-ключа OpenAI. Поле в форме сохранено.',
  ai_auth_failed: 'OpenAI отклонил ключ. Проверьте его и доступ к выбранной модели.',
  ai_quota_exceeded: 'Лимит OpenAI исчерпан или слишком много запросов. Проверьте баланс и повторите позже.',
  ai_unavailable: 'Не удалось получить ответ OpenAI. Проверьте доступ к модели, сеть и настройки. Запрос мог израсходовать баланс.',
  server_busy: 'Сервер обрабатывает другие запросы. Подождите немного и повторите.',
  internal_error: 'Сервер не выполнил запрос. Проверьте его состояние и повторите.',
  invalid_password: 'Пароль не подошёл. Проверьте его и попробуйте снова.',
  unauthorized: 'Сессия завершилась. Войдите снова.',
  authentication_required: 'Сессия завершилась. Войдите снова.',
  invalid_origin: 'Адрес панели не совпадает с KIBI_PUBLIC_ORIGIN сервера. Откройте настроенный адрес или проверьте установку.',
  origin_required: 'Откройте панель по адресу, указанному в KIBI_PUBLIC_ORIGIN.',
  csrf_invalid: 'Защита сессии не прошла проверку. Обновите страницу и войдите снова.',
  invalid_csrf: 'Защита сессии не прошла проверку. Обновите страницу и войдите снова.',
  rate_limited: 'Слишком много запросов. Подождите немного и повторите.',
  too_many_requests: 'Слишком много запросов. Подождите немного и повторите.',
  invalid_input: 'Проверьте заполненные поля. Данные в форме сохранены.',
  device_limit: 'Достигнут лимит: 50 устройств. Сначала отзовите ненужное подключение.',
  devices_limit: 'Достигнут лимит: 50 устройств. Сначала отзовите ненужное подключение.',
  queue_full: 'В очереди уже 50 сообщений. Дождитесь, пока устройство их заберёт.',
  device_not_found: 'Устройство не найдено или его токен уже отозван. Обновите список.',
  telegram_not_configured: 'Сначала сохраните токен бота и Chat ID.',
  telegram_disabled: 'Telegram выключен. Включите отправку и сохраните настройки перед проверкой.',
  telegram_failed: 'Telegram не подтвердил отправку. Проверьте ключи, доступ бота к чату и сеть, затем повторите.',
  telegram_error: 'Telegram не подтвердил отправку. Проверьте ключи, доступ бота к чату и сеть, затем повторите.',
  telegram_timeout: 'Telegram не ответил вовремя. Проверьте чат перед повтором: сообщение могло быть доставлено.',
  ai_not_configured: 'Сначала сохраните API-ключ OpenAI.',
  ai_disabled: 'Текстовый ИИ выключен. Включите его и сохраните настройки перед проверкой.',
  ai_failed: 'OpenAI не подтвердил запрос. Проверьте ключ, доступ к модели, баланс аккаунта и сеть.',
  ai_timeout: 'OpenAI не ответил вовремя. Попробуйте позже. Запрос мог израсходовать баланс.',
  ai_invalid_response: 'Не удалось получить текст ответа OpenAI. Попробуйте другую доступную модель.',
  not_found: 'Запрошенный объект не найден. Обновите данные панели.',
  body_too_large: 'Слишком большой запрос. Сократите текст и повторите.',
  network_error: 'Не удалось связаться с сервером. Проверьте соединение и повторите. Данные в форме сохранены.',
  request_timeout: 'Сервер не ответил вовремя. Проверьте результат перед повтором: действие могло выполниться.',
  server_error: 'Сервер не выполнил запрос. Попробуйте ещё раз. Данные в форме сохранены.'
};

class ApiError extends Error {
  constructor(code, status = 0) { super(errorMessages[code] || 'Запрос не выполнен. Проверьте настройки и повторите. Данные в форме сохранены.'); this.code = code; this.status = status; }
}
async function api(path, { method = 'GET', body, timeout = 45000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') { headers['X-CSRF-Token'] = state.csrf; if (body !== undefined) headers['Content-Type'] = 'application/json'; }
    const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    let data;
    try { data = await response.json(); } catch { throw new ApiError('server_error', response.status); }
    if (!response.ok || data.ok === false) {
      if (response.status === 401 && path !== '/api/login') showLogin('Сессия завершилась. Войдите снова.');
      throw new ApiError(path === '/api/login' && response.status === 401 ? 'invalid_password' : (data.code || 'server_error'), response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError' ? 'request_timeout' : 'network_error');
  } finally { clearTimeout(timer); }
}
function feedback(id, text, isError = false) { const el = $(id); el.textContent = text; el.classList.toggle('error', isError); el.classList.toggle('success', !!text && !isError); }
function announce(text, isError = false, retry = false) { $('global-message').hidden = false; $('global-message-text').textContent = text; $('global-message').classList.toggle('error-message', isError); $('retry').hidden = !retry; }
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function action(text, className, callback) { const el = node('button', className, text); el.type = 'button'; el.addEventListener('click', callback); return el; }
function openDialog(id) { $(id).showModal(); }
function closeDialog(id) { $(id).close(); }
async function pending(button, task) { if (button.disabled) return; const dialog = button.closest('dialog'); if (dialog) dialog.dataset.pending = 'true'; const before = button.textContent; button.disabled = true; button.textContent = 'Выполняем…'; button.setAttribute('aria-busy', 'true'); try { return await task(); } finally { button.disabled = false; button.textContent = before; button.removeAttribute('aria-busy'); if (dialog) delete dialog.dataset.pending; } }
function setSection(id, { focus = true, updateHash = true } = {}) {
  if (!labels[id]) id = 'overview'; state.section = id;
  for (const button of document.querySelectorAll('[data-section]')) { const selected = button.dataset.section === id; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; $(button.dataset.section).hidden = !selected; }
  $('breadcrumb').textContent = `/ ${labels[id]}`; document.title = `${labels[id]} — Киби Сервер`;
  if (updateHash && location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (focus) $('main').focus({ preventScroll: true });
}
function showLogin(message = '') {
  state.authenticated = false; state.csrf = ''; state.settings = null; state.overview = null; state.loadedSettings = false;
  $('ai-form').reset(); $('telegram-form').reset(); delete $('ai-form').dataset.dirty; delete $('telegram-form').dataset.dirty;
  clearInterval(state.timer); state.timer = null;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('device-token').value = ''; $('ai-key').value = ''; $('telegram-token').value = ''; $('telegram-chat').value = ''; $('ai-output').textContent = ''; $('ai-output').hidden = true;
  $('app').hidden = true; $('login-screen').hidden = false; document.title = 'Вход — Киби Сервер';
  $('device-list').replaceChildren(); $('event-list').replaceChildren();
  $('global-message').hidden = true; feedback('login-error', message, !!message); $('admin-password').setAttribute('aria-invalid', String(!!message));
  if (message) $('admin-password').focus();
}
async function enterApp(csrf) {
  state.authenticated = true; state.csrf = csrf; $('login-screen').hidden = true; $('app').hidden = false; $('admin-password').value = ''; feedback('login-error', '');
  setSection(location.hash.slice(1), { focus: false });
  await refreshData();
  if (state.authenticated) { clearInterval(state.timer); state.timer = setInterval(() => { if (!document.hidden && state.authenticated) refreshData(true); }, 15000); }
}
function formatDate(value, short = false) { if (!value) return 'Ещё не выходило на связь'; const date = new Date(value); if (!Number.isFinite(date.getTime())) return 'Время неизвестно'; return new Intl.DateTimeFormat('ru-RU', short ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); }
function duration(seconds) { seconds = Math.max(0, Math.floor(Number(seconds) || 0)); const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds / 3600) % 24; const minutes = Math.floor(seconds / 60) % 60; if (days) return `${days} д ${hours} ч`; if (hours) return `${hours} ч ${minutes} м`; return `${minutes} мин`; }
function empty(title, text, buttonText, callback) { const el = node('div', 'empty-state'); el.append(node('span', 'empty-glyph', '↳'), node('h3', '', title), node('p', '', text)); el.firstChild.setAttribute('aria-hidden', 'true'); if (buttonText) el.append(action(buttonText, 'text-button', callback)); return el; }
function renderOverview() {
  const data = state.overview; if (!data) return;
  const ready = data.server.status === 'ready'; $('server-status').textContent = ready ? 'Готов к работе' : 'Проверьте состояние';
  $('server-detail').textContent = `Версия ${data.server.version} · ${ready ? 'Доступен · модули настраиваются отдельно' : 'Сервер сообщил о проблеме'}`;
  $('footer-version').textContent = data.server.version; $('device-count').textContent = data.devices.length; $('event-count').textContent = data.events.length; $('uptime').textContent = duration(data.server.uptimeSeconds);
  renderEvents(data.events); renderDevices(data.devices); renderModuleSummary(data.modules);
}
function renderEvents(events) {
  const list = $('event-list'); list.setAttribute('aria-busy', 'false'); list.replaceChildren();
  if (!events.length) { list.append(empty('Пока тихо. Это начало.', 'Подключите устройство или создайте тестовое событие. Все настоящие события появятся здесь.', 'Создать тестовое событие', openEvent)); return; }
  const devices = new Map(state.overview.devices.map((device) => [device.id, device.name]));
  for (const event of events) { const item = node('article', 'event-item'); const mark = node('span', 'event-mark', '↳'); mark.setAttribute('aria-hidden', 'true'); const body = node('div'); const heading = node('div', 'event-heading'); const time = node('time', '', formatDate(event.createdAt, true)); time.dateTime = event.createdAt || ''; heading.append(node('h3', '', event.title), time); body.append(heading); if (event.message) body.append(node('p', '', event.message)); const detail = node('div', 'event-detail'); detail.append(node('span', '', event.deviceId ? devices.get(event.deviceId) || 'Устройство с отозванным токеном' : 'Панель сервера')); const delivery = { local: 'Сохранено на сервере', telegram_sent: 'Отправлено в Telegram', telegram_failed: 'Telegram: не доставлено' }; detail.append(node('span', event.delivery === 'telegram_failed' ? 'danger' : '', delivery[event.delivery] || 'Статус доставки неизвестен')); body.append(detail); item.append(mark, body); list.append(item); }
}
function renderDevices(devices) {
  const list = $('device-list'); list.setAttribute('aria-busy', 'false'); list.replaceChildren();
  if (!devices.length) { list.append(empty('Здесь будет ваша Киби.', 'Добавьте устройство, сохраните его токен и передайте приложению. Готовых подключений пока нет.', 'Добавить устройство ↗', openCreate)); return; }
  const statuses = { not_seen: ['Ожидает подключения', 'neutral'], online: ['Онлайн', ''], offline: ['Не на связи', 'neutral'] };
  for (const device of devices) { const row = node('article', 'device-row'); const info = node('div', 'device-info'); const icon = node('span', 'device-icon', '⌁'); icon.setAttribute('aria-hidden', 'true'); const copy = node('div'); copy.append(node('h2', '', device.name)); const meta = node('div', 'device-meta'); const [status, className] = statuses[device.status] || ['Статус неизвестен', 'neutral']; meta.append(node('span', `status-label ${className}`, status), node('span', '', device.lastSeenAt ? `Было на связи: ${formatDate(device.lastSeenAt, true)}` : 'Первого запроса ещё не было')); copy.append(meta); info.append(icon, copy); const actions = node('div', 'device-actions'); actions.append(action('Отправить сообщение ↗', 'button secondary', () => openMessage(device)), action('Отозвать токен', 'text-button danger', () => confirmRevoke(device))); row.append(info, actions); list.append(row); }
}
function renderModuleSummary(modules) {
  const notifications = modules.find((module) => module.id === 'notifications'); $('notifications-status').textContent = notifications?.status === 'ready' ? 'Работает' : 'Недоступен'; $('notifications-status').className = `status-label${notifications?.status === 'ready' ? '' : ' neutral'}`;
  const container = $('module-summary-list'); container.replaceChildren();
  for (const module of modules) { const row = node('div', 'summary-row'); const names = { notifications: 'Уведомления', telegram: 'Telegram', ai: 'Текстовый ИИ', voice: 'Голосовой ИИ', schedules: 'Расписания' }; let status = module.status === 'ready' ? 'Работает' : module.status === 'configured' ? 'Настроен' : module.status === 'planned' ? 'В планах' : 'Не настроен'; let ready = module.status === 'ready'; const setting = state.settings?.[module.id]; if (setting) { status = setting.configured ? (setting.enabled ? 'Включён' : 'Выключен') : 'Не настроен'; ready = setting.configured && setting.enabled; } row.append(node('span', '', names[module.id] || module.name), node('span', `summary-state${ready ? ' ready' : ''}`, status)); container.append(row); }
}
function renderSettings(fillForms = false) {
  if (!state.settings) return;
  const telegram = state.settings.telegram; const ai = state.settings.ai;
  function status(id, value) { $(id).textContent = value.configured ? (value.enabled ? 'Включён' : 'Настроен · выключен') : 'Не настроен'; $(id).className = `status-label${value.configured && value.enabled ? '' : ' neutral'}`; }
  if (telegram) { status('telegram-status', telegram); $('telegram-delete').hidden = !telegram.configured; if (fillForms && !$('telegram-form').dataset.dirty) $('telegram-enabled').checked = telegram.enabled; }
  if (ai) { status('ai-status', ai); $('ai-delete').hidden = !ai.configured; if (fillForms && !$('ai-form').dataset.dirty) { $('ai-enabled').checked = ai.enabled; $('ai-model').value = ai.model || 'gpt-5-mini'; $('ai-prompt').value = ai.systemPrompt || ''; } }
  if (state.overview) renderModuleSummary(state.overview.modules);
}
async function refreshData(silent = false) {
  if (!state.authenticated || state.refreshing) return;
  state.refreshing = true; const wasFailed = state.refreshFailed; $('refresh').disabled = true; if (!silent) $('sync-status').textContent = 'Обновляем…';
  const results = await Promise.allSettled([api('/api/overview'), api('/api/settings')]);
  state.refreshing = false; $('refresh').disabled = false; if (!state.authenticated) return;
  const errors = [];
  if (results[0].status === 'fulfilled') { state.overview = results[0].value; renderOverview(); } else errors.push(results[0].reason);
  if (results[1].status === 'fulfilled') { state.settings = results[1].value; renderSettings(!state.loadedSettings); state.loadedSettings = true; } else errors.push(results[1].reason);
  if (errors.length) { state.refreshFailed = true; $('sync-status').textContent = 'Связь прервана'; $('server-status').textContent = state.overview ? 'Данные могли устареть' : 'Нет связи с сервером'; $('server-detail').textContent = 'Проверьте подключение и обновите данные.'; if (!state.overview) { $('event-list').replaceChildren(empty('Не удалось загрузить события', 'Проверьте подключение к серверу.', 'Повторить', () => refreshData())); $('device-list').replaceChildren(empty('Не удалось загрузить устройства', 'Список появится после восстановления связи.', 'Повторить', () => refreshData())); } if (!silent || !wasFailed) announce(errors[0].message, true, true); }
  else { state.refreshFailed = false; $('sync-status').textContent = `Обновлено ${new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`; if (wasFailed) announce('Связь восстановлена. Данные обновлены.'); }
}
function openCreate() { feedback('device-feedback', ''); openDialog('device-dialog'); $('device-name').focus(); }
function openMessage(device) { state.messageTarget = device.id; $('message-dialog-title').textContent = `Для ${device.name}`; $('message-dialog-kicker').textContent = 'СООБЩЕНИЕ УСТРОЙСТВУ'; $('message-explanation').textContent = 'Сообщение попадёт в очередь. Устройство получит его при следующем запросе и должно подтвердить получение. Постановка в очередь не означает доставку.'; $('message-submit').textContent = 'Поставить в очередь'; feedback('message-feedback', ''); openDialog('message-dialog'); $('message-title').focus(); }
function openEvent() { state.messageTarget = null; $('message-dialog-title').textContent = 'Проверить событие'; $('message-dialog-kicker').textContent = 'ТЕСТ СЕРВЕРА'; $('message-explanation').textContent = 'Событие появится в ленте сервера. Если Telegram включён, это действие отправит реальное сообщение в ваш сохранённый чат.'; $('message-submit').textContent = 'Создать событие'; feedback('message-feedback', ''); openDialog('message-dialog'); $('message-title').focus(); }
function confirmAction(title, description, buttonText, callback) { $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-action').textContent = buttonText; feedback('confirm-feedback', ''); state.confirmAction = callback; openDialog('confirm-dialog'); }
function confirmRevoke(device) { confirmAction(`Отозвать токен «${device.name}»?`, 'Устройство потеряет доступ к серверу, а его очередь сообщений будет удалена. Для нового подключения потребуется создать устройство заново.', 'Отозвать токен', async () => { await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }); announce(`Токен «${device.name}» отозван.`); await refreshData(); }); }
async function copyText(text, button, feedbackId) {
  try { if (!navigator.clipboard?.writeText) throw new Error('no_clipboard'); await navigator.clipboard.writeText(text); if (feedbackId) feedback(feedbackId, 'Скопировано. Сохраните в безопасном месте.'); else { const before = button.textContent; button.textContent = 'Скопировано ✓'; setTimeout(() => { button.textContent = before; }, 2500); } }
  catch { if (feedbackId) { $('device-token').focus(); $('device-token').select(); feedback(feedbackId, 'Браузер не разрешил копирование. Токен выделен: скопируйте его вручную.', true); } else { const source = $(button.dataset.copy); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(source); selection.removeAllRanges(); selection.addRange(range); announce('Браузер не разрешил копирование. Текст выделен: скопируйте его вручную.'); } }
}

for (const button of document.querySelectorAll('[data-section]')) button.addEventListener('click', () => setSection(button.dataset.section, { focus: false }));
const tabs = Array.from(document.querySelectorAll('[data-section]'));
for (const tab of tabs) tab.addEventListener('keydown', (event) => { let index = tabs.indexOf(tab); if (['ArrowDown', 'ArrowRight'].includes(event.key)) index = (index + 1) % tabs.length; else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) index = (index - 1 + tabs.length) % tabs.length; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = tabs.length - 1; else return; event.preventDefault(); tabs[index].focus(); setSection(tabs[index].dataset.section, { focus: false }); });
for (const button of document.querySelectorAll('[data-go]')) button.addEventListener('click', () => setSection(button.dataset.go));
for (const button of document.querySelectorAll('[data-action="create-device"]')) button.addEventListener('click', openCreate);
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => { if (!$(button.dataset.close).dataset.pending) closeDialog(button.dataset.close); });
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('cancel', (event) => { if (dialog.dataset.pending) event.preventDefault(); });
for (const id of ['telegram-form', 'ai-form']) $(id).addEventListener('input', () => { $(id).dataset.dirty = 'true'; });
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', () => copyText($(button.dataset.copy).textContent, button));
window.addEventListener('hashchange', () => { if (state.authenticated) setSection(location.hash.slice(1), { updateHash: false }); });
$('token-dialog').addEventListener('close', () => { $('device-token').value = ''; feedback('token-feedback', ''); });
$('confirm-dialog').addEventListener('close', () => { state.confirmAction = null; });
$('copy-token').addEventListener('click', () => copyText($('device-token').value, $('copy-token'), 'token-feedback'));
$('create-event').addEventListener('click', openEvent);
$('dismiss-message').addEventListener('click', () => { $('global-message').hidden = true; });
$('refresh').addEventListener('click', () => refreshData()); $('retry').addEventListener('click', () => refreshData());
$('login-form').addEventListener('submit', (event) => { event.preventDefault(); pending(event.submitter, async () => { feedback('login-error', ''); $('admin-password').setAttribute('aria-invalid', 'false'); try { const data = await api('/api/login', { method: 'POST', body: { password: $('admin-password').value } }); await enterApp(data.csrfToken); $('main').focus(); } catch (error) { feedback('login-error', error.message, true); $('admin-password').setAttribute('aria-invalid', 'true'); $('admin-password').focus(); } }); });
$('logout').addEventListener('click', () => pending($('logout'), async () => { try { await api('/api/logout', { method: 'POST' }); showLogin(); $('admin-password').focus(); } catch (error) { if (state.authenticated) announce(error.message, true); } }));
$('device-form').addEventListener('submit', (event) => { event.preventDefault(); const name = $('device-name').value.trim(); if (!name) { feedback('device-feedback', 'Введите название устройства.', true); $('device-name').focus(); return; } pending(event.submitter, async () => { feedback('device-feedback', ''); try { const data = await api('/api/devices', { method: 'POST', body: { name } }); closeDialog('device-dialog'); $('device-form').reset(); $('device-token').value = data.token; openDialog('token-dialog'); $('copy-token').focus(); await refreshData(); } catch (error) { feedback('device-feedback', error.message, true); } }); });
$('message-form').addEventListener('submit', (event) => { event.preventDefault(); const title = $('message-title').value.trim(); if (!title) { feedback('message-feedback', 'Введите заголовок.', true); $('message-title').focus(); return; } const target = state.messageTarget; pending(event.submitter, async () => { feedback('message-feedback', ''); try { const data = await api(target === null ? '/api/events' : `/api/devices/${encodeURIComponent(target)}/messages`, { method: 'POST', body: { title, message: $('message-body').value } }); closeDialog('message-dialog'); $('message-form').reset(); if (target !== null) announce('Сообщение поставлено в очередь устройства. Подтверждение доставки пока не получено.'); else announce(data.event?.delivery === 'telegram_failed' ? 'Событие сохранено. Telegram не подтвердил доставку; проверьте настройки модуля.' : data.event?.delivery === 'telegram_sent' ? 'Событие сохранено и отправлено в Telegram.' : 'Событие сохранено на сервере.', data.event?.delivery === 'telegram_failed'); await refreshData(); } catch (error) { feedback('message-feedback', error.message, true); } }); });
$('confirm-action').addEventListener('click', () => pending($('confirm-action'), async () => { try { if (state.confirmAction) await state.confirmAction(); closeDialog('confirm-dialog'); } catch (error) { feedback('confirm-feedback', error.message, true); } }));
$('telegram-form').addEventListener('submit', (event) => { event.preventDefault(); if (!state.settings) { feedback('telegram-feedback', 'Настройки ещё не загружены. Нажмите «Обновить» и повторите.', true); return; } const token = $('telegram-token').value.trim(); const chatId = $('telegram-chat').value.trim(); if (!state.settings?.telegram?.configured && (!token || !chatId)) { feedback('telegram-feedback', 'Для первого подключения укажите токен бота и Chat ID.', true); (!token ? $('telegram-token') : $('telegram-chat')).focus(); return; } pending(event.submitter, async () => { feedback('telegram-feedback', ''); try { const result = await api('/api/settings/telegram', { method: 'POST', body: { token, chatId, enabled: $('telegram-enabled').checked } }); state.settings.telegram = result.telegram; $('telegram-token').value = ''; $('telegram-chat').value = ''; renderSettings(); feedback('telegram-feedback', 'Настройки сохранены. Проверка не отправлялась.'); } catch (error) { feedback('telegram-feedback', error.message, true); } }); });
$('telegram-test').addEventListener('click', () => pending($('telegram-test'), async () => { feedback('telegram-feedback', ''); try { await api('/api/modules/telegram/test', { method: 'POST' }); feedback('telegram-feedback', 'Telegram подтвердил отправку проверки в сохранённый чат.'); } catch (error) { feedback('telegram-feedback', error.message, true); } }));
$('telegram-delete').addEventListener('click', () => confirmAction('Удалить ключи Telegram?', 'Отправка событий в Telegram выключится. Токен бота и Chat ID будут удалены с сервера. Локальная лента событий сохранится.', 'Удалить ключи', async () => { await api('/api/settings/telegram', { method: 'DELETE' }); state.settings.telegram = { configured: false, enabled: false }; $('telegram-enabled').checked = false; $('telegram-token').value = ''; $('telegram-chat').value = ''; renderSettings(); feedback('telegram-feedback', 'Ключи удалены. Telegram выключен.'); }));
$('ai-form').addEventListener('submit', (event) => { event.preventDefault(); if (!state.settings) { feedback('ai-feedback', 'Настройки ещё не загружены. Нажмите «Обновить» и повторите.', true); return; } const apiKey = $('ai-key').value.trim(); if (!state.settings?.ai?.configured && !apiKey) { feedback('ai-feedback', 'Для первого подключения укажите API-ключ OpenAI.', true); $('ai-key').focus(); return; } const model = $('ai-model').value.trim(); if (!model) { feedback('ai-feedback', 'Укажите точное имя модели.', true); $('ai-model').focus(); return; } pending(event.submitter, async () => { feedback('ai-feedback', ''); try { const result = await api('/api/settings/ai', { method: 'POST', body: { apiKey, model, systemPrompt: $('ai-prompt').value, enabled: $('ai-enabled').checked } }); state.settings.ai = result.ai; $('ai-key').value = ''; renderSettings(); feedback('ai-feedback', 'Настройки сохранены. Запрос в OpenAI не отправлялся.'); } catch (error) { feedback('ai-feedback', error.message, true); } }); });
$('ai-delete').addEventListener('click', () => confirmAction('Удалить ключ ИИ?', 'Ключ OpenAI будет удалён с сервера. Текстовые запросы Киби перестанут работать до повторного подключения.', 'Удалить ключ', async () => { await api('/api/settings/ai', { method: 'DELETE' }); state.settings.ai = { ...state.settings.ai, configured: false, enabled: false }; $('ai-enabled').checked = false; $('ai-key').value = ''; renderSettings(); feedback('ai-feedback', 'Ключ удалён. Текстовый ИИ выключен.'); }));
$('ai-test-form').addEventListener('submit', (event) => { event.preventDefault(); const text = $('ai-test-text').value.trim(); if (!text) { feedback('ai-test-feedback', 'Введите текст для Киби.', true); $('ai-test-text').focus(); return; } pending(event.submitter, async () => { feedback('ai-test-feedback', 'Отправляем запрос с сохранёнными настройками…'); try { const result = await api('/api/modules/ai/test', { method: 'POST', body: { text }, timeout: 60000 }); $('ai-output').textContent = result.text; $('ai-output').hidden = false; feedback('ai-test-feedback', 'Ответ получен. Следующий запрос начнёт отдельный диалог.'); } catch (error) { feedback('ai-test-feedback', error.message, true); } }); });

async function boot() {
  const results = await Promise.allSettled([api('/api/health'), api('/api/session')]);
  $('connection-note').textContent = results[0].status === 'fulfilled' ? `Киби Сервер ${results[0].value.version} · соединение установлено` : 'Нет связи с сервером. Проверьте адрес и перезагрузите страницу.';
  if (results[1].status === 'fulfilled' && results[1].value.authenticated) await enterApp(results[1].value.csrfToken);
  else if (results[1].status === 'rejected') feedback('login-error', results[1].reason.message, true);
}
boot();
