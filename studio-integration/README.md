# Серверные модули и фото чата в Kibi Studio

Публичное дополнение `studio-server-modules-2026-11-18-r2`, Node 24 без
npm-зависимостей. R2 добавляет локальный импорт фото, уже отправленного в чат,
через `kibi_import_asset({attachmentId})`. Это отдельный новый immutable cohort:
опубликованный `kibi-studio-server-modules-20261117-r1.tar.gz` не заменяется.

## Поддерживаемая основа

Основа — полная публичная Studio 0.3.1 из исторического commit
`5c82a27e8ca72658ace8d0cd3e7aff2494072ad3`, проверенный `release-candidate-4`.
SHA-256 базового ZIP:
`5c6560f205a3536fd38e8f03801f3ccdbd934aa7d15aeb3bf93ab2acf60cc4bb`.
`manifests/baselines.json` сохраняет все 26 исходных guard/dependency хешей;
сам manifest закреплён SHA-256 в updater. Личная установленная Studio,
`.studio`, проекты, credentials и прошивки не служат input сборки.

`manifests/previous-releases.json` сохраняет обе прежние группы preimages с ZIP
SHA-256 `1a7e6f168b1d2a0ca64e6b0aff39187ca2f9ca06f0ddc4fe5aa453d759d439ee`
и `8f5685a39b963f39cd5f79f8a023ed4a3d8951cb711c9de4d9c04173b78e8ee0`.
Дополнительно закреплены все 14 targets опубликованного r1 overlay с SHA-256
`0265ec18124013c1cc3ce55425d5becb594ebd9f6586523e4976c2fdf65d9643`,
доступного в предыдущем публичном commit
`49685789039da6cff8f45ffeb4a3d40b6fa245b9`. Неизвестные или локально
изменённые файлы отклоняются. Не добавляйте хеши неизвестной установки ради
обхода отказа.

R2 содержит ровно 17 named targets: прежние 14 и `src/server.mjs`,
`src/attachment-assets.mjs`, `docs/CHAT_PHOTOS.md`. Семь уже выпущенных guide
targets (`docs/{API,SDK,LOCAL_STUDIO,SERVER_MODULES,SERVER_MODULES_DEPLOY,YOUTUBE_MODULE}.md`
и `src/platform-guides/API.md`) сохраняются побайтно от r1. `src/server.mjs`
становится явным target, но его исходный хеш остаётся частью неизменного
26-файлового baseline. Source/config/build/flash guards вне named targets
проверяются и сохраняются.

## Обновление существующей поддерживаемой Studio

Остановите Studio. Сохраните существующие 17 named targets и список отсутствующих
путей для возврата; оставьте проекты и `.studio` на месте. Сверьте архив с
отдельно доверенным SHA-256. SHA-файл рядом с архивом проверяет повреждение,
а доверенный источник и новый точный Git commit проверяются отдельно.

```sh
shasum -a 256 -c kibi-studio-server-modules-20261118-r2.tar.gz.sha256
tar -xzf kibi-studio-server-modules-20261118-r2.tar.gz
node kibi-studio-server-modules/scripts/update.mjs --studio /absolute/existing-studio --check
node kibi-studio-server-modules/scripts/update.mjs --studio /absolute/existing-studio --apply
node kibi-studio-server-modules/scripts/update.mjs --studio /absolute/existing-studio --check
```

`--check` ничего не пишет. `--apply` проверяет весь payload и все исходные
guard-файлы до первой замены, затем заменяет только named targets. Символические
и жёсткие ссылки, неизвестные изменения и занятые новые пути дают отказ.
Повторное применение имеет пустой `changes`. При обычной ошибке записи updater
возвращает уже изменённые файлы; interrupted update можно повторить для известных
preimages. Для возврата версии восстановите только сохранённые named targets и
удалите только добавленные named targets при остановленном процессе.
Updater не сканирует проекты, `.studio`, auth/settings/accounts или runtime.

Полный ZIP/bootstrap предназначен для новой папки, а не для обновления поверх
существующей установки. Исторический base/source commit не является install pin
R2. Root публикует весь новый cohort одним commit, затем фиксирует его точный
40-символьный SHA и проверяет публичные файлы именно этого commit.

## Фото из чата

Фото уже поступает модели как визуальный JPEG-вход. ИИ получает
`platform.chatAttachments` в `kibi_project_context` и сопоставление текущего
порядка image inputs в `CURRENT USER PHOTO ATTACHMENTS`. Для ресурса приложения
он использует ID существующего фото: `kibi_import_asset({attachmentId})`.
Публичная ссылка или повторная загрузка не требуются. Публичный импорт
`{url}` / `{url,recipe}` остаётся отдельным взаимоисключающим вариантом.

PNG обрабатывает штатный локальный растеризатор; JPEG/WebP на Mac преобразует
встроенный `sips`. Новые пакеты и сетевой конвертер не устанавливаются.
Данные доступны только текущему проекту, guards проверяются повторно перед
добавлением в защищённый банк ресурсов. Возвращается точный RGB565/alpha API
для макета и прошивки. Импорт не запускает модель, компиляцию или USB-запись.
Подробности и честные ошибки: [docs/CHAT_PHOTOS.md](docs/CHAT_PHOTOS.md).

## Сборка и проверка публичного кандидата

```sh
node studio-integration/scripts/package.mjs --out /absolute/new-overlay-output
node studio-integration/scripts/package-full.mjs --base-dir /absolute/verified-public-release-candidate-4 --out /absolute/new-full-output
```

Overlay builder создаёт новый r2 archive и отказывается заменять файл с тем же
именем другим содержимым. Полный кандидат `studio-full-2026-11-18-r2` сохраняет
все 135 neutral `projects/kibi-base/` и `templates/` файлов. Наружные
`bootstrap.sh`, `bootstrap.py`, `runtime-lock.json` сохранены от проверенной базы.
Исправленный Node bootstrap с SHA-256
`adfc7eb70bdea022b70b95c8e733e29e51e6dc423e4c0fe3069bf8eb834615f7`
не меняется и совпадает с `scripts/bootstrap.mjs` внутри ZIP.

`publication.json` перечисляет точные восемь root-файлов для совместной публикации
в GitHub: ZIP, ZIP.sha256, manifest, release, три bootstrap-файла и runtime-lock.
До Git publication метаданные содержат `published:false` / `candidate:true`.
base/sourceCommit обозначает происхождение; старый SHA установит старую Studio.
Новый install commit появляется только после публикации root. `PUBLISH.md`
описывает проверку нового commit и установку в новый destination.

Тесты упаковки проверяют воспроизводимость, decode roundtrip, `bootstrap.verifyKit`,
17-target updater, точный переход с r1, неизвестные изменения и неизменность
нейтрального starter. Для интеграционных тестов задаются только публичные fixture:

```sh
KIBI_STUDIO_PUBLIC_FIXTURE=/absolute/synthetic-public-studio KIBI_STUDIO_PREVIOUS_RELEASE=/absolute/previous-1a7-candidate KIBI_STUDIO_CURRENT_RELEASE=/absolute/current-8f56-candidate KIBI_STUDIO_PUBLIC_RELEASE=/absolute/verified-public-release-candidate-4 node --test studio-integration/tests/full-package.test.mjs studio-integration/tests/updater.test.mjs
```

Без соответствующих fixture часть проверок пропускается и не подтверждает путь
обновления. Тесты не читают пользовательские проекты, auth или private runtime.
Проверка ZIP/updater не означает сетевую установку, запуск модели, доступ к
провайдеру или физическую работу платы. Публикация и привязка серверного модуля
также не доказывают invoke; старые account scopes автоматически не расширяются.
