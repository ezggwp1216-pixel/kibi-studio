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
  account_voice_unavailable: 'Для этого аккаунта подключение голоса сейчас недоступно.',
  studio_voice_not_approved: 'Владелец сервера ещё не разрешил голос для этого аккаунта.',
  studio_voice_xiaozhi_required: 'Владелец сервера должен выбрать голосовой сервис Xiaozhi.',
  xiaozhi_not_configured: 'Владелец сервера должен завершить настройку Xiaozhi.',
  voice_closed: 'Голосовой шлюз сейчас закрыт.',
};
const voiceStates = { disabled: 'Голос выключен', not_configured: 'Голос не настроен', listening: 'Голосовой шлюз ожидает устройство', connecting: 'Устанавливается голосовое подключение', active: 'Есть активное голосовое подключение', error: 'Ошибка голосового подключения', closed: 'Голосовой шлюз закрыт' };
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
      <div class="ksa-disconnect"><button type="button" class="ksa-text-button" data-action="disconnect">Отключить Studio от аккаунта</button></div>
    </section>`;
  mount.append(button); document.body.append(dialog);
  const part = name => dialog.querySelector(`[data-part="${name}"]`);
  const form = name => dialog.querySelector(`[data-form="${name}"]`);
  const keyInput = form('connect').elements.namedItem('code');
  let info = null, devices = [], busy = false, destroyed = false, lastFocus = null;
  const listeners = [];
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
    const eligibility = info?.voiceEligibility || info?.voice?.studioVoice;
    part('voice-status').textContent = voiceStates[info?.voice?.status] || 'Статус голоса ещё не проверен';
    const canActivate = eligibility?.canActivate === true;
    part('eligibility').textContent = canActivate
      ? (devices.length ? 'Подключение доступно для вашего Киби.' : 'Сначала привяжите своего Киби по коду с экрана.')
      : accountErrors[eligibility?.code] || 'Доступ к голосу определяет владелец сервера. Обновите статус, чтобы проверить разрешение.';
    form('voice').hidden = !canActivate || devices.length === 0;
    dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
    for (const control of dialog.querySelectorAll('input, select, button')) control.disabled = busy && control.dataset.action !== 'close';
  }
  async function load() {
    const data = await api('/api/account');
    if (destroyed) return;
    info = data?.accountConnection || data?.connectionStatus || data;
    if (info?.connected) {
      const data = await api('/api/account/devices');
      if (destroyed) return;
      devices = Array.isArray(data?.devices) ? data.devices.filter(device => isUUID(device?.id) && typeof device.name === 'string' && device.name.length <= 64).slice(0, 50) : [];
    } else devices = [];
    render();
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
  on(dialog, 'close', () => { keyInput.value = ''; if (lastFocus?.isConnected) lastFocus.focus(); else button.focus(); });
  on(form('connect'), 'submit', event => {
    event.preventDefault();
    const code = keyInput.value.trim(), label = form('connect').elements.namedItem('label').value.trim();
    if (!/^kibi_link_[A-Za-z0-9_-]{32}$/.test(code) || !label) { keyInput.setAttribute('aria-invalid', 'true'); feedback(accountErrors.account_invalid_input, true); return; }
    keyInput.removeAttribute('aria-invalid');
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
  on(dialog.querySelector('[data-action="refresh"]'), 'click', () => run(load));
  on(dialog.querySelector('[data-action="disconnect"]'), 'click', () => run(async () => {
    const result = await api('/api/account/disconnect', { method: 'POST', body: {} });
    info = result?.accountConnection || result; devices = []; keyInput.value = ''; render();
    if (result?.revocationConfirmed === false) return 'Studio отключена локально. Отзыв на сервере не подтверждён; проверьте подключения в личном кабинете.';
  }, 'Studio отключена от аккаунта.'));
  render();
  const ready = run(load, '');
  return { button, dialog, ready, refresh: () => run(load), destroy() { destroyed = true; for (const dispose of listeners) dispose(); if (dialog.open) dialog.close(); dialog.remove(); button.remove(); } };
}
