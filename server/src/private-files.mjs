import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { resolve, parse, join, sep } from 'node:path';

// macOS exposes /tmp and /var as system links. Resolve only these known
// aliases; user-controlled links in the data/password path are rejected.
export async function unlinkedPath(input) {
  let path = resolve(input);
  if (process.platform === 'darwin') {
    for (const prefix of ['/tmp', '/var']) {
      if ((path === prefix || path.startsWith(`${prefix}/`)) && await realpath(prefix) === `/private${prefix}`) path = `/private${path}`;
    }
  }
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('linked_private_path'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return path;
}

export function isOwned(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

export async function readPrivateFile(input) {
  const path = await unlinkedPath(input);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !isOwned(stat) || (stat.mode & 0o777) !== 0o600) throw new Error('unsafe_private_file');
    return await file.readFile();
  } finally { await file.close(); }
}
