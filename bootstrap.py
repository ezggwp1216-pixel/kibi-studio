#!/usr/bin/env python3
"""Download a commit-pinned public Kibi Studio kit; never run the kit or read auth."""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

REPOSITORY = 'https://github.com/ezggwp1216-pixel/kibi-studio'
REPOSITORY_RAW = 'https://raw.githubusercontent.com' + urllib.parse.urlsplit(REPOSITORY).path
ARCHIVE = 'kibi-studio-local.zip'
MANIFEST = 'kibi-studio-local.manifest.json'
ROOT = 'kibi-studio'
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_FILES = 10000
HASH = re.compile(r'^[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
PRIVATE_PARTS = {'.studio', '.git', '.github', '.codex', '.aws', 'node_modules', 'backups'}
PRIVATE_FILES = {'auth.json', 'kibi_project_config.h', 'wifi_config.h', 'wifi_credentials.h', 'settings.json', 'secret.json', 'secret.h', 'secrets.json', 'secrets.h'}
SDK_ELF = ROOT + '/resources/native-sdk/bin/bootloader_dio_40m.elf'
LAUNCHER = 'Запустить Киби Studio.command'
REQUIRED = {'package.json', 'scripts/start.mjs', 'scripts/doctor.mjs', 'projects/kibi-base/firmware/project.ino'}


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise ValueError('GitHub download redirect refused; use the commit-pinned raw URL.')


def download(url, maximum):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.netloc != 'raw.githubusercontent.com'
            or parsed.query or parsed.fragment
            or not re.fullmatch(re.escape(urllib.parse.urlsplit(REPOSITORY).path) + r'/[0-9a-f]{40}/(?:release\.json|kibi-studio-local\.manifest\.json|kibi-studio-local\.zip)', parsed.path)):
        raise ValueError('Only fixed, commit-pinned public GitHub downloads are allowed.')
    request = urllib.request.Request(url, headers={'User-Agent': 'KibiStudioBootstrap/0.2'})
    with urllib.request.build_opener(NoRedirects()).open(request, timeout=45) as response:
        if response.status != 200 or response.geturl() != url:
            raise ValueError('GitHub did not return the requested commit-pinned resource.')
        length = response.headers.get('Content-Length')
        if length and (not length.isdecimal() or int(length) > maximum):
            raise ValueError('GitHub resource exceeds the download size limit.')
        payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise ValueError('GitHub resource exceeds the download size limit.')
    return payload


def _json(payload):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON metadata key.')
            result[key] = value
        return result
    try:
        return json.loads(payload.decode('utf-8'), object_pairs_hook=unique)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ValueError('Invalid public release JSON metadata.') from error


def _integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('Invalid ' + label + ' limit or size.')
    return value


def _member(name):
    if not isinstance(name, str) or len(name) > 1024 or '\\' in name or '\x00' in name:
        raise ValueError('Invalid archive member path.')
    parts = name.split('/')
    if len(parts) < 2 or len(parts) > 24 or parts[0] != ROOT or any(part in {'', '.', '..'} or ':' in part for part in parts):
        raise ValueError('Invalid archive member path.')
    lowered = [part.casefold() for part in parts]
    if any(part in PRIVATE_PARTS for part in lowered) or lowered[-1] in PRIVATE_FILES or lowered[-1].startswith('.env'):
        raise ValueError('Forbidden private archive member path.')
    if name.lower().endswith(('.bin', '.elf', '.o', '.a')) and not (name == SDK_ELF or name.startswith(ROOT + '/resources/native-sdk/') and name.lower().endswith('.a')):
        raise ValueError('Forbidden private or non-runtime binary archive member path.')
    return '/'.join(parts[1:])


def install(commit, destination, fetch=download):
    if not isinstance(commit, str) or not COMMIT.fullmatch(commit):
        raise ValueError('An exact 40-character lowercase GitHub commit SHA is required.')
    destination = Path(destination).expanduser()
    if os.path.lexists(destination):
        raise ValueError('Destination already exists; choose a new folder without overwriting it.')
    try:
        parent = destination.parent.resolve(strict=True)
    except OSError as error:
        raise ValueError('Destination parent directory must already exist.') from error
    destination = parent / destination.name
    if not parent.is_dir():
        raise ValueError('Destination parent must be a directory.')
    base = REPOSITORY_RAW + '/' + commit + '/'
    release = _json(fetch(base + 'release.json', 65536))
    if (not isinstance(release, dict) or release.get('schemaVersion') != 1 or release.get('archive') != ARCHIVE
            or release.get('root') != ROOT or release.get('platform') != 'darwin'
            or not isinstance(release.get('sha256'), str) or not HASH.fullmatch(release['sha256'])):
        raise ValueError('Unsupported release archive metadata.')
    size = _integer(release.get('bytes'), 1, MAX_ARCHIVE, 'archive bytes')
    expanded = _integer(release.get('expandedBytes'), 1, MAX_EXPANDED, 'expanded bytes')
    count = _integer(release.get('fileCount'), 1, MAX_FILES, 'file count')
    manifest = _json(fetch(base + MANIFEST, 4 * 1024 * 1024))
    if (not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1 or manifest.get('root') != ROOT
            or manifest.get('fileCount') != count or manifest.get('totalBytes') != expanded
            or manifest.get('archive') != {'name': ARCHIVE, 'size': size, 'sha256': release['sha256']}
            or not isinstance(manifest.get('files'), list) or len(manifest['files']) != count):
        raise ValueError('Release and archive manifest disagree on hash, file count or size.')
    expected = {}
    for entry in manifest['files']:
        if not isinstance(entry, dict):
            raise ValueError('Invalid manifest member.')
        name = entry.get('path')
        _member(name)
        if name in expected or not isinstance(entry.get('sha256'), str) or not HASH.fullmatch(entry['sha256']):
            raise ValueError('Duplicate manifest member or invalid SHA hash.')
        _integer(entry.get('size'), 0, MAX_ARCHIVE, 'member bytes')
        expected[name] = entry
    if sum(entry['size'] for entry in expected.values()) != expanded:
        raise ValueError('Expanded member bytes do not match the manifest.')
    if not REQUIRED.issubset({_member(name) for name in expected}):
        raise ValueError('Required Studio runtime members are missing.')
    if any('/'.join(name.split('/')[:index]) in expected for name in expected for index in range(1, len(name.split('/')))):
        raise ValueError('Conflicting archive member paths.')
    payload = fetch(base + ARCHIVE, MAX_ARCHIVE)
    if len(payload) != size or hashlib.sha256(payload).hexdigest() != release['sha256']:
        raise ValueError('Archive bytes or SHA-256 hash mismatch; nothing was extracted.')
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        entries = archive.infolist()
        if len(entries) != count or len({entry.filename for entry in entries}) != count or {entry.filename for entry in entries} != set(expected):
            raise ValueError('Archive member list differs from the manifest.')
        for entry in entries:
            _member(entry.filename)
            mode = entry.external_attr >> 16
            if entry.is_dir() or stat.S_IFMT(mode) not in {0, stat.S_IFREG}:
                raise ValueError('Archive links and special members are forbidden; regular files only.')
            if entry.flag_bits & 1 or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                raise ValueError('Unsupported archive member encoding.')
            if entry.file_size != expected[entry.filename]['size']:
                raise ValueError('Archive member size mismatch.')
            digest = hashlib.sha256()
            with archive.open(entry) as source:
                total = 0
                while True:
                    chunk = source.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > expected[entry.filename]['size']:
                        raise ValueError('Archive member exceeds its declared bytes limit.')
                    digest.update(chunk)
            if total != entry.file_size or digest.hexdigest() != expected[entry.filename]['sha256']:
                raise ValueError('Archive member SHA-256 hash mismatch.')
        try:
            destination.mkdir(mode=0o700)
        except FileExistsError as error:
            raise ValueError('Destination already exists; no files were overwritten.') from error
        try:
            for entry in entries:
                relative = _member(entry.filename)
                target = destination / relative
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with archive.open(entry) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, length=65536)
                target.chmod(0o755 if relative == LAUNCHER else 0o644)
        except BaseException:
            shutil.rmtree(destination)
            raise
    return {'repository': REPOSITORY, 'commit': commit, 'projectPath': str(destination), 'verifiedFiles': count, 'archiveSha256': release['sha256'], 'started': False}


def main():
    parser = argparse.ArgumentParser(description='Download and verify Kibi Studio from one exact public GitHub commit. No installation or USB access.')
    parser.add_argument('--commit', required=True, help='Exact 40-character GitHub commit SHA; moving branch names are refused.')
    parser.add_argument('--destination', help='A new directory under an existing parent; never an existing project.')
    args = parser.parse_args()
    destination = args.destination or str(Path.cwd() / ('KibiStudio-' + args.commit[:8]))
    try:
        print(json.dumps(install(args.commit, destination), ensure_ascii=False, indent=2))
    except Exception as error:
        print('Kibi Studio download failed: ' + (str(error) if isinstance(error, ValueError) else 'Download or archive validation did not complete; no existing project was changed.'), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
