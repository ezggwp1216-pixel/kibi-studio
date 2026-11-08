import { constants } from 'node:fs';
import { lstat, mkdir, readdir, open, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, parse, join } from 'node:path';

// Run only in an operator-owned directory, with the server stopped. This
// intentionally rejects linked paths rather than trying to repair them.
async function ensureDirectory(path) {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_path');
  }
}

async function inspectTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('unsafe_link');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('wrong_owner');
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await inspectTree(join(path, name));
  } else if (!info.isFile() || info.nlink !== 1) {
    throw new Error('unsafe_file');
  }
}

async function initialize() {
  const dataDir = resolve(process.env.KIBI_DATA_DIR || '.data');
  await ensureDirectory(dataDir);
  await inspectTree(dataDir);
  const entries = await readdir(dataDir);
  const passwordPath = join(dataDir, 'admin-password');
  if (!entries.includes('admin-password') && entries.length) throw new Error('missing_password_existing_data');
  await chmod(dataDir, 0o700);
  if (entries.includes('admin-password')) {
    const file = await open(passwordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size < 16 || info.size > 1024) throw new Error('invalid_password_file');
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('wrong_owner');
      await file.chmod(0o600);
    } finally { await file.close(); }
    console.log('Инициализация проверена. Существующие пароль, ключи и данные сохранены.');
    return;
  }
  const file = await open(passwordPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${randomBytes(32).toString('base64url')}\n`, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  console.log('Инициализация завершена. Пароль записан в admin-password внутри каталога данных; смотрите START_HERE.md локально.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Использование: node scripts/init.mjs; каталог: KIBI_DATA_DIR (по умолчанию .data). Пароль не выводится.');
    return;
  }
  if (args.length) throw new Error('unsupported_arguments');
  await initialize();
}

main().catch(() => {
  console.error('Инициализация остановлена: проверьте владельца, обычные файлы без ссылок и наличие исходного пароля. Данные не заменяются.');
  process.exitCode = 1;
});
