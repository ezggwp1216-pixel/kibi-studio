'use strict';

const $ = (id) => document.getElementById(id);
const API_BASE = new URL('.', import.meta.url);
const state = { authenticated: false, user: null, authMode: 'login', generation: 0, csrf: '', overview: null, settings: null, loadedSettings: false, refreshing: false, timer: null, section: 'overview', messageTarget: null, confirmAction: null, refreshFailed: false, instructions: '', instructionsLoading: false };
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
  invalid_credentials: 'Почта или пароль не подошли. Проверьте данные и попробуйте снова.',
  invalid_registration: 'Укажите корректную почту и пароль от 12 до 1024 символов.',
  account_unavailable: 'Не удалось создать кабинет с этой почтой. Попробуйте войти или используйте другой адрес.',
  account_limit: 'На сервере достигнут лимит кабинетов. Обратитесь к владельцу сервера.',
  pairing_invalid_code: 'Введите 8 символов кода с экрана Киби: буквы A–Z и цифры 2–7.',
  pairing_not_found: 'Код не найден или истёк. Получите новый код на Киби и повторите.',
  pairing_claimed: 'Этот код уже подтверждён. Проверьте список устройств или получите новый код на Киби.',
  pairing_limit: 'Слишком много попыток привязки. Подождите немного и повторите.',
  tenant_voice_unavailable: 'Голос для личных кабинетов пока недоступен. API устройства и текстовый ИИ настраиваются отдельно.',
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
  const generation = state.generation;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') { headers['X-CSRF-Token'] = state.csrf; if (body !== undefined) headers['Content-Type'] = 'application/json'; }
    const response = await fetch(new URL(path.replace(/^\/+/, ''), API_BASE), { method, credentials: 'same-origin', cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    let data;
    try { data = await response.json(); } catch { throw new ApiError('server_error', response.status); }
    if (generation !== state.generation) throw new ApiError('session_changed');
    if (!response.ok || data.ok === false) {
      if (response.status === 401 && path !== '/api/login' && path !== '/api/register') { showLogin('Сессия завершилась. Войдите снова.'); throw new ApiError('session_changed'); }
      throw new ApiError(path === '/api/login' && response.status === 401 ? (data.code || 'invalid_credentials') : (data.code || 'server_error'), response.status);
    }
    return data;
  } catch (error) {
    if (generation !== state.generation) throw new ApiError('session_changed');
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
async function pending(button, task) { if (button.disabled) return; const dialog = button.closest('dialog'); if (dialog) dialog.dataset.pending = 'true'; const before = button.textContent; button.disabled = true; button.textContent = 'Выполняем…'; button.setAttribute('aria-busy', 'true'); try { return await task(); } finally { button.disabled = button.dataset.ownerOnlyDisabled === 'true'; button.textContent = before; button.removeAttribute('aria-busy'); if (dialog) delete dialog.dataset.pending; } }
function setSection(id, { focus = true, updateHash = true } = {}) {
  if (!labels[id]) id = 'overview'; state.section = id;
  for (const button of document.querySelectorAll('[data-section]')) { const selected = button.dataset.section === id; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; $(button.dataset.section).hidden = !selected; }
  $('breadcrumb').textContent = `/ ${labels[id]}`; document.title = `${labels[id]} — Киби Сервер`;
  if (updateHash && location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (focus) $('main').focus({ preventScroll: true });
}
function setAuthMode(mode) {
  state.authMode = ['login', 'register', 'owner'].includes(mode) ? mode : 'login';
  const owner = state.authMode === 'owner'; const register = state.authMode === 'register';
  for (const button of document.querySelectorAll('[data-auth-mode]')) button.setAttribute('aria-pressed', String(button.dataset.authMode === state.authMode));
  $('auth-title').textContent = owner ? 'Владелец сервера' : register ? 'Создать свой кабинет' : 'Войти в кабинет';
  $('auth-description').textContent = owner ? 'Отдельный вход владельца. Используйте пароль администратора, созданный при установке сервера.' : register ? 'Новый кабинет начнётся с пустого списка устройств и собственных настроек.' : 'Почта и пароль вашего личного кабинета на этом сервере.';
  $('auth-email-field').hidden = owner; $('auth-email').disabled = owner; $('auth-email').required = !owner;
  $('auth-password-label').textContent = owner ? 'Пароль администратора' : 'Пароль';
  $('admin-password').autocomplete = register ? 'new-password' : 'current-password';
  $('admin-password').minLength = register ? 12 : 1; $('admin-password').value = '';
  $('registration-warning').hidden = !register; $('auth-password-note').hidden = !register;
  $('auth-submit').textContent = register ? 'Создать кабинет ↗' : owner ? 'Войти как владелец ↗' : 'Войти в кабинет ↗';
  $('auth-note').textContent = owner ? 'Этот вход открывает существующее хранилище владельца. Обычным пользователям нужен личный кабинет по почте.' : 'У каждого пользователя свои устройства, события и настройки интеграций.';
  feedback('login-error', ''); $('auth-email').removeAttribute('aria-invalid'); $('admin-password').removeAttribute('aria-invalid');
}
function clearAccountUI() {
  state.generation += 1; state.authenticated = false; state.user = null; state.csrf = ''; state.settings = null; state.overview = null; state.loadedSettings = false; state.refreshing = false; state.refreshFailed = false; state.messageTarget = null; state.confirmAction = null;
  clearInterval(state.timer); state.timer = null;
  for (const dialog of document.querySelectorAll('dialog')) { if (dialog.open) dialog.close(); delete dialog.dataset.pending; }
  for (const form of document.querySelectorAll('form')) { form.reset(); delete form.dataset.dirty; }
  for (const el of document.querySelectorAll('.form-feedback')) el.textContent = '';
  for (const id of ['device-token', 'ai-key', 'ai-prompt', 'telegram-token', 'telegram-chat', 'admin-password', 'auth-email', 'message-title', 'message-body', 'sdk-package']) $(id).value = '';
  for (const id of ['ai-output', 'xiaozhi-pairing', 'xiaozhi-status', 'voice-endpoint', 'voice-feedback', 'xiaozhi-feedback', 'account-email', 'account-role', 'topbar-account', 'message-dialog-title', 'message-explanation', 'confirm-title', 'confirm-description', 'global-message-text']) $(id).textContent = '';
  for (const id of ['device-list', 'event-list', 'module-summary-list', 'sdk-errors']) $(id).replaceChildren();
  for (const id of ['device-list', 'event-list']) $(id).setAttribute('aria-busy', 'true');
  for (const id of ['ai-status', 'telegram-status', 'voice-status', 'notifications-status']) { $(id).textContent = 'Загружаем'; $(id).className = 'status-label neutral'; }
  for (const id of ['device-count', 'event-count', 'uptime']) $(id).textContent = '—';
  $('server-status').textContent = 'Проверяем состояние'; $('server-detail').textContent = 'Получаем данные от сервера.'; $('sync-status').textContent = 'Загружаем данные'; $('voice-detail').textContent = 'Получаем состояние голосового шлюза…';
  $('sdk-status').textContent = 'Контракт SDK'; $('sdk-errors').hidden = true; $('ai-output').hidden = true; $('global-message').hidden = true; $('refresh').disabled = false;
  setVoicePermissions(false);
}
function setVoicePermissions(owner) {
  $('voice-owner-controls').hidden = !owner;
  for (const control of $('voice-owner-controls').querySelectorAll('input, select, button')) { control.disabled = !owner; control.dataset.ownerOnlyDisabled = String(!owner); }
  $('voice-intro').textContent = owner ? 'Живой разговор через ваш сервер: Xiaozhi или OpenAI. Одновременно работает один разговор. Провайдер выбирается явно.' : 'Голос для личных кабинетов пока недоступен. Уведомления, API устройства и текстовый ИИ настраиваются отдельно.';
}
function showLogin(message = '') {
  const mode = state.user?.role === 'owner' ? 'owner' : state.authMode === 'owner' ? 'owner' : 'login';
  clearAccountUI();
  $('app').hidden = true; $('login-screen').hidden = false; document.title = 'Вход — Киби Сервер';
  setAuthMode(mode); feedback('login-error', message, !!message);
  if (message) $('admin-password').focus();
}
async function enterApp(data) {
  clearAccountUI();
  state.authenticated = true; state.csrf = data.csrfToken; state.user = data.user || { id: null, email: null, role: 'user' };
  const owner = state.user.role === 'owner'; setVoicePermissions(owner);
  $('account-role').textContent = owner ? 'Владелец сервера' : 'Личный кабинет'; $('account-email').textContent = state.user.email || ''; $('topbar-account').textContent = state.user.email || 'Владелец сервера';
  $('login-screen').hidden = true; $('app').hidden = false; feedback('login-error', '');
  setSection(location.hash.slice(1), { focus: false });
  loadStudioInstructions(); loadSdkStatus();
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
  if (!devices.length) { list.append(empty('Здесь будет ваша Киби.', 'Введите код с экрана совместимого приложения. Готовых подключений пока нет.', 'Привязать Киби ↗', openPairing)); return; }
  const statuses = { not_seen: ['Ожидает подключения', 'neutral'], online: ['Онлайн', ''], offline: ['Не на связи', 'neutral'] };
  for (const device of devices) { const row = node('article', 'device-row'); const info = node('div', 'device-info'); const icon = node('span', 'device-icon', '⌁'); icon.setAttribute('aria-hidden', 'true'); const copy = node('div'); copy.append(node('h2', '', device.name)); const meta = node('div', 'device-meta'); const [status, className] = statuses[device.status] || ['Статус неизвестен', 'neutral']; meta.append(node('span', `status-label ${className}`, status), node('span', '', device.lastSeenAt ? `Было на связи: ${formatDate(device.lastSeenAt, true)}` : 'Первого запроса ещё не было')); copy.append(meta); info.append(icon, copy); const actions = node('div', 'device-actions'); actions.append(action('Отправить сообщение ↗', 'button secondary', () => openMessage(device)), action('Отозвать токен', 'text-button danger', () => confirmRevoke(device))); row.append(info, actions); list.append(row); }
}
function renderModuleSummary(modules) {
  const notifications = modules.find((module) => module.id === 'notifications'); $('notifications-status').textContent = notifications?.status === 'ready' ? 'Работает' : 'Недоступен'; $('notifications-status').className = `status-label${notifications?.status === 'ready' ? '' : ' neutral'}`;
  const container = $('module-summary-list'); container.replaceChildren();
  for (const module of modules) { const row = node('div', 'summary-row'); const names = { notifications: 'Уведомления', telegram: 'Telegram', ai: 'Текстовый ИИ', voice: 'Голосовой ИИ', schedules: 'Расписания' }; let status = module.status === 'ready' ? 'Работает' : module.status === 'configured' ? 'Настроен' : module.status === 'planned' ? 'В планах' : 'Не настроен'; let ready = module.status === 'ready'; const setting = state.settings?.[module.id]; if (setting) { status = setting.configured ? (setting.enabled ? 'Включён' : 'Выключен') : 'Не настроен'; ready = setting.configured && setting.enabled; } if (module.id === 'voice') { const voice = setting || module; status = voiceLabel(voice); ready = voice.status === 'active' || voice.status === 'listening'; } row.append(node('span', '', names[module.id] || module.name), node('span', `summary-state${ready ? ' ready' : ''}`, status)); container.append(row); }
}
function voiceLabel(voice) { if (state.user?.role !== 'owner' || voice.code === 'tenant_voice_unavailable') return 'Пока недоступен'; return ({disabled:'Выключен',not_configured:'Нужна настройка',listening:'Ожидает Киби',connecting:'Подключается',active:'Разговор идёт',error:'Нужна настройка',closed:'Остановлен'})[voice.status] || 'Недоступен'; }
function renderVoice(voice) {
  if (state.user?.role !== 'owner' || voice?.code === 'tenant_voice_unavailable') {
    setVoicePermissions(false); $('voice-status').textContent = 'Пока недоступен'; $('voice-status').className = 'status-label neutral'; $('voice-detail').textContent = 'Голос для личных кабинетов ещё не реализован. Это ограничение текущей версии; настройки голосового пилота владельца здесь недоступны.'; $('voice-endpoint').textContent = ''; $('xiaozhi-pairing').textContent = ''; return;
  }
  if (!voice) return;
  setVoicePermissions(true);
  $('voice-status').textContent = voiceLabel(voice);
  $('voice-status').className = `status-label${['listening','active'].includes(voice.status) ? '' : ' neutral'}`;
  const details = { disabled:'Голос выключен в настройках запуска сервера. Для включения следуйте docs/VOICE.md.', tls_required:'Не заданы приватные TLS-файлы голосового шлюза. Настройте их на сервере по docs/VOICE.md.', tls_failed:'TLS-файлы недоступны, небезопасны или сертификат не подходит. Проверьте их права, срок и соответствие ключу.', legacy_unavailable:'Хранилище совместимости со Studio недоступно. Проверьте установку на сервере.', gateway_unavailable:'Голосовой шлюз не запустился. Проверьте адрес, порт и настройки сервера.' };
  $('voice-detail').textContent = details[voice.code] || (voice.status === 'not_configured' ? 'Сохраните API-ключ OpenAI в модуле ИИ. Голос использует отдельную фиксированную модель gpt-realtime.' : voice.status === 'active' ? 'Киби подключена к голосовому шлюзу. Приём и воспроизведение звука проверяются на устройстве.' : voice.status === 'connecting' ? 'Киби устанавливает голосовое соединение. Дождитесь завершения подключения.' : 'TLS-шлюз запущен и ожидает устройство. Доступ к OpenAI и звук пока не подтверждены.');
  if(voice.provider==='xiaozhi') $('voice-detail').textContent = voice.configured ? (voice.status==='active'?'Разговор через Xiaozhi подключён. Звук проверяется на Киби.':'Выбран Xiaozhi. Платного переключения на OpenAI нет.') : 'Завершите привязку Xiaozhi и выберите один проект. OpenAI в этом режиме не используется.';
  const registration=voice.registration;
  $('xiaozhi-status').textContent = 'Не подключён'; $('xiaozhi-pairing').textContent = '';
  if(registration){$('xiaozhi-status').textContent=registration.configured?'Аккаунт Xiaozhi привязан':registration.status==='pending'?'Ожидает привязку':registration.code?xiaozhiMessage(registration.code):'Не подключён';$('xiaozhi-pairing').textContent=registration.pairingCode?`Код устройства: ${registration.pairingCode}${registration.expiresAt?' · действует до '+new Date(registration.expiresAt).toLocaleTimeString('ru-RU'):''}`:'';}
  if(!$('voice-form').dataset.dirty){$('voice-provider').value=voice.provider||'openai';$('voice-scope-kind').value=voice.scope?.kind||'legacy';$('voice-scope-id').value=voice.scope?.id||'';}
  $('voice-provider').disabled=!!voice.providerLocked;
  $('voice-endpoint').textContent = voice.enabled ? `Адрес устройства: ${voice.endpoint}` : '';
}
function renderSettings(fillForms = false) {
  if (!state.settings) return;
  const telegram = state.settings.telegram; const ai = state.settings.ai;
  function status(id, value) { $(id).textContent = value.configured ? (value.enabled ? 'Включён' : 'Настроен · выключен') : 'Не настроен'; $(id).className = `status-label${value.configured && value.enabled ? '' : ' neutral'}`; }
  if (telegram) { status('telegram-status', telegram); $('telegram-delete').hidden = !telegram.configured; if (fillForms && !$('telegram-form').dataset.dirty) $('telegram-enabled').checked = telegram.enabled; }
  if (ai) { status('ai-status', ai); $('ai-delete').hidden = !ai.configured; if (fillForms && !$('ai-form').dataset.dirty) { $('ai-enabled').checked = ai.enabled; $('ai-model').value = ai.model || 'gpt-5-mini'; $('ai-prompt').value = ai.systemPrompt || ''; } }
  renderVoice(state.settings.voice);
  if (state.overview) renderModuleSummary(state.overview.modules);
}
async function refreshData(silent = false) {
  if (!state.authenticated || state.refreshing) return;
  const generation = state.generation;
  state.refreshing = true; const wasFailed = state.refreshFailed; $('refresh').disabled = true; if (!silent) $('sync-status').textContent = 'Обновляем…';
  let session;
  try { session = await api('/api/session'); }
  catch (error) { if (generation !== state.generation || error.code === 'session_changed') return; state.refreshing = false; state.refreshFailed = true; $('refresh').disabled = false; $('sync-status').textContent = 'Связь прервана'; if (!silent || !wasFailed) announce(error.message, true, true); return; }
  if (generation !== state.generation) return;
  if (!session.authenticated) { showLogin('Сессия завершилась. Войдите снова.'); return; }
  if (session.user?.id !== state.user?.id || session.user?.role !== state.user?.role || session.user?.email !== state.user?.email) { await enterApp(session); return; }
  state.csrf = session.csrfToken;
  const results = await Promise.allSettled([api('/api/overview'), api('/api/settings')]);
  if (generation !== state.generation) return;
  state.refreshing = false; $('refresh').disabled = false; if (!state.authenticated) return;
  const errors = [];
  if (results[0].status === 'fulfilled') { state.overview = results[0].value; renderOverview(); } else errors.push(results[0].reason);
  if (results[1].status === 'fulfilled') { state.settings = results[1].value; renderSettings(!state.loadedSettings); state.loadedSettings = true; } else errors.push(results[1].reason);
  if (errors.length) { state.refreshFailed = true; $('sync-status').textContent = 'Связь прервана'; $('server-status').textContent = state.overview ? 'Данные могли устареть' : 'Нет связи с сервером'; $('server-detail').textContent = 'Проверьте подключение и обновите данные.'; if (!state.overview) { $('event-list').replaceChildren(empty('Не удалось загрузить события', 'Проверьте подключение к серверу.', 'Повторить', () => refreshData())); $('device-list').replaceChildren(empty('Не удалось загрузить устройства', 'Список появится после восстановления связи.', 'Повторить', () => refreshData())); } if (!silent || !wasFailed) announce(errors[0].message, true, true); }
  else { state.refreshFailed = false; $('sync-status').textContent = `Обновлено ${new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`; if (wasFailed) announce('Связь восстановлена. Данные обновлены.'); }
}
function openCreate() { feedback('device-feedback', ''); openDialog('device-dialog'); $('device-name').focus(); }
function openPairing() { $('pairing-form').reset(); $('pairing-code').removeAttribute('aria-invalid'); feedback('pairing-feedback', ''); openDialog('pairing-dialog'); $('pairing-code').focus(); }
function openMessage(device) { state.messageTarget = device.id; $('message-dialog-title').textContent = `Для ${device.name}`; $('message-dialog-kicker').textContent = 'СООБЩЕНИЕ УСТРОЙСТВУ'; $('message-explanation').textContent = 'Сообщение попадёт в очередь. Устройство получит его при следующем запросе и должно подтвердить получение. Постановка в очередь не означает доставку.'; $('message-submit').textContent = 'Поставить в очередь'; feedback('message-feedback', ''); openDialog('message-dialog'); $('message-title').focus(); }
function openEvent() { state.messageTarget = null; $('message-dialog-title').textContent = 'Проверить событие'; $('message-dialog-kicker').textContent = 'ТЕСТ СЕРВЕРА'; $('message-explanation').textContent = 'Событие появится в ленте сервера. Если Telegram включён, это действие отправит реальное сообщение в ваш сохранённый чат.'; $('message-submit').textContent = 'Создать событие'; feedback('message-feedback', ''); openDialog('message-dialog'); $('message-title').focus(); }
function confirmAction(title, description, buttonText, callback) { $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-action').textContent = buttonText; feedback('confirm-feedback', ''); state.confirmAction = callback; openDialog('confirm-dialog'); }
function confirmRevoke(device) { confirmAction(`Отозвать токен «${device.name}»?`, 'Устройство потеряет доступ к серверу, а его очередь сообщений будет удалена. Для нового подключения потребуется создать устройство заново.', 'Отозвать токен', async () => { await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }); announce(`Токен «${device.name}» отозван.`); await refreshData(); }); }
async function copyText(text, button, feedbackId) {
  const generation = state.generation;
  try { if (!navigator.clipboard?.writeText) throw new Error('no_clipboard'); await navigator.clipboard.writeText(text); if (generation !== state.generation) return; if (feedbackId) feedback(feedbackId, 'Скопировано. Сохраните в безопасном месте.'); else { const before = button.textContent; button.textContent = 'Скопировано ✓'; setTimeout(() => { button.textContent = before; }, 2500); } }
  catch { if (generation !== state.generation) return; if (feedbackId) { $('device-token').focus(); $('device-token').select(); feedback(feedbackId, 'Браузер не разрешил копирование. Токен выделен: скопируйте его вручную.', true); } else { const source = $(button.dataset.copy); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(source); selection.removeAllRanges(); selection.addRange(range); announce('Браузер не разрешил копирование. Текст выделен: скопируйте его вручную.'); } }
}
async function loadStudioInstructions() {
  if (state.instructionsLoading) return;
  if (state.instructions) { $('bootstrap-prompt').textContent = state.instructions; $('copy-studio-prompt').disabled = false; return; }
  state.instructionsLoading = true; $('load-studio-prompt').disabled = true;
  feedback('studio-feedback', 'Загружаем общедоступную инструкцию…');
  try {
    const response = await fetch(new URL('docs/LOCAL_STUDIO.md', API_BASE), { credentials: 'omit', cache: 'no-store', headers: { Accept: 'text/markdown, text/plain' } });
    if (!response.ok) throw new Error('instructions_unavailable');
    const text = await response.text(); if (!text.trim() || text.length > 262144 || /^\s*<!doctype html/i.test(text)) throw new Error('instructions_invalid');
    state.instructions = text; $('bootstrap-prompt').textContent = text; $('copy-studio-prompt').disabled = false;
    feedback('studio-feedback', 'Инструкция загружена из docs/LOCAL_STUDIO.md. Она не содержит секретов вашего кабинета.');
  } catch { feedback('studio-feedback', 'Не удалось загрузить инструкцию. Откройте ссылку выше или повторите загрузку.', true); }
  finally { state.instructionsLoading = false; $('load-studio-prompt').disabled = false; }
}
async function loadSdkStatus() {
  const generation = state.generation;
  try { const data = await api('/api/sdk'); if (generation !== state.generation) return; $('sdk-status').textContent = data.validation ? `SDK ${data.version} · валидация` : 'Валидатор недоступен'; }
  catch (error) { if (error.code === 'session_changed') return; $('sdk-status').textContent = 'Статус SDK не загружен'; }
}

for (const el of document.querySelectorAll('.api-base')) el.textContent = API_BASE.href;
for (const button of document.querySelectorAll('[data-auth-mode]')) button.addEventListener('click', () => { if (!$('auth-submit').disabled) setAuthMode(button.dataset.authMode); });
for (const button of document.querySelectorAll('[data-section]')) button.addEventListener('click', () => setSection(button.dataset.section, { focus: false }));
const tabs = Array.from(document.querySelectorAll('[data-section]'));
for (const tab of tabs) tab.addEventListener('keydown', (event) => { let index = tabs.indexOf(tab); if (['ArrowDown', 'ArrowRight'].includes(event.key)) index = (index + 1) % tabs.length; else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) index = (index - 1 + tabs.length) % tabs.length; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = tabs.length - 1; else return; event.preventDefault(); tabs[index].focus(); setSection(tabs[index].dataset.section, { focus: false }); });
for (const button of document.querySelectorAll('[data-go]')) button.addEventListener('click', () => setSection(button.dataset.go));
for (const button of document.querySelectorAll('[data-action="create-device"]')) button.addEventListener('click', openCreate);
for (const button of document.querySelectorAll('[data-action="pair-device"]')) button.addEventListener('click', openPairing);
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => { if (!$(button.dataset.close).dataset.pending) closeDialog(button.dataset.close); });
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('cancel', (event) => { if (dialog.dataset.pending) event.preventDefault(); });
for (const id of ['telegram-form', 'ai-form']) $(id).addEventListener('input', () => { $(id).dataset.dirty = 'true'; });
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', () => copyText($(button.dataset.copy).textContent, button));
window.addEventListener('hashchange', () => { if (state.authenticated) setSection(location.hash.slice(1), { updateHash: false }); });
$('token-dialog').addEventListener('close', () => { $('device-token').value = ''; feedback('token-feedback', ''); });
$('confirm-dialog').addEventListener('close', () => { state.confirmAction = null; });
$('copy-token').addEventListener('click', () => copyText($('device-token').value, $('copy-token'), 'token-feedback'));
$('load-studio-prompt').addEventListener('click', loadStudioInstructions);
$('pairing-dialog').addEventListener('close', () => { $('pairing-form').reset(); feedback('pairing-feedback', ''); });
$('pairing-code').addEventListener('input', () => { const code = $('pairing-code').value.toUpperCase().replace(/[\s-]/g, '').slice(0, 8); $('pairing-code').value = code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code; $('pairing-code').removeAttribute('aria-invalid'); });
$('pairing-form').addEventListener('submit', (event) => {
  event.preventDefault(); const code = $('pairing-code').value.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) { feedback('pairing-feedback', errorMessages.pairing_invalid_code, true); $('pairing-code').setAttribute('aria-invalid', 'true'); $('pairing-code').focus(); return; }
  pending(event.submitter, async () => { feedback('pairing-feedback', ''); try { const data = await api('/api/pairing/claim', { method: 'POST', body: { code } }); closeDialog('pairing-dialog'); announce(`Киби${data.device?.name ? ` «${data.device.name}»` : ''} привязана. Токен получит само устройство; дождитесь его первого запроса.`); await refreshData(); } catch (error) { if (error.code === 'session_changed') return; feedback('pairing-feedback', error.message, true); $('pairing-code').setAttribute('aria-invalid', 'true'); $('pairing-code').focus(); } });
});
$('sdk-form').addEventListener('submit', (event) => {
  event.preventDefault(); $('sdk-errors').replaceChildren(); $('sdk-errors').hidden = true; $('sdk-package').removeAttribute('aria-invalid');
  let packageValue;
  try { if (new TextEncoder().encode($('sdk-package').value).length > 131072) throw new Error('package_size'); packageValue = JSON.parse($('sdk-package').value); if (!packageValue || typeof packageValue !== 'object' || Array.isArray(packageValue)) throw new Error('package_object'); }
  catch (error) { if (error.code === 'session_changed') return; feedback('sdk-feedback', error.message === 'package_size' ? 'Пакет должен быть не больше 128 КиБ.' : 'Вставьте корректный JSON-объект пакета. Массив или отдельная строка не подходят.', true); $('sdk-package').setAttribute('aria-invalid', 'true'); $('sdk-package').focus(); return; }
  pending(event.submitter, async () => { feedback('sdk-feedback', 'Проверяем структуру без запуска кода…'); try { const result = await api('/api/sdk/validate', { method: 'POST', body: { package: packageValue } }); for (const error of result.errors || []) { const message = typeof error === 'string' ? error : [error.path, error.message || error.code].filter(Boolean).join(': '); $('sdk-errors').append(node('li', '', message || 'Ошибка структуры пакета.')); } $('sdk-errors').hidden = !($('sdk-errors').children.length); feedback('sdk-feedback', result.valid ? 'Структура пакета прошла проверку. Пакет не установлен и не запущен; исполнитель пользовательских плагинов пока недоступен.' : 'Структура пакета не прошла проверку. Исправьте ошибки и повторите. Код не запускался.', !result.valid); $('sdk-package').setAttribute('aria-invalid', String(!result.valid)); } catch (error) { if (error.code === 'session_changed') return; feedback('sdk-feedback', error.message, true); } });
});
$('create-event').addEventListener('click', openEvent);
$('dismiss-message').addEventListener('click', () => { $('global-message').hidden = true; });
$('refresh').addEventListener('click', () => refreshData()); $('retry').addEventListener('click', () => refreshData());
$('login-form').addEventListener('submit', (event) => {
  event.preventDefault(); const mode = state.authMode; const email = $('auth-email').value.trim(); const password = $('admin-password').value;
  if (mode === 'register' && (password.length < 12 || password.length > 1024)) { feedback('login-error', errorMessages.invalid_registration, true); $('admin-password').setAttribute('aria-invalid', 'true'); $('admin-password').focus(); return; }
  pending(event.submitter, async () => { feedback('login-error', ''); $('admin-password').removeAttribute('aria-invalid'); $('auth-email').removeAttribute('aria-invalid'); try { const data = await api(mode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body: mode === 'owner' ? { password } : { email, password } }); await enterApp(data); if (state.authenticated) $('main').focus(); } catch (error) { if (error.code === 'session_changed') return; feedback('login-error', error.message, true); $('admin-password').setAttribute('aria-invalid', 'true'); if (mode !== 'owner') $('auth-email').setAttribute('aria-invalid', 'true'); $('admin-password').focus(); } });
});
$('logout').addEventListener('click', () => pending($('logout'), async () => { try { await api('/api/logout', { method: 'POST' }); showLogin(); (state.authMode === 'owner' ? $('admin-password') : $('auth-email')).focus(); } catch (error) { if (error.code === 'session_changed') return; if (state.authenticated) announce(error.message, true); } }));
$('device-form').addEventListener('submit', (event) => { event.preventDefault(); const name = $('device-name').value.trim(); if (!name) { feedback('device-feedback', 'Введите название устройства.', true); $('device-name').focus(); return; } pending(event.submitter, async () => { feedback('device-feedback', ''); try { const data = await api('/api/devices', { method: 'POST', body: { name } }); closeDialog('device-dialog'); $('device-form').reset(); $('device-token').value = data.token; openDialog('token-dialog'); $('copy-token').focus(); await refreshData(); } catch (error) { if (error.code === 'session_changed') return; feedback('device-feedback', error.message, true); } }); });
$('message-form').addEventListener('submit', (event) => { event.preventDefault(); const title = $('message-title').value.trim(); if (!title) { feedback('message-feedback', 'Введите заголовок.', true); $('message-title').focus(); return; } const target = state.messageTarget; pending(event.submitter, async () => { feedback('message-feedback', ''); try { const data = await api(target === null ? '/api/events' : `/api/devices/${encodeURIComponent(target)}/messages`, { method: 'POST', body: { title, message: $('message-body').value } }); closeDialog('message-dialog'); $('message-form').reset(); if (target !== null) announce('Сообщение поставлено в очередь устройства. Подтверждение доставки пока не получено.'); else announce(data.event?.delivery === 'telegram_failed' ? 'Событие сохранено. Telegram не подтвердил доставку; проверьте настройки модуля.' : data.event?.delivery === 'telegram_sent' ? 'Событие сохранено и отправлено в Telegram.' : 'Событие сохранено на сервере.', data.event?.delivery === 'telegram_failed'); await refreshData(); } catch (error) { if (error.code === 'session_changed') return; feedback('message-feedback', error.message, true); } }); });
$('confirm-action').addEventListener('click', () => pending($('confirm-action'), async () => { try { if (state.confirmAction) await state.confirmAction(); closeDialog('confirm-dialog'); } catch (error) { if (error.code === 'session_changed') return; feedback('confirm-feedback', error.message, true); } }));
$('telegram-form').addEventListener('submit', (event) => { event.preventDefault(); if (!state.settings) { feedback('telegram-feedback', 'Настройки ещё не загружены. Нажмите «Обновить» и повторите.', true); return; } const token = $('telegram-token').value.trim(); const chatId = $('telegram-chat').value.trim(); if (!state.settings?.telegram?.configured && (!token || !chatId)) { feedback('telegram-feedback', 'Для первого подключения укажите токен бота и Chat ID.', true); (!token ? $('telegram-token') : $('telegram-chat')).focus(); return; } pending(event.submitter, async () => { feedback('telegram-feedback', ''); try { const result = await api('/api/settings/telegram', { method: 'POST', body: { token, chatId, enabled: $('telegram-enabled').checked } }); state.settings.telegram = result.telegram; $('telegram-token').value = ''; $('telegram-chat').value = ''; renderSettings(); feedback('telegram-feedback', 'Настройки сохранены. Проверка не отправлялась.'); } catch (error) { if (error.code === 'session_changed') return; feedback('telegram-feedback', error.message, true); } }); });
$('telegram-test').addEventListener('click', () => pending($('telegram-test'), async () => { feedback('telegram-feedback', ''); try { await api('/api/modules/telegram/test', { method: 'POST' }); feedback('telegram-feedback', 'Telegram подтвердил отправку проверки в сохранённый чат.'); } catch (error) { if (error.code === 'session_changed') return; feedback('telegram-feedback', error.message, true); } }));
$('telegram-delete').addEventListener('click', () => confirmAction('Удалить ключи Telegram?', 'Отправка событий в Telegram выключится. Токен бота и Chat ID будут удалены с сервера. Локальная лента событий сохранится.', 'Удалить ключи', async () => { await api('/api/settings/telegram', { method: 'DELETE' }); state.settings.telegram = { configured: false, enabled: false }; $('telegram-enabled').checked = false; $('telegram-token').value = ''; $('telegram-chat').value = ''; renderSettings(); feedback('telegram-feedback', 'Ключи удалены. Telegram выключен.'); }));
$('ai-form').addEventListener('submit', (event) => { event.preventDefault(); if (!state.settings) { feedback('ai-feedback', 'Настройки ещё не загружены. Нажмите «Обновить» и повторите.', true); return; } const apiKey = $('ai-key').value.trim(); if (!state.settings?.ai?.configured && !apiKey) { feedback('ai-feedback', 'Для первого подключения укажите API-ключ OpenAI.', true); $('ai-key').focus(); return; } const model = $('ai-model').value.trim(); if (!model) { feedback('ai-feedback', 'Укажите точное имя модели.', true); $('ai-model').focus(); return; } pending(event.submitter, async () => { feedback('ai-feedback', ''); try { const result = await api('/api/settings/ai', { method: 'POST', body: { apiKey, model, systemPrompt: $('ai-prompt').value, enabled: $('ai-enabled').checked } }); state.settings.ai = result.ai; state.settings.voice = result.voice || state.settings.voice; $('ai-key').value = ''; renderSettings(); feedback('ai-feedback', 'Настройки сохранены. Запрос в OpenAI не отправлялся.'); } catch (error) { if (error.code === 'session_changed') return; feedback('ai-feedback', error.message, true); } }); });
$('ai-delete').addEventListener('click', () => confirmAction('Удалить ключ ИИ?', 'Ключ OpenAI будет удалён с сервера. Текстовые запросы перестанут работать, а голосовые разговоры по этому ключу завершатся.', 'Удалить ключ', async () => { await api('/api/settings/ai', { method: 'DELETE' }); state.settings.ai = { ...state.settings.ai, configured: false, enabled: false }; $('ai-enabled').checked = false; $('ai-key').value = ''; await refreshData(); feedback('ai-feedback', 'Ключ удалён. Запросы ИИ с этим ключом выключены.'); }));
$('ai-test-form').addEventListener('submit', (event) => { event.preventDefault(); const text = $('ai-test-text').value.trim(); if (!text) { feedback('ai-test-feedback', 'Введите текст для Киби.', true); $('ai-test-text').focus(); return; } pending(event.submitter, async () => { feedback('ai-test-feedback', 'Отправляем запрос с сохранёнными настройками…'); try { const result = await api('/api/modules/ai/test', { method: 'POST', body: { text }, timeout: 60000 }); $('ai-output').textContent = result.text; $('ai-output').hidden = false; feedback('ai-test-feedback', 'Ответ получен. Следующий запрос начнёт отдельный диалог.'); } catch (error) { if (error.code === 'session_changed') return; feedback('ai-test-feedback', error.message, true); } }); });

async function boot() {
  const generation = state.generation;
  const results = await Promise.allSettled([api('/api/health'), api('/api/session')]);
  if (generation !== state.generation) return;
  $('connection-note').textContent = results[0].status === 'fulfilled' ? `Киби Сервер ${results[0].value.version} · соединение установлено` : 'Нет связи с сервером. Проверьте адрес и перезагрузите страницу.';
  if (results[1].status === 'fulfilled' && results[1].value.authenticated) await enterApp(results[1].value);
  else if (results[1].status === 'rejected') feedback('login-error', results[1].reason.message, true);
}
setAuthMode('login');
boot();

function xiaozhiMessage(code){return ({xiaozhi_pending:'Добавьте устройство по коду в Xiaozhi и повторите проверку.',xiaozhi_challenge_expired:'Код истёк. Получите новый.',xiaozhi_not_configured:'Получите код для привязки.',xiaozhi_untrusted_endpoint:'Сервис вернул неподдерживаемый адрес.',xiaozhi_mqtt_unsupported:'Аккаунт выдал MQTT. Эта версия поддерживает WebSocket.',xiaozhi_timeout:'Xiaozhi не ответил вовремя. Повторите позже.',xiaozhi_busy:'Настройка уже выполняется.',xiaozhi_provider_failed:'Не удалось связаться с Xiaozhi. Повторите позже.'})[code]||'Привязка пока не завершена. Повторите настройку.';}
$('voice-form').addEventListener('input',()=>{$('voice-form').dataset.dirty='1';});
$('voice-form').addEventListener('submit',event=>{event.preventDefault();if(state.user?.role!=='owner')return;pending(event.submitter,async()=>{try{const result=await api('/api/settings/voice',{method:'POST',body:{provider:$('voice-provider').value,scope:{kind:$('voice-scope-kind').value,id:$('voice-scope-id').value.trim()}}});state.settings.voice=result.voice;delete $('voice-form').dataset.dirty;renderVoice(result.voice);feedback('voice-feedback','Режим сохранён. Активный разговор завершён; следующий начнётся с выбранным провайдером.');}catch(error){if(error.code==='session_changed')return;feedback('voice-feedback',error.message,true);}});});
for(const [id,operation] of [['xiaozhi-prepare','prepare'],['xiaozhi-activate','activate']])$(id).addEventListener('click',event=>{if(state.user?.role!=='owner')return;return pending(event.currentTarget,async()=>{try{const result=await api('/api/settings/xiaozhi/'+operation,{method:'POST',body:{}});state.settings.voice=result.voice;renderVoice(result.voice);feedback('xiaozhi-feedback',result.registration.configured?'Привязка подтверждена. Модель и голос выбираются в Xiaozhi.':'Добавьте устройство в Xiaozhi по коду выше, затем проверьте привязку.');}catch(error){if(error.code==='session_changed')return;feedback('xiaozhi-feedback',xiaozhiMessage(error.code),true);await refreshData();}});});
