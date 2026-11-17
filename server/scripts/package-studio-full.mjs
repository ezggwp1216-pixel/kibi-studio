import {readFile,writeFile,mkdir,mkdtemp,rm,lstat,realpath,rename,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {decodeReleaseZip,encodeFullPackage,UPSTREAM_COMMIT,UPSTREAM_ZIP_SHA256,UPSTREAM_MANIFEST_SHA256,assertDistributionPath} from '../studio/full-release.mjs';
import {FRESH_SDK_PAYLOADS} from '../sdk/device/fresh-profile.mjs';
import {STUDIO_PUBLIC_PAYLOADS} from '../studio/upgrade.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const exists=async path=>{try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
async function ordinary(root,name,limit=256*1024*1024){
 const filename=join(root,name),s=await lstat(filename);
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>limit||await realpath(filename)!==filename)throw fail('unsafe_public_input');
 const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const opened=await handle.stat();if(opened.dev!==s.dev||opened.ino!==s.ino||!opened.isFile()||opened.nlink!==1||opened.size>limit)throw fail('changing_public_input');const bytes=await handle.readFile();const after=await handle.stat();if(bytes.length!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs)throw fail('changing_public_input');return bytes;}
 finally{await handle.close();}
}
async function put(root,name,bytes){
 assertDistributionPath(name);const target=join(root,name);
 await mkdir(dirname(target),{recursive:true,mode:0o755});
 await writeFile(target,bytes,{flag:'wx',mode:name.endsWith('.command')?0o755:0o644});
}
async function replacePublic(root,name,bytes,expected){
 const current=await exists(join(root,name))?await ordinary(root,name):null;
 if((current===null?null:digest(current))!==expected)throw fail('changing_public_input');
 await mkdir(dirname(join(root,name)),{recursive:true,mode:0o755});
 await writeFile(join(root,name),bytes,{flag:current===null?'wx':'w',mode:0o644});
}

const startHere=`# Киби Studio: установка с нуля

Откройте новый локальный проект Codex с терминалом и передайте ему bootstrap-prompt.txt.
Для публичного репозитория GitHub-вход не нужен. Нужны Mac, интернет и около 2 ГБ
свободного места. Установщик сам скачивает закреплённые Node и Codex; при отсутствии
Chrome/Edge он предлагает подписанный Chrome. Arduino IDE, Python, Homebrew и Xcode
пользователю не нужны. Исходники и история проекта хранятся локально, компиляция
предпросмотра и прошивки выполняется сервером Киби, USB-загрузка — локальным браузером.

Инструкция помощнику:

1. Один раз определите полный SHA main через публичный GitHub API; сохраните уже
   указанный пользователем SHA. Все последующие файлы берите из этого же коммита.
2. Загрузите START_HERE.md, release.json и bootstrap.sh из raw.githubusercontent.com/
   ezggwp1216-pixel/kibi-studio/<SHA>/. Проверьте SHA-256 bootstrap.sh по
   bootstrapShellSha256 до запуска. Не используйте curl | sh.
3. Выберите новую абсолютную папку под текущим рабочим каталогом. Запустите сохранённый
   проверенный bootstrap.sh с --commit <SHA> --destination '<новая папка>'. Ничего не
   устанавливайте поверх существующей Studio. --install-only не выполняет вход и запуск.
4. Пользователь сам завершает официальный вход ChatGPT в браузере. Пароли, OTP, API-ключи
   и коды подключения не вводятся в чат; auth.json и личные настройки не открываются.
5. Откройте выданный локальный адрес в Chrome/Edge. При занятом порте выберите свободный
   через KIBI_STUDIO_PORT; чужие процессы не останавливайте. Проверьте настоящее сообщение,
   текущий кадр и касания. Наличие Node само по себе не доказывает работу редактора.
6. Полный комплект уже содержит согласованные программы, SDK, инструкции и каталог
   Xiaozhi. Дополнительный старый overlay поверх него не нужен. Проверьте фактический
   kibi_project_context и каталог модулей, не судите об установке по тексту README.

Новый проект: опишите идею, согласуйте макет и управление, нажмите «Проект готов».
Studio проверит реализацию, после готовности покажет «Собрать прошивку».
Wi-Fi/API заполняются только по необходимости в закрытых настройках. Установка на плату
потребует отдельного USB-подключения, проверенного плана и подтверждения записи.

Аккаунт Киби не нужен для автономного проекта. Для сервера и своего Xiaozhi зарегистрируйтесь
на https://sldvkibi.ru/server/, получите код подключения Studio и введите его в форму
«Аккаунт». После прошивки отдельно привяжите код самой платы. Затем в своём кабинете
подключите собственный Xiaozhi, выберите Киби, сохраните характер и перенесите роль в
официальную консоль Xiaozhi. Подробности: docs/STUDIO_CONNECTION.md внутри комплекта.
Бесплатный Open Source режим Xiaozhi применяется по его соглашению, не обещает постоянный
бесплатный или коммерческий доступ. Вход и соглашение подтверждает сам пользователь.

Повторный запуск — «Запустить Киби Studio.command» в папке установки. Не удаляйте .studio
или проекты при обновлении. Установка/проверки программы не заменяют отдельный тест платы.
`;
const bootstrapPrompt=`Установи для меня Киби Studio в новую папку по START_HERE.md из публичного репозитория https://github.com/ezggwp1216-pixel/kibi-studio . Если полный commit SHA уже указан, сохрани его; иначе один раз определи SHA main и перечитай инструкцию именно из него. Проверь установщик, архив и manifest по release.json до запуска. Используй полный комплект этой версии с текущими программами, SDK и каталогом модулей; не заменяй его старым overlay. Пусть установщик сам загрузит необходимые Node/Codex и при необходимости подписанный Chrome. Не ставь вручную Arduino, Python, Homebrew или Xcode. Помоги мне завершить официальный вход ChatGPT и открой локальную Studio. Не читай auth.json, личные настройки или другие проекты, не запрашивай API-ключ для чата и не прошивай плату. Проверь настоящее сообщение и макет, затем спроси, какое приложение я хочу создать.\n`;
const readme=`# Киби Studio

Полная локальная мастерская приложений для Киби: свой ChatGPT, макет, исходники,
серверная компиляция и подтверждаемая USB-установка. Комплект0.3.1 включает
программы платформы r3, актуальный аппаратный SDK и готовый клиент Xiaozhi.

Начните с [START_HERE.md](START_HERE.md): передайте [стартовый промпт](bootstrap-prompt.txt)
локальному Codex с терминалом. Установщик проверит файлы по закреплённому commit и
контрольным суммам и загрузит необходимую среду в новую папку. Пользователь сам
завершает официальный вход ChatGPT. Обычный веб-чат без локальных инструментов
не может установить редактор на компьютер.

Новый проект → идея → согласование макета и управления → «Проект готов» →
проверка кода → сборка сервером → подтверждённая установка через USB.
Для локального чата не нужен API-ключ OpenAI, для автономного приложения — аккаунт Киби.
Wi-Fi и ключи сервиса вводятся в предназначенных формах только по необходимости.

Для своего Xiaozhi и серверных функций подключите личный кабинет на
https://sldvkibi.ru/server/ . Studio, физическая плата и Xiaozhi связываются разными
кодами. Сохранённый характер один раз переносится в своего агента Xiaozhi вручную;
контекст и разрешённые действия обслуживает сервер. Условия Xiaozhi принимаются
пользователем отдельно.

[Полный комплект](kibi-studio-local.zip), [release](release.json),
[manifest](kibi-studio-local.manifest.json) и [runtime-lock](runtime-lock.json).
Источники, история и настройки остаются локально; сервер получает необходимые
исходники и параметры для компиляции. В поставке нет личных данных и прошивок.
Проверки программы и компиляция не заменяют отдельную проверку звука, тача и сети на Киби.
`;

const guides=['API.md','VOICE.md','HARDWARE.md','SERVICES.md','LOCAL_STUDIO.md','SDK.md','SDK_UPDATE.md','STUDIO_CONNECTION.md'];
export function completeStudioSourcePaths(){
 const helpers=['scripts/package-studio-full.mjs','studio/full-release.mjs','studio/upgrade.mjs','studio/portable-design-upgrade.mjs','studio/new-project-upgrade.mjs','studio/module-upgrade.mjs','studio/automatic-build-upgrade.mjs','studio/full-install-upgrade.mjs','studio/fresh-server-upgrade.mjs','studio/fresh-ui-upgrade.mjs','sdk/device/fresh-profile.mjs','sdk/device/instructions.md'];
 return[...new Set([...helpers,...STUDIO_PUBLIC_PAYLOADS.map(file=>file.source),...guides.map(name=>'docs/'+name),...Object.entries(FRESH_SDK_PAYLOADS).map(([key,hash])=>key==='instructions'?'sdk/device/instructions.md':'sdk/device/overlays/files/'+hash+'.txt')])];
}

/** Creates a new complete public candidate; never enumerates an installation. */
export async function packageCompleteStudio({upstreamDir,outputDir,sourceRoot=repository,onPhase=()=>{}}={}){
 if(typeof upstreamDir!=='string'||typeof outputDir!=='string')throw fail('package_paths_required');
 if(typeof onPhase!=='function')throw fail('invalid_package_hook');
 upstreamDir=await realpath(resolve(upstreamDir));sourceRoot=await realpath(resolve(sourceRoot));
 outputDir=join(await realpath(dirname(resolve(outputDir))),resolve(outputDir).split('/').at(-1));
 if(await exists(outputDir))throw fail('package_destination_exists');
 const releaseBytes=await ordinary(upstreamDir,'upstream-release.json',65536),manifestBytes=await ordinary(upstreamDir,'kibi-studio-local.manifest.json',4*1024*1024),archive=await ordinary(upstreamDir,'kibi-studio-local.zip',64*1024*1024),release=JSON.parse(releaseBytes);
 if(digest(archive)!==UPSTREAM_ZIP_SHA256||digest(manifestBytes)!==UPSTREAM_MANIFEST_SHA256||release.sha256!==UPSTREAM_ZIP_SHA256||release.manifestSha256!==UPSTREAM_MANIFEST_SHA256)throw fail('unknown_public_seed');
 const upstreamManifest=JSON.parse(manifestBytes),baseFiles=decodeReleaseZip({release,manifest:upstreamManifest,archive});
 const stage=await mkdtemp(join(dirname(outputDir),'.kibi-complete-stage-'));
 const sourceStage=await mkdtemp(join(dirname(outputDir),'.kibi-source-stage-'));
 try{
  const sourceNames=completeStudioSourcePaths();
  const witness=new Map();
  for(const name of sourceNames){const bytes=await ordinary(sourceRoot,name,4*1024*1024);await put(sourceStage,name,bytes);witness.set(name,digest(bytes));}
  const recheckSources=async()=>{for(const[name,hash]of witness)if(digest(await ordinary(sourceRoot,name,4*1024*1024))!==hash)throw fail('changing_public_cohort');};
  await recheckSources();await onPhase('sources-snapshotted');
  const {planFreshSdk}=await import(pathToFileURL(join(sourceStage,'sdk/device/fresh-profile.mjs')).href);
  const {upgradeStudio}=await import(pathToFileURL(join(sourceStage,'studio/upgrade.mjs')).href);
  const files=new Map([...baseFiles].filter(([name])=>!name.startsWith('projects/')));
  for(const[name,bytes]of files)await put(stage,name,bytes);
  const sdk=await planFreshSdk({root:stage,kitRoot:join(sourceStage,'sdk/device')});
  for(const file of sdk.files){await replacePublic(stage,file.path,file.bytes,file.beforeSha256);files.set(file.path,file.bytes);}
  const planned=await upgradeStudio({root:stage,sourceRoot:sourceStage,apply:false});
  const applied=await upgradeStudio({root:stage,sourceRoot:sourceStage,apply:true});
  if(JSON.stringify(planned.changes)!==JSON.stringify(applied.changes))throw fail('changing_public_cohort');
  for(const file of applied.changes)files.set(file.path,await ordinary(stage,file.path,4*1024*1024));
  const template=JSON.parse(files.get('templates/kibi-base/manifest.json'));
  if(template.boardId!=='kibi-ds02-s3-16m'||!Array.isArray(template.files))throw fail('neutral_template_invalid');
  for(const entry of template.files){
   const bytes=files.get('templates/kibi-base/'+entry.path);
   if(!bytes||bytes.length!==entry.size||digest(bytes)!==entry.sha256)throw fail('neutral_template_integrity');
   files.set('projects/kibi-base/'+entry.path,Buffer.from(bytes));
  }
  const seed=JSON.parse(files.get('projects/kibi-base/project.json'));
  if(seed.id!=='kibi-base'||seed.boardId!==template.boardId||seed.requirements?.wifi!==false||seed.requirements?.api!==false)throw fail('neutral_template_invalid');
  const packageJson=JSON.parse(files.get('package.json'));packageJson.version='0.3.1';packageJson.engines={node:'>=24'};files.set('package.json',json(packageJson));
  files.set('START_HERE.md',Buffer.from(startHere));files.set('bootstrap-prompt.txt',Buffer.from(bootstrapPrompt));files.set('README.md',Buffer.from(readme));
  for(const name of guides)files.set('docs/'+name,await ordinary(join(sourceStage,'docs'),name,2*1024*1024));
  files.set('resources/platform-release.json',json({schemaVersion:1,release:'studio-full-2026-11-17-r3',sourceCommit:UPSTREAM_COMMIT,platformRelease:applied.release,sdkRelease:sdk.release,neutralStarter:true,privateDataIncluded:false,providerVerified:false,hardwareVerified:false}));
  const output=encodeFullPackage(files,{publicSdkExceptions:upstreamManifest.publicSdkExceptions||[]});
  const shell=files.get('scripts/bootstrap.sh'),node=files.get('scripts/bootstrap.mjs'),lock=files.get('scripts/runtime-lock.json'),python=files.get('scripts/bootstrap.py');
  if(!shell||!node||!lock)throw fail('bootstrap_incomplete');
  Object.assign(output.release,{bootstrapShellSha256:digest(shell),bootstrapNodeSha256:digest(node),runtimeLockSha256:digest(lock),...(python?{bootstrapSha256:digest(python)}:{})});
  // Verify the composed archive again before any destination is published.
  const verified=decodeReleaseZip(output);if(verified.size!==files.size)throw fail('package_verification_failed');
  const finalStage=await mkdtemp(join(dirname(outputDir),'.kibi-release-stage-'));
  try{
   const publications=new Map([
    ['kibi-studio-local.zip',output.archive],['kibi-studio-local.zip.sha256',Buffer.from(output.release.sha256+'  kibi-studio-local.zip\n')],['kibi-studio-local.manifest.json',json(output.manifest)],['release.json',json(output.release)],
    ['bootstrap.sh',shell],['bootstrap.mjs',node],['runtime-lock.json',lock],
    ['START_HERE.md',Buffer.from(startHere)],['bootstrap-prompt.txt',Buffer.from(bootstrapPrompt)],['README.md',Buffer.from(readme)],
   ]);
   if(python)publications.set('bootstrap.py',python);
   const report={ok:true,release:output.release.release,version:output.release.version,sourceCommit:UPSTREAM_COMMIT,archiveBytes:output.archive.length,archiveSha256:output.release.sha256,files:verified.size,sdkProfile:sdk.profile.id,platformChanges:planned.changes.length,privateProjectsRead:false,privateDataIncluded:false,published:false};
   publications.set('verification.json',json(report));
   for(const[name,bytes]of publications)await writeFile(join(finalStage,name),bytes,{flag:'wx',mode:0o644});
   await onPhase('before-publication');await recheckSources();
   await rename(finalStage,outputDir);return{...report,outputDir};
  }finally{await rm(finalStage,{recursive:true,force:true});}
 }finally{await rm(stage,{recursive:true,force:true});await rm(sourceStage,{recursive:true,force:true});}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const args=process.argv.slice(2),options={};for(let index=0;index<args.length;index++){const key={'--upstream-dir':'upstreamDir','--output-dir':'outputDir'}[args[index]];if(!key||!args[index+1])throw fail('invalid_package_arguments');options[key]=args[++index];}console.log(JSON.stringify(await packageCompleteStudio(options)));}
 catch(error){console.error(JSON.stringify({ok:false,code:error.code||'package_failed',path:error.path||null}));process.exitCode=1;}
}
