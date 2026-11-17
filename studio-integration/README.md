# Серверные модули в Kibi Studio

Публичное дополнение `studio-server-modules-2026-11-17-r1`, Node 24 без npm-зависимостей. Это не полная Studio и не серверный backend. Личная установленная Studio, проекты, `.studio`, auth/settings/accounts, прошивки и голосовое подключение этим комплектом не переносятся.

## Поддерживаемая основа

Поддерживается полная публичная GitHub-поставка Studio 0.3.1 из commit `5c82a27e8ca72658ace8d0cd3e7aff2494072ad3`. Она уже содержит платформенные hooks complete-r3; отдельно устанавливать старый overlay не нужно. Сверены все 26 исходных guard/dependency хеша (22 program/dependency и четыре существующие инструкции) с `release-candidate-4/kibi-studio-local.manifest.json`: каждый совпал. Полная сверка находится в `manifests/github-baseline-verification.json`; SHA-256 исходного ZIP: `5c6560f205a3536fd38e8f03801f3ccdbd934aa7d15aeb3bf93ab2acf60cc4bb`.

Хеши именованных публичных программных файлов находятся в `manifests/baselines.json`; сам manifest закреплён SHA-256 внутри updater. Отдельный `manifests/previous-releases.json` закрепляет точные program preimages двух ранее подготовленных публичных candidates (ZIP SHA-256 `1a7e6f168b1d2a0ca64e6b0aff39187ca2f9ca06f0ddc4fe5aa453d759d439ee` и ZIP SHA-256 `8f5685a39b963f39cd5f79f8a023ed4a3d8951cb711c9de4d9c04173b78e8ee0`); SHA-256 этого manifest тоже зашит в updater. Он позволяет безопасно получить актуальные инструкции, worker labels и исправление выбора версии после rollback на обеих известных версиях. Неизвестные старые или локально изменённые программные файлы отклоняются. Не добавляйте хеш неизвестной установки, чтобы обойти отказ.

Обновляются только `src/studio-account.mjs`, `src/studio-platform.mjs`, `web/app.js`, `web/index.html`; добавляются `src/studio-plugins.mjs`, `web/server-modules.js`, `web/server-modules.css`. `src/server.mjs` и существующие source/config/build/flash guards проверяются и сохраняются. Штатный host уже включает platform tools/context/routes и platformInstructions; новая toolset revision рассчитана штатным host. Prompts на диске не заменяются. Дополнительно обновляются ровно семь публичных инструкций: `docs/{API,SDK,LOCAL_STUDIO,SERVER_MODULES,SERVER_MODULES_DEPLOY,YOUTUBE_MODULE}.md` и существующий `src/platform-guides/API.md`. Четыре существующих preimages закреплены по проверенному исходному ZIP; неизвестный новый путь также отклоняется до записи.

## Применение в отдельную development-копию

Сначала остановите процесс этой копии Studio и сохраните исходную публичную копию для возврата. Проверяйте хеш архива по отдельно полученному значению релиза. SHA-файл рядом с архивом обнаруживает повреждение, но сам по себе не подтверждает доверенный источник.

```sh
shasum -a 256 -c kibi-studio-server-modules-20261117-r1.tar.gz.sha256
tar -xzf kibi-studio-server-modules-20261117-r1.tar.gz
node kibi-studio-server-modules/scripts/update.mjs --studio /absolute/development-studio --check
node kibi-studio-server-modules/scripts/update.mjs --studio /absolute/development-studio --apply
node kibi-studio-server-modules/scripts/update.mjs --studio /absolute/development-studio --check
```

`--check` ничего не пишет. `--apply` сначала проверяет весь payload и все исходные guard-файлы, затем готовит временные файлы и заменяет только разрешённые пути. Символические/жёсткие ссылки, неизвестные исходники и занятый новый путь приводят к отказу до замены. Повторное применение имеет пустой `changes`. Тот же updater применим к существующей поддерживаемой Studio при остановленном процессе: сохраните существовавшие 14 named targets и список отсутствовавших путей для возврата; проекты и приватные данные оставьте на месте. Полный ZIP/bootstrap нельзя использовать как updater поверх установки. При обычной ошибке записи updater пытается вернуть уже заменённые файлы; `studio_update_rollback_incomplete` требует восстановить исходную публичную development-копию. При завершении процесса посреди обновления повторная проверка и применение допускают только исходные, закреплённые предыдущие или точные новые хеши. Во время обновления не редактируйте файлы.

Updater не просматривает каталог установки, проекты или приватные данные, не выполняет код из пакетов модулей, не устанавливает зависимости, не обращается в сеть и не прошивает устройство. Не переносите development-копию поверх личной установки.

## Что появляется

В заголовке Studio — «Серверные модули»: публикация публичного JSON-пакета с SHA-256, список собственных версий и устройств, назначение/включение/отключение, обновление и возврат предыдущей ревизии привязки. Действия используют реальный локальный API host и аккаунтный сервер, а не браузерное хранилище.

Инструменты ИИ: `kibi_server_modules`, `kibi_publish_server_module`, `kibi_device_modules`, `kibi_bind_server_module`, `kibi_rollback_server_module`. Для публикации модель передаёт только `kibi_publish_server_module({packageText})`; доверенный код Studio сам вычисляет точную SHA-256 от UTF-8 текста и передаёт строгие `{packageText,sha256}` клиенту и серверу. Пользователю не нужно вычислять или вставлять хеш. Лишнее поле `sha256` в вызове инструмента отклоняется; HTTP UI API сохраняет обязательную пару полей, и браузер вычисляет хеш через crypto. Серверная проверка SHA не ослаблена.

Мутации проходят существующий host gate и захватывают project/epoch. Серверный bearer остаётся только в приватном account store; браузер использует прежний CSRF-клиент. Текст пакета публичный — ключи/пароли в него не включайте.

Старые подключения сохраняют пять/семь прежних разрешений. Для modules нужно явно создать в кабинете новый ключ с разрешением «Серверные модули» и подключить его в форме «Аккаунт». Заголовок `plugins-v1` не выдаёт права. Отключённый аккаунт, недостаточные права и старый сервер показаны отдельными состояниями. Публикация и привязка могут работать без исполнителя; UI показывает реальные runtime/media capabilities. При `configured:true/available:false` worker обозначен «Доступность не подтверждена»: это может быть как ещё не проверенная, так и неуспешная конфигурация. Наличие пакета не доказывает запуск, YouTube-кадры, звук или работу платы. Пример YouTube первоначально без звука. Расписания не реализованы.

Инструкции модели реально включаются штатным host через `platformInstructions`, без замены пользовательских prompts. `kibi_server_guide({topic:"server-modules"})` возвращает ограниченную актуальную инструкцию offline: полный v2 manifest, `onDeviceRequest/onDeviceEvent/onDeviceMessage`, публичные settings без секретов, публикация/назначение, HTTPS invoke токеном самой Киби, проверки бинарного кадра и состояния приложения, disable/update/rollback. В guide есть публичные ссылки `SERVER_MODULES.md` и `YOUTUBE_MODULE.md`. Старый v1 SDK structural validator и его `execution:false` сохранены; прежнее «planned» не отменяет отдельный реализованный v2 API.

Готового общего firmware SDK helper для invoke этот overlay не добавляет. Приложение после «Проект готов» реализует ограниченный запрос по точному API, используя свой приватный pairing/token owner без передачи токена модели. Studio/кабинет показывают worker capabilities и ошибки управления пакетами; истории invoke здесь нет, конкретный код вызова должно показывать приложение на Киби. `HTTP 424 plugin_media_provider_restricted` означает «YouTube ограничил доступ к видео»; не собирайте cookies и не обходите ограничения источника. Эта ошибка не доказывает получение кадра. Откат доступен только для существующих последних 16 предыдущих ревизий привязки; отдельного history-list инструмента нет.

## Полная Git-поставка

`scripts/package-full.mjs` принимает только закреплённый публичный release-candidate-4, сравнивает 26 guard/dependency, меняет семь программных и семь документальных targets overlay и добавляет публичный release marker. Нейтральные `projects/kibi-base/` и `templates/` проверяются побайтно. Личная установка не является input.

```sh
node studio-integration/scripts/package-full.mjs --base-dir /absolute/verified-public-release-candidate-4 --out /absolute/new-candidate-output
```

`publication.json` перечисляет точные восемь файлов для совместной публикации в корень `ezggwp1216-pixel/kibi-studio` с SHA-256 и размерами. `PUBLISH.md` содержит порядок публикации root, проверку нового точного Git commit и установку в новый destination с `--install-only`; code/login не запускаются этим флагом, но bootstrap скачивает проверенный private runtime. Здесь проверяются decode/encode roundtrip, `bootstrap.verifyKit` и updater; это не факт сетевой установки. Старый `baseCommit/sourceCommit` — только происхождение, bootstrap с ним установит старую публичную Studio. Новый commit должен появиться после реальной публикации root. Полный кандидат и overlay — разные артефакты; существующую Studio обновляют только named-files-only updater.

## Сборка и проверки

Из корня репозитория модулей:

```sh
node studio-integration/scripts/package.mjs --out /absolute/output
KIBI_STUDIO_PUBLIC_FIXTURE=/absolute/synthetic-public-studio KIBI_STUDIO_PREVIOUS_RELEASE=/absolute/previous-1a7-candidate KIBI_STUDIO_CURRENT_RELEASE=/absolute/current-8f56-candidate KIBI_STUDIO_PUBLIC_RELEASE=/absolute/verified-public-release-candidate-4 KIBI_STUDIO_PLAYWRIGHT_MODULE=/absolute/playwright/index.js KIBI_STUDIO_BROWSER_EXECUTABLE=/absolute/chrome node --test studio-integration/tests/*.test.mjs
```

Fixture — только synthetic тестовая публичная установка указанной версии. Тесты копируют строго именованные `src/`, `web/`, `docs/`, `package.json`; они не читают `.studio` или `projects` исходной fixture. Без соответствующих переменных тесты updater/upgrade предыдущего candidate/полного архива пропущены, поэтому такой запуск не подтверждает все пути применения к Studio. DOM-регрессии запускают настоящий Chromium в новом временном профиле с перехваченными локальными HTTP routes, без сети или реальной модели. Playwright — только внешняя QA-зависимость, в runtime payload не входит. Изолированные client/platform тесты применяют injected transport без внешних запросов. Для выпуска также нужен полный `node --test` backend и реальные локальные HTTP/browser проверки. Docker/media и физическое воспроизведение требуют отдельной проверки.
