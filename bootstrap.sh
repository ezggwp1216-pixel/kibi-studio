#!/bin/sh
# First stage needs only tools supplied with macOS. No Python, npm, brew or CLT.
set -eu
umask 077
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
fail() { printf '%s\n' "Kibi Studio: $*" >&2; exit 1; }
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'This installer supports macOS only.'
COMMIT=
DESTINATION=
RUNTIME_ROOT=
INSTALL_ONLY=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --commit) [ "$#" -ge 2 ] || fail 'Missing commit'; COMMIT=$2; shift 2 ;;
    --destination) [ "$#" -ge 2 ] || fail 'Missing destination'; DESTINATION=$2; shift 2 ;;
    --runtime-root) [ "$#" -ge 2 ] || fail 'Missing runtime root'; RUNTIME_ROOT=$2; shift 2 ;;
    --install-only) INSTALL_ONLY=--install-only; shift ;;
    *) fail 'Unknown installer argument' ;;
  esac
done
case "$COMMIT" in ''|*[!0-9a-f]*) fail 'An exact lowercase GitHub commit is required' ;; esac
[ "${#COMMIT}" -eq 40 ] || fail 'An exact 40-character GitHub commit is required'
[ -n "$DESTINATION" ] || fail 'A new absolute destination is required'
case "$DESTINATION" in /*) ;; *) fail 'Destination must be absolute' ;; esac
[ ! -e "$DESTINATION" ] && [ ! -L "$DESTINATION" ] || fail 'Destination exists; no project was overwritten'
RUNTIME_ROOT=${RUNTIME_ROOT:-"$HOME/Library/Application Support/Kibi Studio/runtime"}
case "$RUNTIME_ROOT" in /*) ;; *) fail 'Runtime root must be absolute' ;; esac
case "$(/usr/bin/uname -m)" in
  arm64) ARCH=arm64; NODE_SHA=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a ;;
  x86_64) ARCH=x64; NODE_SHA=d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52 ;;
  *) fail 'Unsupported Mac architecture' ;;
esac
WORK=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/kibi-studio-install.XXXXXXXX")
trap '/bin/rm -rf "$WORK"' EXIT
trap 'exit 1' HUP INT TERM
fetch() { /usr/bin/curl --proto '=https' --tlsv1.2 --fail --silent --show-error --connect-timeout 20 --max-time 600 --retry 2 --max-filesize "$3" "$1" -o "$2"; }
check_sha() { ACTUAL=$(/usr/bin/shasum -a 256 "$1"); ACTUAL=${ACTUAL%% *}; [ "$ACTUAL" = "$2" ] || fail 'Download SHA-256 mismatch'; }
BASE="https://raw.githubusercontent.com/ezggwp1216-pixel/kibi-studio/$COMMIT"
fetch "$BASE/release.json" "$WORK/release.json" 65536
# The launch prompt pins this shell's hash before executing it. This second
# stage is likewise pinned in the same immutable release metadata.
HELPER_SHA=$(/usr/bin/sed -nE 's/^[[:space:]]*"bootstrapNodeSha256"[[:space:]]*:[[:space:]]*"([0-9a-f]{64})",?[[:space:]]*$/\1/p' "$WORK/release.json")
LOCK_SHA=$(/usr/bin/sed -nE 's/^[[:space:]]*"runtimeLockSha256"[[:space:]]*:[[:space:]]*"([0-9a-f]{64})",?[[:space:]]*$/\1/p' "$WORK/release.json")
[ "${#HELPER_SHA}" -eq 64 ] && [ "${#LOCK_SHA}" -eq 64 ] || fail 'Release lacks verified clean-Mac installer metadata'
fetch "$BASE/bootstrap.mjs" "$WORK/bootstrap.mjs" 131072
fetch "$BASE/runtime-lock.json" "$WORK/runtime-lock.json" 65536
check_sha "$WORK/bootstrap.mjs" "$HELPER_SHA"
check_sha "$WORK/runtime-lock.json" "$LOCK_SHA"
printf '%s\n' 'Downloading the private Node runtime (no system installation)…'
NODE_NAME="node-v24.22.2-darwin-$ARCH"
fetch "https://nodejs.org/dist/v24.22.2/$NODE_NAME.tar.gz" "$WORK/node.tar.gz" 100663296
check_sha "$WORK/node.tar.gz" "$NODE_SHA"
/usr/bin/tar -xzf "$WORK/node.tar.gz" -C "$WORK"
NODE="$WORK/$NODE_NAME/bin/node"
[ "$("$NODE" --version)" = v24.22.2 ] || fail 'Downloaded Node runtime did not start'
if [ -n "$INSTALL_ONLY" ]; then
  "$NODE" "$WORK/bootstrap.mjs" --commit "$COMMIT" --destination "$DESTINATION" --runtime-root "$RUNTIME_ROOT" --node-root "$WORK/$NODE_NAME" --lock "$WORK/runtime-lock.json" --install-only
else
  "$NODE" "$WORK/bootstrap.mjs" --commit "$COMMIT" --destination "$DESTINATION" --runtime-root "$RUNTIME_ROOT" --node-root "$WORK/$NODE_NAME" --lock "$WORK/runtime-lock.json"
fi
