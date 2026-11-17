import {constants} from 'node:fs';
import {writeFile,mkdir,mkdtemp,rm,lstat,realpath,rename,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {PAYLOAD_FILES} from './update.mjs';

const overlay=fileURLToPath(new URL('../',import.meta.url));
const BASE_COMMIT='5c82a27e8ca72658ace8d0cd3e7aff2494072ad3';
const RELEASE='studio-full-server-modules-20261117-rc1';
const BASE_ZIP_SHA='5c6560f205a3536fd38e8f03801f3ccdbd934aa7d15aeb3bf93ab2acf60cc4bb';
const BASE_MANIFEST_SHA='374736db38271ade664cbc6ff53a4e878d466f41167433cc7e1dcc868dfb3564';
const BASE_RELEASE_SHA='fd0594a34d8bc98b25a4a3a68190b6de1d0220fe3bdf8de17ec94a4b2cb9bcf2';
const BASELINE_SHA='3522c57a2434a37f8eef35d556aa6b4d55e3bd309e0484be6e4a83b81b8c1c96';
const HELPER_SHA='45cf98639d1c06b6ea3c03604cb167dede4651e751fa90afe9cf419ea2453b87';
const FIXED_NODE_BOOTSTRAP_SHA='adfc7eb70bdea022b70b95c8e733e29e51e6dc423e4c0fe3069bf8eb834615f7';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const fail=(code,file)=>Object.assign(new Error(code),{code,...(file?{file}:{})});
const run=promisify(execFile);
const exists=async filename=>{try{await lstat(filename);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};

async function ordinary(filename,limit=2*1024*1024){
  const stat=await lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit||await realpath(filename)!==filename)throw fail('full_package_unsafe_input');
  const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const opened=await handle.stat();
    if(!opened.isFile()||opened.nlink!==1||opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size)throw fail('full_package_changing_input');
    const bytes=await handle.readFile(),after=await handle.stat();
    if(bytes.length!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw fail('full_package_changing_input');
    return bytes;
  }finally{await handle.close();}
}

const publicationReadme=`# Публикация полной Киби Studio с серверными модулями

Этот каталог — подготовленный публичный кандидат. Публикацией Git управляет root;
скрипт сборки не делает commit/push и не заявляет установку на компьютер пользователя.
publication.json перечисляет ТОЧНО восемь файлов для корня отдельного публичного
GitHub-репозитория ezggwp1216-pixel/kibi-studio с SHA-256 и размерами. README.md,
PUBLISH.md и verification.json — отчёты, они не заменяют существующие GitHub docs.
Не публикуйте весь worktree, проекты, runtime, .studio, auth.json или QA-каталоги.

1. Root проверяет каждый из восьми файлов по publication.json и отдельно проверяет
   ZIP/manifest/release через bootstrap.verifyKit. В новом Git commit размещается
   весь cohort сразу: ZIP, ZIP.sha256, manifest, release, bootstrap.sh, bootstrap.mjs,
   bootstrap.py и runtime-lock.json. Любой из них от другого релиза даёт смешанную
   установку и не допускается. SHA-файл рядом с ZIP проверяет повреждение; доверенный
   источник и новый точный Git SHA проверяются отдельно.
2. После публикации получите НОВЫЙ точный 40-символьный Git commit и проверьте
   публичные raw файлы этого commit по publication.json. baseCommit/sourceCommit
   5c82a27e8ca72658ace8d0cd3e7aff2494072ad3 — происхождение, не адрес нового ZIP.
   Использование этого старого SHA поставит старую Studio. Не объявляйте новый SHA
   до реального commit/push. Флаги candidate/published описывают состояние сборки.
3. Установку проверяйте в НОВОМ абсолютном destination, без замены личной Studio:

   shasum -a 256 bootstrap.sh
   sh bootstrap.sh --commit NEW_EXACT_40_HEX_COMMIT --destination /absolute/new-studio --install-only

   Bootstrap shell SHA-256: 559f5092fddfa215c4525b7c12ebffa4fe6321be4ff7b22ef23ffb3557ea027c.
   Сверьте bootstrap.sh с доверенным значением до запуска. install-only не запускает
   модель или Codex login, но скачивает проверенный private Node/Codex/browser runtime;
   такой install в этой сборочной проверке не выполнялся. Не выдавайте verifyKit
   за завершённую сетевую установку. После установки отдельно проверьте 14
   named файлов overlay по resources/server-modules-release.json.

Для СУЩЕСТВУЮЩЕЙ поддерживаемой Studio используйте отдельный overlay updater
из kibi-studio-server-modules-20261117-r1.tar.gz, а не полный ZIP/bootstrap поверх неё.
Остановите Studio, сохраните существовавшие 14 named targets и список отсутствовавших путей для возврата
и примените scripts/update.mjs --studio /absolute/existing-studio --check, затем
--apply и --check. Разрешены базовая публичная Studio, закреплённый предыдущий
candidate и точные новые preimages; неизвестные локальные изменения отклоняются.
Updater читает только 26 guard/dependency и 14 named target paths. Он не сканирует
projects, .studio, auth/settings/accounts, private runtime или прошивки и не меняет
project/config/build/flash guards. Нельзя использовать полный installer как updater.
При обычной ошибке записи старые программные файлы возвращаются; interrupted update
можно повторить для известных preimages. Для возврата версии восстановите только
сохранённые существовавшие named файлы и удалите лишь добавленные named targets при остановленном процессе, сохранив все проекты
и приватные данные. Не добавляйте неизвестные хеши ради обхода отказа.

Публикация/привязка пакета и наличия runtime capabilities не доказывают успешный
invoke, Docker/media доступ, видео, звук или физическую плату. Для доступа к модулям
нужен новый явно разрешённый link code из кабинета; старые grants сохраняются.
`;

const readme=`# Киби Studio: непубликованный кандидат

Это полный кандидат studio-full-server-modules-20261117-rc1 с серверными модулями.
Версия программы остаётся 0.3.1. Кандидат ещё не опубликован: GitHub main не
утверждается источником этого ZIP. sourceCommit/baseCommit обозначают только
происхождение от публичной поставки 5c82a27e8ca72658ace8d0cd3e7aff2494072ad3,
а не Git-коммит нового кандидата. Новый GitHub SHA не создавался.

ZIP и manifest собраны из проверенного публичного release-candidate-4. Изменены
семь программных файлов Studio integration, семь canonical guide targets и строго
закреплённое исправление scripts/bootstrap.mjs; добавлен публичный
resources/server-modules-release.json. Нейтральный projects/kibi-base и все
templates сохранены побайтно. Установленная Studio и QA-каталоги не были input. Документация приведена к v2; аппаратные контракты и все 135 neutral template/project файлов сохранены побайтно.

Проверьте kibi-studio-local.zip по .sha256 и release.json; verification.json
содержит доказательства decode roundtrip, bootstrap.verifyKit и updater --check
на извлечённом публичном результате без runtime/auth. Для ручного просмотра
извлекайте ZIP в новую development-папку. Не заменяйте личную установленную Studio.

Наружные bootstrap.sh/.py и runtime-lock.json скопированы без изменений
из проверенной базы. Node bootstrap.mjs с исправленной проверкой точки входа
через macOS directory aliases закреплён SHA-256 adfc7eb70bdea022b70b95c8e733e29e51e6dc423e4c0fe3069bf8eb834615f7
и совпадает с scripts/bootstrap.mjs внутри ZIP. Их проверки пересчитаны в release.json. Существующий
bootstrap installer загружает опубликованный commit с GitHub: запуск с lineage
SHA установит прежнюю опубликованную поставку, а не этот локальный кандидат.
В этой проверке использована только чистая verifyKit; install/runtime/login
не запускались, сеть и физическая плата не проверялись.

publication.json содержит точный Git publication cohort; PUBLISH.md описывает
новый commit для установки и named-files-only обновление существующей Studio.
Инструмент kibi_publish_server_module принимает только packageText; доверенный
host вычисляет UTF-8 SHA-256. UI и действующие account scopes сохранены. Для
модулей требуется явно разрешённое подключение; доступность runtime/media
приходит с сервера. Пакет не доказывает выполнение, видео, звук или работу платы.
`;

/** Read only the pinned public release archive and named public overlay files. */
export async function packageFullStudio({baseDir,outputDir,helperFile=fileURLToPath(new URL('../../server/studio/full-release.mjs',import.meta.url)),bootstrapNodeFile=fileURLToPath(new URL('../../bootstrap.mjs',import.meta.url))}={}){
  if(typeof baseDir!=='string'||typeof outputDir!=='string'||!path.isAbsolute(baseDir)||!path.isAbsolute(outputDir)||!path.isAbsolute(helperFile)||typeof bootstrapNodeFile!=='string'||!path.isAbsolute(bootstrapNodeFile))throw fail('full_package_usage');
  if(Number(process.versions.node.split('.')[0])<24)throw fail('full_package_node_24_required');
  baseDir=await realpath(baseDir);
  helperFile=await realpath(helperFile);
  if(digest(await ordinary(helperFile))!==HELPER_SHA)throw fail('full_package_helper_mismatch');
  bootstrapNodeFile=await realpath(bootstrapNodeFile);
  const fixedBootstrapBytes=await ordinary(bootstrapNodeFile,128*1024);
  if(digest(fixedBootstrapBytes)!==FIXED_NODE_BOOTSTRAP_SHA)throw fail('full_package_bootstrap_mismatch','bootstrap.mjs');
  const {decodeReleaseZip,encodeFullPackage,assertDistributionPath}=await import(pathToFileURL(helperFile).href);
  const releaseBytes=await ordinary(path.join(baseDir,'release.json'));
  const manifestBytes=await ordinary(path.join(baseDir,'kibi-studio-local.manifest.json'),4*1024*1024);
  const archive=await ordinary(path.join(baseDir,'kibi-studio-local.zip'),64*1024*1024);
  if(digest(releaseBytes)!==BASE_RELEASE_SHA||digest(manifestBytes)!==BASE_MANIFEST_SHA||digest(archive)!==BASE_ZIP_SHA)throw fail('full_package_unknown_base');
  const baseRelease=JSON.parse(releaseBytes),baseManifest=JSON.parse(manifestBytes),baseFiles=decodeReleaseZip({archive,manifest:baseManifest,release:baseRelease});
  const baselineBytes=await ordinary(path.join(overlay,'manifests/baselines.json'));
  if(digest(baselineBytes)!==BASELINE_SHA)throw fail('full_package_baseline_mismatch');
  const baseline=JSON.parse(baselineBytes);
  if(Object.keys(baseline.files).length!==26||JSON.parse(baseFiles.get('package.json')).version!=='0.3.1')throw fail('full_package_baseline_mismatch');
  for(const[name,hash]of Object.entries(baseline.files))if(!baseFiles.has(name)||digest(baseFiles.get(name))!==hash)throw fail('full_package_baseline_mismatch',name);

  const overlayReleaseBytes=await ordinary(path.join(overlay,'release.json'));
  const overlayRelease=JSON.parse(overlayReleaseBytes);
  if(overlayRelease.schemaVersion!==1||overlayRelease.release!=='studio-server-modules-2026-11-17-r1'||Object.keys(overlayRelease.files||{}).length!==14)throw fail('full_package_payload_mismatch');
  const files=new Map(baseFiles),changed=[],added=[],payload=new Map();
  for(const name of PAYLOAD_FILES){
    const bytes=await ordinary(path.join(overlay,name));
    if(digest(bytes)!==overlayRelease.files[name])throw fail('full_package_payload_mismatch',name);
    if(!baseline.files[name]&&baseFiles.has(name))throw fail('full_package_baseline_mismatch',name);
    payload.set(name,bytes);files.set(name,bytes);
    if(baseFiles.has(name)){if(!baseFiles.get(name).equals(bytes))changed.push(name);}else added.push(name);
  }
  const metadataPath='resources/server-modules-release.json';
  if(baseFiles.has(metadataPath))throw fail('full_package_baseline_mismatch',metadataPath);
  files.set(metadataPath,json({schemaVersion:1,release:RELEASE,version:'0.3.1',sourceCommit:BASE_COMMIT,baseCommit:BASE_COMMIT,baseRelease:baseRelease.release,baseArchiveSha256:BASE_ZIP_SHA,overlayRelease:overlayRelease.release,files:overlayRelease.files,published:false,neutralStarterPreserved:true,privateDataIncluded:false,hardwareVerified:false,providerVerified:false}));
  added.push(metadataPath);
  const bootstrapNames=[['bootstrap.sh','bootstrapShellSha256'],['bootstrap.mjs','bootstrapNodeSha256'],['bootstrap.py','bootstrapSha256'],['runtime-lock.json','runtimeLockSha256']];
  const bootstraps=new Map();
  for(const[name,key]of bootstrapNames){
    const bytes=await ordinary(path.join(baseDir,name));
    if(digest(bytes)!==baseRelease[key]||!baseFiles.get('scripts/'+name)?.equals(bytes))throw fail('full_package_bootstrap_mismatch',name);
    bootstraps.set(name,bytes);
  }
  // Preserve the pinned historical base, then replace only the approved CLI fix.
  bootstraps.set('bootstrap.mjs',fixedBootstrapBytes);
  files.set('scripts/bootstrap.mjs',fixedBootstrapBytes);changed.push('scripts/bootstrap.mjs');
  const output=encodeFullPackage(files,{version:'0.3.1',releaseName:RELEASE,publicSdkExceptions:baseManifest.publicSdkExceptions||[]});
  Object.assign(output.release,{sourceCommit:BASE_COMMIT,baseCommit:BASE_COMMIT,baseRelease:baseRelease.release,baseArchiveSha256:BASE_ZIP_SHA,published:false,candidate:true});
  for(const[name,key]of bootstrapNames)output.release[key]=digest(bootstraps.get(name));
  const decoded=decodeReleaseZip(output);
  if(decoded.size!==files.size)throw fail('full_package_roundtrip_failed');
  for(const[name,bytes]of files)if(!decoded.get(name)?.equals(bytes))throw fail('full_package_roundtrip_failed',name);
  const roundtrip=encodeFullPackage(decoded,{version:'0.3.1',releaseName:RELEASE,publicSdkExceptions:baseManifest.publicSdkExceptions||[]});
  if(!roundtrip.archive.equals(output.archive))throw fail('full_package_roundtrip_failed');
  let neutralFilesVerified=0;
  for(const[name,bytes]of baseFiles)if(name.startsWith('projects/kibi-base/')||name.startsWith('templates/')){
    if(!decoded.get(name)?.equals(bytes))throw fail('full_package_neutral_starter_changed',name);neutralFilesVerified++;
  }
  const {verifyKit}=await import(pathToFileURL(path.join(baseDir,'bootstrap.mjs')).href);
  const kit=verifyKit(output.release,output.manifest,output.archive);
  if(kit.length!==files.size||kit.some(file=>!files.get(file.path)?.equals(file.bytes)))throw fail('full_package_bootstrap_verification_failed');

  const parent=path.dirname(path.resolve(outputDir));
  await mkdir(parent,{recursive:true});
  outputDir=path.join(await realpath(parent),path.basename(outputDir));
  if(await exists(outputDir))throw fail('full_package_output_exists');
  const checkRoot=await mkdtemp(path.join(path.dirname(outputDir),'.studio-public-check-'));
  const publication=await mkdtemp(path.join(path.dirname(outputDir),'.studio-candidate-'));
  try{
    // Extract only the public validated map. No installed runtime/auth is created.
    for(const[name,bytes]of decoded){
      assertDistributionPath(name);const filename=path.join(checkRoot,name);
      await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,bytes,{flag:'wx',mode:0o644});
    }
    const checked=await run(process.execPath,[path.join(overlay,'scripts/update.mjs'),'--studio',checkRoot,'--check'],{encoding:'utf8',timeout:30000,maxBuffer:65536});
    const updaterCheck=JSON.parse(checked.stdout);
    if(!updaterCheck.ok||updaterCheck.mode!=='check'||updaterCheck.changes?.length!==0)throw fail('full_package_updater_verification_failed');
    const publications=new Map([['kibi-studio-local.zip',output.archive],['kibi-studio-local.zip.sha256',Buffer.from(output.release.sha256+'  kibi-studio-local.zip\n')],['kibi-studio-local.manifest.json',json(output.manifest)],['release.json',json(output.release)],...bootstraps,['README.md',Buffer.from(readme)]]);
    const report={ok:true,release:RELEASE,version:'0.3.1',sourceCommit:BASE_COMMIT,baseCommit:BASE_COMMIT,published:false,archiveSha256:output.release.sha256,archiveBytes:output.archive.length,manifestSha256:output.release.manifestSha256,releaseSha256:digest(json(output.release)),files:decoded.size,baseFiles:baseFiles.size,baselinesCompared:26,changed,added,neutralFilesVerified,bootstrapVerified:true,nodeBootstrapSha256:FIXED_NODE_BOOTSTRAP_SHA,roundtripVerified:true,updaterCheck,privateDataIncluded:false,runtimeInstalled:false,authenticationStarted:false};
    const publicationManifest={schemaVersion:1,release:RELEASE,version:'0.3.1',repository:'ezggwp1216-pixel/kibi-studio',published:false,requiresNewGitCommit:true,lineageCommit:BASE_COMMIT,files:Object.fromEntries([...publications].filter(([name])=>name!=='README.md').map(([name,bytes])=>[name,{sha256:digest(bytes),bytes:bytes.length}]))};
    publications.set('publication.json',json(publicationManifest));
    publications.set('PUBLISH.md',Buffer.from(publicationReadme));
    publications.set('verification.json',json(report));
    for(const[name,bytes]of publications)await writeFile(path.join(publication,name),bytes,{flag:'wx',mode:0o644});
    // Detect a mixed source cohort before making the new candidate visible.
    if(!(await ordinary(path.join(overlay,'release.json'))).equals(overlayReleaseBytes))throw fail('full_package_changing_input');
    if(!(await ordinary(bootstrapNodeFile,128*1024)).equals(fixedBootstrapBytes))throw fail('full_package_changing_input');
    for(const[name,bytes]of payload)if(!(await ordinary(path.join(overlay,name))).equals(bytes))throw fail('full_package_changing_input');
    await rename(publication,outputDir);
    return{...report,outputDir};
  }finally{await rm(checkRoot,{recursive:true,force:true});await rm(publication,{recursive:true,force:true});}
}

async function main(){
  const args=process.argv.slice(2),options={};
  for(let index=0;index<args.length;index++){
    const key={'--base-dir':'baseDir','--out':'outputDir','--helper-file':'helperFile','--bootstrap-node-file':'bootstrapNodeFile'}[args[index]];
    if(!key||!args[index+1]||options[key])throw fail('full_package_usage');options[key]=args[++index];
  }
  console.log(JSON.stringify(await packageFullStudio(options)));
}
if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url))main().catch(error=>{
  console.error(JSON.stringify({ok:false,code:/^full_package_[a-z_]+$/.test(error.code||'')?error.code:'full_package_failed',...(error.file?{file:error.file}:{})}));process.exitCode=1;
});
