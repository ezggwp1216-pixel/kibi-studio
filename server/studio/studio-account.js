let accountUISequence = 0;

const accountErrors = {
  account_invalid_input: 'Проверьте ключ подключения или код с экрана Киби.',
  account_link_invalid: 'Ключ истёк или уже использован. Создайте новый в личном кабинете.',
  account_storage_error: 'Не удалось безопасно сохранить подключение. Предыдущее подключение сохранено.',
  account_invalid_response: 'Не удалось проверить ответ сервера. Повторите действие позже.',
  account_network_error: 'Сервер недоступен. Проверьте соединение и повторите.',
  account_timeout: 'Сервер не ответил вовремя. Обновите статус перед повтором действия.',
  account_expired: 'Срок подключения истёк. Создайте новый ключ в личном кабинете.',
  account_revoked: 'Подключение отозвано. Создайте новый ключ в личном кабинете.',
  account_not_connected: 'Сначала подключите аккаунт к Studio.',
  account_session_changed: 'Подключение изменилось. Обновите статус и повторите действие.',
  account_busy: 'Дождитесь завершения текущего действия.',
  account_assistant_scope_required: 'Для помощника нужен новый ключ Studio. Создайте его в личном кабинете и переподключите Studio; остальные функции подключения доступны.',
  account_voice_unavailable: 'Для этого аккаунта подключение голоса сейчас недоступно.',
  studio_voice_not_approved: 'Подключите своего Xiaozhi в личном кабинете. Для общего тестового доступа нужно разрешение владельца.',
  studio_voice_xiaozhi_required: 'Владелец сервера должен выбрать голосовой сервис Xiaozhi.',
  xiaozhi_not_configured: 'Владелец сервера должен завершить настройку Xiaozhi.',
  voice_closed: 'Голосовой шлюз сейчас закрыт.',
};
const voiceStates = { disabled: 'Голос выключен', not_configured: 'Голос не настроен', listening: 'Голосовой шлюз ожидает устройство', connecting: 'Устанавливается голосовое подключение', active: 'Есть активное голосовое подключение', error: 'Ошибка голосового подключения', closed: 'Голосовой шлюз закрыт' };
const diagnosticStates = { connecting: 'Подключение устанавливается', ready: 'Серверное подключение готово', closed: 'Подключение закрыто', error: 'Ошибка подключения' };
const diagnosticMetrics = { inputPackets: 'Входящие пакеты', inputPcmBytes: 'Входящие байты PCM', droppedInputPackets: 'Пропущенные входящие пакеты', outputPackets: 'Исходящие пакеты', outputPcmBytes: 'Исходящие байты PCM', turnsCompleted: 'Завершённые ответы', playbackRejections: 'Отклонения воспроизведения' };
const deviceStates = { not_seen: 'Ещё не подключался', online: 'В сети', offline: 'Не в сети' };
const isUUID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value);

// api(path, {method, body}) is the local Studio helper. It owns local CSRF;
// this browser module never receives or stores the server's StudioToken.
export function initStudioAccountUI({ api = globalThis.window?.studio?.api, mount = document.querySelector('header') || document.body } = {}) {
  if (typeof api !== 'function') throw new Error('Studio account API is unavailable');
  if (typeof mount === 'string') mount = document.querySelector(mount);
  if (!mount || typeof mount.append !== 'function') throw new Error('Studio account mount is unavailable');
  const prefix = `studio-account-${++accountUISequence}`;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'ksa-account-button'; button.textContent = 'Аккаунт';
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', `${prefix}-dialog`);
  const dialog = document.createElement('dialog');
  dialog.id = `${prefix}-dialog`; dialog.className = 'ksa-dialog';
  dialog.setAttribute('aria-labelledby', `${prefix}-title`);
  dialog.innerHTML = `
    <div class="ksa-dialog-heading"><div><p class="ksa-eyebrow">Киби Studio</p><h2 id="${prefix}-title">Аккаунт и устройства</h2></div><button type="button" class="ksa-close" data-action="close" aria-label="Закрыть">×</button></div>
    <p class="ksa-feedback" data-part="feedback" role="status" aria-live="polite" tabindex="-1"></p>
    <section data-part="connect">
      <p class="ksa-intro">Создайте ключ подключения в <a href="https://sldvkibi.ru/server/" target="_blank" rel="noopener noreferrer">личном кабинете Киби</a> и вставьте его в эту форму.</p>
      <form data-form="connect" class="ksa-form">
        <label for="${prefix}-key">Ключ подключения Studio</label>
        <input id="${prefix}-key" name="code" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="128" required aria-describedby="${prefix}-key-help">
        <p id="${prefix}-key-help" class="ksa-help">Одноразовый ключ действует 10 минут. Вводите его только здесь, не в чате с ИИ.</p>
        <label for="${prefix}-label">Название этого подключения</label>
        <input id="${prefix}-label" name="label" type="text" value="Моя Studio" autocomplete="off" maxlength="64" required>
        <button type="submit" class="ksa-primary">Подключить</button>
      </form>
    </section>
    <section data-part="connected" hidden>
      <div class="ksa-identity"><strong data-part="email"></strong><p data-part="status"></p></div>
      <div class="ksa-section-heading"><h3>Мои Киби</h3><button type="button" class="ksa-text-button" data-action="refresh">Обновить</button></div>
      <ul class="ksa-devices" data-part="devices"></ul>
      <p class="ksa-help" data-part="empty">Устройств пока нет. Привяжите Киби по коду с его экрана.</p>
      <form data-form="pair" class="ksa-form ksa-pair-form">
        <label for="${prefix}-pair">Код с экрана Киби</label>
        <div class="ksa-inline"><input id="${prefix}-pair" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" maxlength="32" required><button type="submit" class="ksa-secondary">Привязать</button></div>
      </form>
      <section class="ksa-voice" aria-labelledby="${prefix}-voice-title">
        <h3 id="${prefix}-voice-title">Голос</h3><p data-part="voice-status"></p><p class="ksa-help" data-part="eligibility"></p>
        <form data-form="voice" class="ksa-form" hidden>
          <label for="${prefix}-device">Выберите своего Киби</label><select id="${prefix}-device" name="deviceId" required></select><button type="submit" class="ksa-secondary">Подключить голос</button>
        </form>
      </section>
      <section class="ksa-assistant" aria-labelledby="${prefix}-assistant-title">
        <h3 id="${prefix}-assistant-title">Помощник Киби</h3>
        <p class="ksa-help" data-part="assistant-scope"></p>
        <p class="ksa-help" data-part="assistant-instructions"></p>
        <form data-form="assistant" class="ksa-form">
          <label for="${prefix}-assistant-device">Ваш Киби</label><select id="${prefix}-assistant-device" name="deviceId" required></select>
          <button type="button" class="ksa-secondary" data-action="assistant-load">Загрузить профиль</button>
          <label for="${prefix}-character">Характер помощника</label><textarea id="${prefix}-character" name="character" rows="4" maxlength="4000" aria-describedby="${prefix}-character-help"></textarea>
          <p id="${prefix}-character-help" class="ksa-help">Как помощник общается и отвечает · до 4000 символов.</p>
          <label for="${prefix}-context">Ваш контекст</label><textarea id="${prefix}-context" name="context" rows="5" maxlength="6000" aria-describedby="${prefix}-context-help"></textarea>
          <p id="${prefix}-context-help" class="ksa-help">Сведения, которые разрешено получать через инструмент контекста · до 6000 символов.</p>
          <fieldset class="ksa-assistant-actions"><legend>Разрешённые действия</legend><div data-part="assistant-actions"></div></fieldset>
          <button type="submit" class="ksa-primary" data-action="assistant-save">Сохранить профиль</button>
          <p class="ksa-help" data-part="assistant-status" role="status" aria-live="polite"></p>
          <div class="ksa-assistant-role" data-part="assistant-role" hidden>
            <label for="${prefix}-role">Роль для консоли Xiaozhi</label><textarea id="${prefix}-role" name="rolePrompt" rows="6" readonly spellcheck="false"></textarea>
            <button type="button" class="ksa-secondary" data-action="assistant-copy-role">Скопировать роль</button>
          </div>
        </form>
      </section>
      <section class="ksa-diagnostics" aria-labelledby="${prefix}-diagnostics-title">
        <h3 id="${prefix}-diagnostics-title">Диагностика Киби</h3>
        <p class="ksa-help">Наблюдения сервера за последний час; очищаются при перезапуске. Они не подтверждают качество микрофона, физическое воспроизведение или ошибки устройства до авторизации.</p>
        <form data-form="diagnostics" class="ksa-form">
          <label for="${prefix}-diagnostic-device">Ваш Киби</label><select id="${prefix}-diagnostic-device" name="deviceId" required></select>
          <button type="button" class="ksa-secondary" data-action="diagnostics-refresh">Обновить диагностику</button>
        </form>
        <p data-part="diagnostics-status" role="status" aria-live="polite"></p>
        <p class="ksa-help" data-part="diagnostics-time"></p>
        <dl class="ksa-diagnostic-metrics" data-part="diagnostics-metrics"></dl>
        <ol class="ksa-diagnostic-events" data-part="diagnostics-events" aria-label="Этапы подключения"></ol>
      </section>
      <div class="ksa-disconnect"><button type="button" class="ksa-text-button" data-action="disconnect">Отключить Studio от аккаунта</button></div>
    </section>`;
  mount.append(button); document.body.append(dialog);
  const part = name => dialog.querySelector(`[data-part="${name}"]`);
  const form = name => dialog.querySelector(`[data-form="${name}"]`);
  const keyInput = form('connect').elements.namedItem('code');
  let info = null, devices = [], busy = false, destroyed = false, lastFocus = null;
  let accountGeneration = 0, diagnosticsSequence = 0, selectedDeviceId = '', diagnosticsLoading = false;
  let assistantDeviceId = '', assistantSequence = 0, assistantBusy = false, assistantProfile = null, assistantBaseline = '';
  const assistantActions = new Map(), assistantActionListeners = [], allowedAssistantActions = new Set(['kibi.get_device_status', 'kibi.notify']);
  const assistantField = name => form('assistant').elements.namedItem(name);
  const assistantScope = scope => info?.connected === true && (Array.isArray(info.scopes) ? info.scopes : Array.isArray(info?.connection?.scopes) ? info.connection.scopes : []).includes(scope);
  const assistantBody = () => ({ character: assistantField('character').value, context: assistantField('context').value, actions: [...assistantActions].filter(([, input]) => input.checked).map(([id]) => id) });
  const assistantDirty = () => assistantProfile !== null && JSON.stringify(assistantBody()) !== assistantBaseline;
  const identity = () => info?.connected ? `${info?.account?.id}:${info?.connection?.id}` : '';
  const listeners = [];
  function clearAssistantActions() { while (assistantActionListeners.length) assistantActionListeners.pop()(); assistantActions.clear(); part('assistant-actions').replaceChildren(); }
  function clearAssistant(message = '', resetDevice = false) {
    assistantSequence++; assistantBusy = false; assistantProfile = null; assistantBaseline = '';
    if (resetDevice) assistantDeviceId = '';
    for (const name of ['character', 'context', 'rolePrompt']) assistantField(name).value = '';
    clearAssistantActions(); part('assistant-status').textContent = message; part('assistant-role').hidden = true;
  }
  function assistantData(data, deviceId) {
    if (data?.deviceId !== deviceId || !Number.isSafeInteger(data.revision) || data.revision < 0
      || typeof data.character !== 'string' || data.character.length > 4000 || typeof data.context !== 'string' || data.context.length > 6000
      || typeof data.rolePrompt !== 'string' || data.rolePrompt.length > 20000 || !Array.isArray(data.actions) || data.actions.length > 2
      || new Set(data.actions).size !== data.actions.length || data.actions.some(id => !allowedAssistantActions.has(id))
      || data.application?.mode !== 'manual_xiaozhi' || data.application?.status !== 'manual_step_required' || !Array.isArray(data.catalog)) throw Object.assign(new Error('assistant_invalid'), { code: 'account_invalid_response' });
    const catalog = data.catalog.filter(item => allowedAssistantActions.has(item?.id) && typeof item.title === 'string' && item.title.length <= 120 && typeof item.description === 'string' && item.description.length <= 1000);
    if (new Set(catalog.map(item => item.id)).size !== catalog.length || catalog.length > 2 || data.actions.some(id => !catalog.some(item => item.id === id))) throw Object.assign(new Error('assistant_invalid'), { code: 'account_invalid_response' });
    return { deviceId: data.deviceId, revision: data.revision, character: data.character, context: data.context, actions: [...data.actions], rolePrompt: data.rolePrompt, catalog: catalog.map(({ id, title, description }) => ({ id, title, description })) };
  }
  function applyAssistant(data) {
    assistantProfile = data; assistantField('character').value = data.character; assistantField('context').value = data.context; assistantField('rolePrompt').value = data.rolePrompt;
    clearAssistantActions();
    for (const item of data.catalog) {
      const label = document.createElement('label'), input = document.createElement('input'), copy = document.createElement('span'), title = document.createElement('strong'), description = document.createElement('span');
      label.className = 'ksa-assistant-action'; input.type = 'checkbox'; input.setAttribute('type', 'checkbox'); input.setAttribute('data-action-id', item.id); input.value = item.id; input.checked = data.actions.includes(item.id);
      title.textContent = item.title; description.textContent = item.description; copy.append(title, description); label.append(input, copy); part('assistant-actions').append(label); assistantActions.set(item.id, input);
      const changed = () => { part('assistant-status').textContent = assistantDirty() ? 'Есть несохранённые изменения. Сохраните профиль перед копированием роли.' : 'Профиль совпадает с сохранённым.'; render(); };
      input.addEventListener('change', changed); assistantActionListeners.push(() => input.removeEventListener('change', changed));
    }
    assistantBaseline = JSON.stringify(assistantBody());
  }
  async function assistantRequest(save = false) {
    if (busy || assistantBusy || destroyed || !assistantScope(save ? 'assistant.write' : 'assistant.read') || !devices.some(device => device.id === assistantDeviceId)) return;
    if (save && !assistantProfile) return;
    if (!save && assistantDirty()) { part('assistant-status').textContent = 'Есть несохранённые изменения. Сохраните их перед загрузкой профиля.'; return; }
    const body = save ? assistantBody() : null;
    if (body && (body.character.length > 4000 || body.context.length > 6000)) { part('assistant-status').textContent = 'Сократите характер до 4000 символов, а контекст — до 6000.'; return; }
    const sequence = ++assistantSequence, generation = accountGeneration, accountId = identity(), deviceId = assistantDeviceId;
    const current = () => !destroyed && sequence === assistantSequence && generation === accountGeneration && accountId === identity() && deviceId === assistantDeviceId;
    assistantBusy = true; part('assistant-status').textContent = save ? 'Сохраняем профиль…' : 'Загружаем профиль…'; render();
    try {
      const data = await api(`/api/account/devices/${deviceId}/assistant`, save ? { method: 'POST', body } : undefined);
      if (!current()) return;
      applyAssistant(assistantData(data, deviceId));
      part('assistant-status').textContent = save ? 'Профиль сохранён на вашем сервере. Вставьте роль вручную в свою консоль Xiaozhi.' : `Профиль загружен · версия ${data.revision}. Роль применяется в консоли Xiaozhi вручную.`;
    } catch (error) {
      if (!current()) return;
      if (['account_revoked', 'account_expired', 'account_not_connected', 'account_session_changed'].includes(error?.code)) {
        info = null; devices = []; selectedDeviceId = ''; accountGeneration++; clearDiagnostics(); clearAssistant('', true); feedback(accountErrors[error.code], true);
      } else part('assistant-status').textContent = `${accountErrors[error?.code] || 'Профиль недоступен. Повторите действие позже.'}${save ? ' Изменения остались в форме.' : ''}`;
    } finally { if (current()) assistantBusy = false; render(); }
  }
  function renderAssistant() {
    const select = assistantField('deviceId'), next = devices.some(device => device.id === assistantDeviceId) ? assistantDeviceId : devices[0]?.id || '';
    if (next !== assistantDeviceId) { assistantDeviceId = next; clearAssistant(); }
    const canRead = assistantScope('assistant.read'), canWrite = assistantScope('assistant.write');
    if (!canRead && (assistantProfile || assistantBusy)) clearAssistant();
    select.replaceChildren();
    for (const device of devices) { const option = document.createElement('option'); option.value = device.id; option.textContent = device.name; select.append(option); }
    select.value = assistantDeviceId;
    part('assistant-scope').textContent = canRead && canWrite ? '' : accountErrors.account_assistant_scope_required;
    part('assistant-instructions').textContent = 'Настройте помощника здесь. Скопируйте роль и вручную вставьте её в своего агента Xiaozhi. После изменения характера повторите этот шаг. Контекст и разрешённые действия доступны помощнику через сервер Киби; использование контекста проверяется в разговоре.';
    if (!assistantDeviceId) part('assistant-status').textContent = 'Сначала привяжите своего Киби.';
    else if (!part('assistant-status').textContent) part('assistant-status').textContent = 'Выберите Киби и загрузите его профиль.';
    select.disabled = busy || !canRead || !assistantDeviceId;
    for (const name of ['character', 'context']) assistantField(name).disabled = busy || assistantBusy || !canWrite || !assistantProfile;
    for (const input of assistantActions.values()) input.disabled = busy || assistantBusy || !canWrite || !assistantProfile;
    dialog.querySelector('[data-action="assistant-load"]').disabled = busy || assistantBusy || !canRead || !assistantDeviceId || assistantDirty();
    dialog.querySelector('[data-action="assistant-save"]').disabled = busy || assistantBusy || !canWrite || !canRead || !assistantProfile;
    dialog.querySelector('[data-action="assistant-copy-role"]').disabled = busy || assistantBusy || !canRead || !assistantProfile || !assistantProfile.rolePrompt || assistantDirty();
    assistantField('rolePrompt').disabled = busy || assistantBusy || !canRead || !assistantProfile;
    part('assistant-role').hidden = !assistantProfile;
  }
  function clearDiagnostics(message = '') {
    diagnosticsSequence++; diagnosticsLoading = false;
    for (const name of ['diagnostics-status', 'diagnostics-time', 'diagnostics-metrics', 'diagnostics-events']) part(name).replaceChildren();
    part('diagnostics-status').textContent = message;
  }
  function diagnosticTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU') : 'неизвестно'; }
  async function refreshDiagnostics() {
    const deviceId = selectedDeviceId, accountId = identity(), generation = accountGeneration;
    if (busy || destroyed || !accountId || !devices.some(device => device.id === deviceId)) return;
    clearDiagnostics('Читаем наблюдения сервера…');
    const sequence = diagnosticsSequence;
    const current = () => !destroyed && sequence === diagnosticsSequence && generation === accountGeneration && accountId === identity() && deviceId === selectedDeviceId;
    diagnosticsLoading = true; render();
    try {
      const data = await api(`/api/account/devices/${deviceId}/voice-diagnostics`);
      if (!current()) return;
      if (!data?.observed) { part('diagnostics-status').textContent = 'Сервер пока не наблюдал подключение этого Киби за последний час.'; return; }
      part('diagnostics-status').textContent = `${diagnosticStates[data.connection?.state] || 'Статус неизвестен'} · ${data.connection?.code || 'неизвестно'}`;
      part('diagnostics-time').textContent = `Обновлено сервером: ${diagnosticTime(data.updatedAt)}`;
      for (const [key, label] of Object.entries(diagnosticMetrics)) {
        const title = document.createElement('dt'), value = document.createElement('dd');
        title.textContent = label; value.textContent = Number.isSafeInteger(data.metrics?.[key]) ? String(data.metrics[key]) : 'не измерено';
        part('diagnostics-metrics').append(title, value);
      }
      for (const event of Array.isArray(data.events) ? data.events.slice(-32) : []) {
        const row = document.createElement('li'); row.textContent = `${diagnosticTime(event.at)} · ${diagnosticStates[event.state] || 'Статус неизвестен'} · ${event.code}`; part('diagnostics-events').append(row);
      }
    } catch (error) {
      if (!current()) return;
      if (['account_revoked', 'account_expired', 'account_not_connected', 'account_session_changed'].includes(error?.code)) {
        info = null; devices = []; selectedDeviceId = ''; accountGeneration++; clearDiagnostics(); clearAssistant('', true);
        feedback(accountErrors[error.code], true);
      }
      part('diagnostics-status').textContent = accountErrors[error?.code] || 'Диагностика недоступна. Обновите список устройств и повторите.';
    } finally { if (current()) diagnosticsLoading = false; render(); }
  }
  function on(element, event, listener) { element.addEventListener(event, listener); listeners.push(() => element.removeEventListener(event, listener)); }
  function feedback(message, error = false) {
    part('feedback').textContent = message; part('feedback').classList.toggle('ksa-error', error);
    if (error && dialog.open) part('feedback').focus();
  }
  function render() {
    if (destroyed) return;
    const connected = info?.connected === true;
    button.textContent = connected ? 'Аккаунт подключён' : 'Аккаунт';
    button.classList.toggle('ksa-is-connected', connected);
    part('connect').hidden = connected; part('connected').hidden = !connected;
    part('email').textContent = typeof info?.account?.email === 'string' ? info.account.email : '';
    part('status').textContent = !info?.verified ? 'Подключение сохранено · статус не проверен' : 'Studio подключена к аккаунту';
    if (info?.status === 'expired') feedback(accountErrors.account_expired, true);
    else if (info?.status === 'revoked') feedback(accountErrors.account_revoked, true);
    const list = part('devices'), select = form('voice').elements.namedItem('deviceId'), selected = select.value;
    list.replaceChildren(); select.replaceChildren();
    for (const device of devices) {
      const row = document.createElement('li'), name = document.createElement('strong'), state = document.createElement('span'), option = document.createElement('option');
      name.textContent = device.name; state.textContent = deviceStates[device.status] || 'Статус недоступен'; row.append(name, state); list.append(row);
      option.value = device.id; option.textContent = device.name; select.append(option);
    }
    if (devices.some(device => device.id === selected)) select.value = selected;
    part('empty').hidden = devices.length > 0;
    const diagnosticSelect = form('diagnostics').elements.namedItem('deviceId');
    diagnosticSelect.replaceChildren();
    for (const device of devices) { const option = document.createElement('option'); option.value = device.id; option.textContent = device.name; diagnosticSelect.append(option); }
    const nextDeviceId = devices.some(device => device.id === selectedDeviceId) ? selectedDeviceId : devices[0]?.id || '';
    if (nextDeviceId !== selectedDeviceId) { selectedDeviceId = nextDeviceId; clearDiagnostics(); }
    diagnosticSelect.value = selectedDeviceId;
    if (!selectedDeviceId) part('diagnostics-status').textContent = 'Сначала привяжите своего Киби.';
    else if (!part('diagnostics-status').textContent) part('diagnostics-status').textContent = 'Выберите Киби и обновите диагностику.';
    const eligibility = info?.voiceEligibility || info?.voice?.studioVoice;
    part('voice-status').textContent = voiceStates[info?.voice?.status] || 'Статус голоса ещё не проверен';
    const canActivate = eligibility?.canActivate === true;
    part('eligibility').textContent = canActivate
      ? (devices.length ? 'Подключение доступно для вашего Киби.' : 'Сначала привяжите своего Киби по коду с экрана.')
      : accountErrors[eligibility?.code] || 'Доступ к голосу определяет владелец сервера. Обновите статус, чтобы проверить разрешение.';
    form('voice').hidden = !canActivate || devices.length === 0;
    dialog.setAttribute('aria-busy', busy || diagnosticsLoading || assistantBusy ? 'true' : 'false');
    for (const control of dialog.querySelectorAll('input, select, textarea, button')) control.disabled = busy && control.dataset.action !== 'close';
    dialog.querySelector('[data-action="diagnostics-refresh"]').disabled = busy || diagnosticsLoading || !selectedDeviceId;
    renderAssistant();
  }
  async function load() {
    const generation = ++accountGeneration, previous = identity();
    if (assistantBusy) { assistantSequence++; assistantBusy = false; part('assistant-status').textContent = 'Запрос профиля отменён при обновлении аккаунта. Загрузите профиль снова.'; }
    clearDiagnostics(); render();
    const current = () => !destroyed && generation === accountGeneration;
    try {
      const data = await api('/api/account');
      if (!current()) return;
      info = data?.accountConnection || data?.connectionStatus || data;
      if (identity() !== previous) { devices = []; selectedDeviceId = ''; clearAssistant('', true); }
      if (info?.connected) {
        const data = await api('/api/account/devices');
        if (!current()) return;
        devices = Array.isArray(data?.devices) ? data.devices.filter(device => isUUID(device?.id) && typeof device.name === 'string' && device.name.length <= 64).slice(0, 50) : [];
      } else devices = [];
      render();
    } catch (error) {
      if (current() && ['account_revoked', 'account_expired', 'account_not_connected', 'account_session_changed'].includes(error?.code)) { info = null; devices = []; selectedDeviceId = ''; clearDiagnostics(); clearAssistant('', true); render(); }
      throw error;
    }
  }
  async function run(action, success) {
    if (busy || destroyed) return;
    busy = true; feedback('Выполняем действие…'); render();
    try { const result = await action(); if (!destroyed) feedback(typeof result === 'string' ? result : (success || 'Статус обновлён.')); }
    catch (error) { if (!destroyed) feedback(accountErrors[error?.code] || 'Не удалось выполнить действие. Обновите статус и повторите.', true); }
    finally { busy = false; render(); }
  }
  on(button, 'click', () => {
    lastFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    (info?.connected ? dialog.querySelector('[data-action="refresh"]') : keyInput).focus();
  });
  on(dialog.querySelector('[data-action="close"]'), 'click', () => dialog.close());
  on(dialog, 'close', () => { clearDiagnostics(); clearAssistant('', true); render(); keyInput.value = ''; if (lastFocus?.isConnected) lastFocus.focus(); else button.focus(); });
  on(form('connect'), 'submit', event => {
    event.preventDefault();
    const code = keyInput.value.trim(), label = form('connect').elements.namedItem('label').value.trim();
    if (!/^kibi_link_[A-Za-z0-9_-]{32}$/.test(code) || !label) { keyInput.setAttribute('aria-invalid', 'true'); feedback(accountErrors.account_invalid_input, true); return; }
    keyInput.removeAttribute('aria-invalid');
    clearAssistant('', true);
    run(async () => { await api('/api/account/connect', { method: 'POST', body: { code, label } }); keyInput.value = ''; await load(); }, 'Аккаунт подключён к Studio.');
  });
  on(form('pair'), 'submit', event => {
    event.preventDefault();
    const input = form('pair').elements.namedItem('code'), code = input.value.trim();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code.replace(/[\s-]/g, '').toUpperCase())) { input.setAttribute('aria-invalid', 'true'); feedback(accountErrors.account_invalid_input, true); return; }
    input.removeAttribute('aria-invalid');
    run(async () => { await api('/api/account/pair', { method: 'POST', body: { code } }); input.value = ''; await load(); }, 'Киби привязан. Устройство получит своё подключение самостоятельно.');
  });
  on(form('voice'), 'submit', event => {
    event.preventDefault();
    const deviceId = form('voice').elements.namedItem('deviceId').value;
    if (!devices.some(device => device.id === deviceId) || info?.voiceEligibility?.canActivate !== true) return;
    run(async () => { await api('/api/account/voice', { method: 'POST', body: { deviceId } }); await load(); }, 'Настройка голоса обновлена. Текущий статус показан ниже.');
  });
  on(form('diagnostics').elements.namedItem('deviceId'), 'change', () => { selectedDeviceId = form('diagnostics').elements.namedItem('deviceId').value; clearDiagnostics(); render(); });
  on(dialog.querySelector('[data-action="diagnostics-refresh"]'), 'click', () => { void refreshDiagnostics(); });
  on(assistantField('deviceId'), 'change', () => { assistantDeviceId = assistantField('deviceId').value; clearAssistant(); render(); });
  for (const name of ['character', 'context']) on(assistantField(name), 'input', () => { part('assistant-status').textContent = assistantDirty() ? 'Есть несохранённые изменения. Сохраните профиль перед копированием роли.' : 'Профиль совпадает с сохранённым.'; render(); });
  on(dialog.querySelector('[data-action="assistant-load"]'), 'click', () => { void assistantRequest(); });
  on(form('assistant'), 'submit', event => { event.preventDefault(); void assistantRequest(true); });
  on(dialog.querySelector('[data-action="assistant-copy-role"]'), 'click', async () => {
    if (busy || assistantBusy || !assistantProfile || assistantDirty() || !assistantScope('assistant.read')) return;
    const sequence = assistantSequence, accountId = identity(), deviceId = assistantDeviceId;
    const current = () => !destroyed && sequence === assistantSequence && accountId === identity() && deviceId === assistantDeviceId;
    try { await globalThis.navigator.clipboard.writeText(assistantProfile.rolePrompt); if (current()) part('assistant-status').textContent = 'Роль скопирована. Вставьте её в настройку роли своей консоли Xiaozhi.'; }
    catch { if (current()) { assistantField('rolePrompt').focus(); assistantField('rolePrompt').select(); part('assistant-status').textContent = 'Текст роли выделен. Скопируйте его сочетанием клавиш и вставьте в свою консоль Xiaozhi.'; } }
  });
  on(dialog.querySelector('[data-action="refresh"]'), 'click', () => run(load));
  on(dialog.querySelector('[data-action="disconnect"]'), 'click', () => run(async () => {
    accountGeneration++; clearDiagnostics(); clearAssistant('', true);
    const result = await api('/api/account/disconnect', { method: 'POST', body: {} });
    info = result?.accountConnection || result; devices = []; keyInput.value = ''; render();
    if (result?.revocationConfirmed === false) return 'Studio отключена локально. Отзыв на сервере не подтверждён; проверьте подключения в личном кабинете.';
  }, 'Studio отключена от аккаунта.'));
  render();
  const ready = run(load, '');
  return { button, dialog, ready, refresh: () => run(load), destroy() { destroyed = true; accountGeneration++; clearDiagnostics(); clearAssistant('', true); for (const dispose of listeners) dispose(); if (dialog.open) dialog.close(); dialog.remove(); button.remove(); } };
}
