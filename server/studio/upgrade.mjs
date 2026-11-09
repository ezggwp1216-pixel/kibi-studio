#!/usr/bin/env node
// Offline additive upgrade for the known PUBLIC Studio 0.3 program baseline.
// Only the explicit program paths below are read. Never enumerate a Studio root.
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RELEASE = 'studio-platform-2026-11-10';
const DEFAULT_SOURCE = fileURLToPath(new URL('../', import.meta.url));
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const owned = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
const failure = (code, path, extra = {}) => Object.assign(new Error(code), { code, ...(path ? { path } : {}), ...extra });

// These hashes describe public KibiVirtual-dev program files only. No private
// Studio baseline, user project, setting, credential or machine path is embedded.
export const PUBLIC_STUDIO_BASELINES = Object.freeze(Object.fromEntries(Object.entries({
  'src/server.mjs': ['226a1c0a95171bf6d53f546f2cb5ee58e0ee83fee585766b5a9dbee99f4f7975', '6add6c045ceafa8e4fc001c6f0da24731a7f4a05803c0bf7d4e13a0a96acdab2'],
  'src/project-store.mjs': ['bc029db931d3aa867c09e15ca3d78ec53082297a212d9a49576fba37030747a7', 'd88617dfed845479f7703351bdee3ce49997426670c8e84d300fbaf3b1f1dd43'],
  'src/codex-bridge.mjs': ['40ea4421c0ce3a5b6a894a82a95e66bfc5af404dfc0378c354072cc6c503b307', '02be70941a1bf4db6082ed74323e32aa2fc169b43a3adb02ff4cca07041a7ef1'],
  'web/app.js': ['8d661295104ab31d3e6bec7be9faba407b929fb220f93b8dfee4579a69e7239c', '3218b02722c259cbfcc4e866ff0fee26568c1714375974e46c85cd518a9abd79'],
  'web/index.html': ['69e7de1cc996c9ffa883659d2cf025bc0cef7b12c2d48d7d4eea5151391d3344', '175c210ff0909e3ed022b7af185688819d7054d7c7239e485e967b31743b57ce'],
  'native/support.mjs': ['3c81fd1771b52200ad8e640677624360e94f7e348691b9df6a97e2da306fe4af', '3c81fd1771b52200ad8e640677624360e94f7e348691b9df6a97e2da306fe4af'],
}).map(([path, [beforeSha256, afterSha256]]) => [path, Object.freeze({ beforeSha256, afterSha256 })])));

const STORE_METHOD = `  installPublicAssets:(input,guard=()=>{})=>transaction(async()=>{
   guard();if(input?.expectedProjectId!==projectId)throw problem('Активный проект изменился.',409);
   const installed=await installManagedAssets({sourceDir,existingFiles:snap.files,input,guard});
   guard();Object.assign(state.protectedHashes,installed.hashes);state.approvedDesignHash=null;state.codeReady=null;state.build=null;await refresh();
   return{paths:installed.paths};
  }),
`;
const PATCHES = {
  'src/server.mjs': [
    ["import http from 'node:http';", "import http from 'node:http';\nimport {createStudioPlatform,platformTools,platformInstructions} from './studio-platform.mjs';"],
    ['export const dynamicTools=[', 'export const dynamicTools=[\n ...platformTools,'],
    [" const developerText=await readFile(path.join(root,'prompts/agent-system.md'),'utf8').catch(()=> 'Use Kibi dynamic tools only. Never request or read credentials.');", " const platform=await createStudioPlatform({root,getStore:()=>store,getEpoch:()=>projectEpoch,announce:()=>announce(),mutate:action=>voiceSourceMutation(action)});\n const developerText=(await readFile(path.join(root,'prompts/agent-system.md'),'utf8').catch(()=> 'Use Kibi dynamic tools only. Never request or read credentials.'))+'\\n'+platformInstructions;"],
    ["if(tool==='kibi_project_context')return{...await store.getAgentContext(),voiceGateway:voiceService.publicInfo(),preview:previewState};", "if(tool==='kibi_project_context')return{...await store.getAgentContext(),...await platform.context(),voiceGateway:voiceService.publicInfo(),preview:previewState};\n  const platformResult=await platform.tool(tool,args,turnGuard);if(platformResult.handled)return platformResult.result;"],
    ["   if(request.method==='GET'&&route==='/api/state')return send(response,await state());", "   if(await platform.route(request,response,{route,body,send}))return;\n   if(request.method==='GET'&&route==='/api/state')return send(response,await state());"],
    ['shutdown:async()=>{closed=true;virtualService.close();await voiceService.close();', 'shutdown:async()=>{closed=true;await platform.close();virtualService.close();await voiceService.close();'],
    ["server.on('close',()=>{closed=true;virtualService.close();", "server.on('close',()=>{closed=true;void platform.close();virtualService.close();"],
  ],
  'src/project-store.mjs': [
    ["import path from 'node:path';", "import path from 'node:path';\nimport {installManagedAssets} from './managed-assets.mjs';"],
    ['  readSource:value=>transaction(()=>{', STORE_METHOD + '  readSource:value=>transaction(()=>{'],
  ],
  'src/codex-bridge.mjs': [
    ["import { spawn } from 'node:child_process';", "import { spawn } from 'node:child_process';\nimport {platformTools} from './studio-platform.mjs';"],
    ['const TOOL_NAMES = new Set([', 'const TOOL_NAMES = new Set([...platformTools.map(tool=>tool.name),'],
  ],
  'web/app.js': [],
  'web/index.html': [['</head>', '<link rel="stylesheet" href="./studio-account.css">\n</head>']],
  'native/support.mjs': [],
};
// The UI entry is prepended rather than replacing a framework-specific import.
function transform(path, bytes) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw failure('upgrade_invalid_program', path); }
  if (path === 'web/app.js') {
    source = "import {initStudioAccountUI} from './studio-account.js';\n" + source;
    const anchor = ' }; paintFrame();';
    if (source.split(anchor).length !== 2) throw failure('upgrade_anchor_mismatch', path);
    return Buffer.from(source.replace(anchor, " }; initStudioAccountUI({api,mount:document.querySelector('.header-utilities')}); paintFrame();"));
  }
  for (const [before, after] of PATCHES[path]) {
    if (source.split(before).length !== 2) throw failure('upgrade_anchor_mismatch', path);
    source = source.replace(before, after);
  }
  return Buffer.from(source);
}

const PAYLOADS = Object.freeze([
  ...['studio-platform.mjs', 'studio-account.mjs', 'public-resources.mjs', 'managed-assets.mjs', 'leroyd-c309-recipe.json'].map(name => ({ source: `studio/${name}`, target: `src/${name}` })),
  ...['studio-account.js', 'studio-account.css'].map(name => ({ source: `studio/${name}`, target: `web/${name}` })),
  ...['API.md', 'VOICE.md', 'HARDWARE.md', 'SERVICES.md'].map(name => ({ source: `docs/${name}`, target: `src/platform-guides/${name}` })),
]);

async function unlinkedPath(input) {
  let path = resolve(input);
  if (process.platform === 'darwin') for (const prefix of ['/tmp', '/var']) {
    if ((path === prefix || path.startsWith(prefix + '/')) && await realpath(prefix) === '/private' + prefix) path = '/private' + path;
  }
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw failure('upgrade_unsafe_path'); }
    catch (cause) { if (cause.code === 'ENOENT') break; throw cause; }
  }
  return path;
}
async function directory(root, relative = '') {
  const path = await unlinkedPath(join(root, relative));
  const info = await lstat(path);
  if (!info.isDirectory() || !owned(info) || (info.mode & 0o022)) throw failure('upgrade_unsafe_path', relative || undefined);
  return info;
}
async function readProgram(root, relative, optional = false) {
  let handle;
  try {
    const path = await unlinkedPath(join(root, relative));
    await directory(root, dirname(relative) === '.' ? '' : dirname(relative));
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || !owned(info) || info.nlink !== 1 || (info.mode & 0o022) || info.size > MAX_FILE_BYTES) throw failure('upgrade_unsafe_file', relative);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw failure('upgrade_unsafe_file', relative);
    return { bytes, sha256: digest(bytes), mode: info.mode & 0o777, ino: info.ino, dev: info.dev };
  } catch (cause) {
    if (optional && cause.code === 'ENOENT') return null;
    if (cause.code?.startsWith('upgrade_')) throw cause;
    throw failure(cause.code === 'ENOENT' ? 'upgrade_missing_program' : 'upgrade_unsafe_file', relative);
  } finally { await handle?.close(); }
}
function checkSyntax(relative, bytes) {
  if (/\.(?:mjs|js)$/.test(relative)) {
    const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: bytes, env: {}, timeout: 5000, maxBuffer: 65536 });
    if (result.error || result.status !== 0) throw failure('upgrade_invalid_program', relative);
  } else if (relative.endsWith('.json')) {
    try { JSON.parse(bytes.toString('utf8')); } catch { throw failure('upgrade_invalid_program', relative); }
  }
}
async function sameProgram(root, entry) {
  const current = await readProgram(root, entry.path, true);
  if (entry.before === null) {
    if (current !== null) throw failure('upgrade_target_changed', entry.path);
  } else if (!current || current.sha256 !== entry.before.sha256 || current.ino !== entry.before.ino || current.dev !== entry.before.dev || current.mode !== entry.before.mode) {
    throw failure('upgrade_target_changed', entry.path);
  }
}
async function newFile(path, bytes, mode) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
  finally { await handle.close(); }
}

/** No network and no application code execution. onProgress is a trusted host
 * callback; a thrown callback error uses the same rollback as an I/O failure. */
export async function upgradeStudio({ root, sourceRoot = DEFAULT_SOURCE, apply = false, onProgress = () => {} } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw failure('upgrade_node_24_required');
  if (typeof root !== 'string' || !root || typeof sourceRoot !== 'string' || !sourceRoot || typeof apply !== 'boolean' || typeof onProgress !== 'function') throw failure('upgrade_invalid_arguments');
  let target, source;
  try { target = await unlinkedPath(root); source = await unlinkedPath(sourceRoot); await directory(target); await directory(source); }
  catch { throw failure('upgrade_unsafe_root'); }
  const entries = [], prerequisites = [];
  // Validate every public baseline and all transforms before creating anything.
  for (const [path, expected] of Object.entries(PUBLIC_STUDIO_BASELINES)) {
    const before = await readProgram(target, path);
    if (![expected.beforeSha256, expected.afterSha256].includes(before.sha256)) throw failure('upgrade_unknown_baseline', path);
    const next = before.sha256 === expected.afterSha256 ? before.bytes : transform(path, before.bytes);
    if (digest(next) !== expected.afterSha256) throw failure('upgrade_transform_mismatch', path);
    checkSyntax(path, next);
    const entry = { path, before, bytes: next, afterSha256: expected.afterSha256, mode: before.mode };
    (before.sha256 === expected.afterSha256 ? prerequisites : entries).push(entry);
  }
  let payloadBytes = 0;
  for (const payload of PAYLOADS) {
    const input = await readProgram(source, payload.source);
    if ((payloadBytes += input.bytes.length) > 8 * 1024 * 1024) throw failure('upgrade_payload_limit');
    checkSyntax(payload.target, input.bytes);
    const before = await readProgram(target, payload.target, true);
    if (before && before.sha256 !== input.sha256) throw failure('upgrade_existing_file_conflict', payload.target);
    const entry = { path: payload.target, before, bytes: input.bytes, afterSha256: input.sha256, mode: before?.mode ?? 0o644 };
    (before ? prerequisites : entries).push(entry);
  }
  const changes = entries.map(entry => ({ path: entry.path, action: entry.before ? 'patch' : 'create', beforeSha256: entry.before?.sha256 ?? null, afterSha256: entry.afterSha256 }));
  const report = { ok: true, release: RELEASE, mode: entries.length ? (apply ? 'applied' : 'dry-run') : 'already-current', changes, backupDir: null };
  if (!apply || entries.length === 0) return report;
  for (const entry of [...prerequisites, ...entries]) await sameProgram(target, entry);

  const backupDir = join(target, `.kibi-studio-upgrade-${RELEASE}-${randomUUID()}`);
  const staged = [], committed = [], madeDirectories = [];
  let phase = 'backup';
  async function ensureNewDirectory(path, mode, tracked) {
    try { await mkdir(path, { mode }); if (tracked) madeDirectories.push(path); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const info = await lstat(await unlinkedPath(path));
    if (!info.isDirectory() || !owned(info) || (mode === 0o700 ? (info.mode & 0o777) !== 0o700 : (info.mode & 0o022) !== 0)) throw failure('upgrade_unsafe_path');
  }
  async function backupParent(relative) {
    let parent = backupDir;
    for (const part of dirname(relative).split(/[\\/]/).filter(part => part && part !== '.')) {
      parent = join(parent, part); await ensureNewDirectory(parent, 0o700, false);
    }
  }
  async function stage(entry, bytes = entry.bytes, mode = entry.mode) {
    await directory(target, dirname(entry.path));
    const temporary = join(target, dirname(entry.path), `.kibi-upgrade-${randomUUID()}.tmp`);
    staged.push(temporary);
    await newFile(temporary, bytes, mode);
    return temporary;
  }
  try {
    await mkdir(backupDir, { mode: 0o700 });
    await ensureNewDirectory(backupDir, 0o700, false);
    report.backupDir = backupDir;
    for (const entry of entries.filter(entry => entry.before)) {
      await backupParent(entry.path);
      await newFile(join(backupDir, entry.path), entry.before.bytes, 0o600);
    }
    await newFile(join(backupDir, 'upgrade.json'), Buffer.from(JSON.stringify({ release: RELEASE, status: 'prepared', files: changes }, null, 2) + '\n'), 0o600);
    phase = 'stage';
    if (entries.some(entry => entry.path.startsWith('src/platform-guides/'))) await ensureNewDirectory(join(target, 'src/platform-guides'), 0o755, true);
    for (const entry of entries) entry.temporary = await stage(entry);
    for (const entry of [...prerequisites, ...entries]) await sameProgram(target, entry);
    phase = 'commit';
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      await onProgress({ phase, path: entry.path, index, total: entries.length });
      await sameProgram(target, entry);
      await directory(target, dirname(entry.path));
      await rename(entry.temporary, join(target, entry.path));
      committed.push(entry);
    }
    phase = 'verify';
    for (const entry of [...prerequisites, ...entries]) {
      const actual = await readProgram(target, entry.path);
      if (actual.sha256 !== entry.afterSha256) throw failure('upgrade_verify_failed', entry.path);
    }
    return report;
  } catch (cause) {
    const rollbackFailed = [];
    for (const entry of committed.reverse()) {
      try {
        const actual = await readProgram(target, entry.path);
        if (actual.sha256 !== entry.afterSha256) throw failure('upgrade_target_changed', entry.path);
        if (entry.before) {
          const temporary = await stage(entry, entry.before.bytes, entry.before.mode);
          await rename(temporary, join(target, entry.path));
          const restored = await readProgram(target, entry.path);
          if (restored.sha256 !== entry.before.sha256) throw failure('upgrade_verify_failed', entry.path);
        } else await rm(join(target, entry.path));
      } catch { rollbackFailed.push(entry.path); }
    }
    if (rollbackFailed.length) throw failure('upgrade_rollback_failed', undefined, { backupDir: report.backupDir, phase, rollbackFailed });
    throw failure(cause.code?.startsWith('upgrade_') ? cause.code : 'upgrade_write_failed', cause.path, { backupDir: report.backupDir, phase, rolledBack: true });
  } finally {
    for (const temporary of staged) await rm(temporary, { force: true }).catch(() => {});
    for (const dir of madeDirectories.reverse()) await rmdir(dir).catch(() => {});
  }
}

function argumentsFor(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply' && options.apply === undefined) options.apply = true;
    else if (arg === '--dry-run' && options.apply === undefined) options.apply = false;
    else if (arg === '--root' && options.root === undefined && argv[index + 1] && !argv[index + 1].startsWith('--')) options.root = argv[++index];
    else if (arg === '--source-root' && options.sourceRoot === undefined && argv[index + 1] && !argv[index + 1].startsWith('--')) options.sourceRoot = argv[++index];
    else throw failure('upgrade_invalid_arguments');
  }
  if (!options.root) throw failure('upgrade_invalid_arguments');
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    if (options === null) console.log('Обновление публичной Studio 0.3, Node 24+.\nПроверка: node studio/upgrade.mjs --root /путь/к/Studio\nПрименение: node studio/upgrade.mjs --root /путь/к/Studio --apply\nStudio должна быть остановлена. Сеть и пользовательские данные не используются.');
    else console.log(JSON.stringify(await upgradeStudio(options), null, 2));
  } catch (cause) {
    console.error(JSON.stringify({ ok: false, code: cause.code?.startsWith('upgrade_') ? cause.code : 'upgrade_failed', ...(cause.path ? { path: cause.path } : {}), ...(cause.backupDir ? { backupDir: cause.backupDir } : {}), ...(cause.rolledBack ? { rolledBack: true } : {}), ...(cause.rollbackFailed ? { rollbackFailed: cause.rollbackFailed } : {}) }));
    process.exitCode = 1;
  }
}
