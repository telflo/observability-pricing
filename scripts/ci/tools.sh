#!/usr/bin/env bash
# tools.sh: the CI's pinned tools (today gitleaks), each a release binary
# checked against the sha256 in tools.lock, in the git-ignored .tools/ at the
# repository's root. Nothing system-wide, no Homebrew.
#
#   tools.sh fetch [<tool>]   download each tool (or one) pinned for this OS and processor
#                             type into .tools/<tool>/<version>/, check the archive's sha256
#                             and then the binary's before it is installed (a mismatch
#                             deletes the download and exits 1); a checked one is reused
#   tools.sh path <tool>      print the checked binary's path, or exit 1 (never downloads):
#                             the binary is hashed again and must be tools.lock's
#
# A trimmed copy of telflo/telflo's scripts/release/tools.sh. Exit 0 done,
# 1 failed, 2 usage. bash 3.2 compatible.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOOLS_DIR="$REPO_DIR/.tools"
LOCK="$SCRIPT_DIR/tools.lock"

usage() {
  sed -n 's/^#   tools\.sh /tools.sh /p' "$0" >&2
  exit 2
}
fail() { echo "tools.sh: FAIL: $*" >&2; exit 1; }
say() { echo "tools.sh: $*"; }

[ -f "$LOCK" ] || fail "no lock file"

platform() {
  local os arch
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) os=unknown ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=amd64 ;; *) arch=unknown ;; esac
  echo "$os-$arch"
}

sha256_of() { # <file>
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# lock_tool <name> <platform>: sets T_VERSION T_URL T_SHA T_SUMS T_MEMBER T_BIN, or returns 1.
lock_tool() {
  local name=$1 line
  line=$(awk -v n="$1" -v p="$2" '$1 == "tool" && $2 == n && $4 == p { print; exit }' "$LOCK")
  [ -n "$line" ] || return 1
  set -f; set -- $line; set +f
  [ "$#" = 9 ] || fail "tools.lock's line for $name hasn't 9 fields"
  T_VERSION=$3 T_URL=$5 T_SHA=$6 T_SUMS=$7 T_MEMBER=$8 T_BIN=$9
  printf '%s' "$T_VERSION" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$' || fail "tools.lock: $name's version isn't x.y.z"
  printf '%s' "$T_SHA" | grep -Eq '^[0-9a-f]{64}$' || fail "tools.lock: $name's sha256 isn't 64 hex"
  printf '%s' "$T_BIN" | grep -Eq '^[0-9a-f]{64}$' || fail "tools.lock: $name's binary sha256 isn't 64 hex"
  case "$T_URL" in https://*) ;; *) fail "tools.lock: $name's URL isn't https" ;; esac
  printf '%s' "$T_MEMBER" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$' || fail "tools.lock: $name's member isn't a plain name"
}
lock_tools() { awk '$1 == "tool" { print $2 }' "$LOCK" | awk '!seen[$0]++'; }

# The checked binary of <tool> at the lock's version, or return 1.
checked_binary() { # <tool>: sets B_PATH
  lock_tool "$1" "$(platform)" || return 1
  B_PATH="$TOOLS_DIR/$1/$T_VERSION/$1"
  [ -f "$B_PATH" ] && [ ! -L "$B_PATH" ] && [ -x "$B_PATH" ] || return 1
  [ "$(sha256_of "$B_PATH")" = "$T_BIN" ] || return 1
}

fetch_one() { # <tool>
  local tool=$1 plat dir
  # Global, not local: the EXIT trap below reads it after this function returns.
  plat=$(platform)
  lock_tool "$tool" "$plat" || fail "tools.lock pins no $tool for $plat"
  dir="$TOOLS_DIR/$tool/$T_VERSION"
  if checked_binary "$tool"; then
    say "$tool $T_VERSION ($plat): already fetched and checked: $B_PATH"
    return 0
  fi
  [ ! -e "$dir" ] || fail "$dir exists but doesn't check against tools.lock: delete .tools/ and fetch again"
  mkdir -p "$TOOLS_DIR/$tool" || fail "cannot make $TOOLS_DIR/$tool"
  stage=$(mktemp -d "$TOOLS_DIR/$tool/.fetch.XXXXXX") || fail "cannot make a download folder"
  trap 'rm -rf "$stage"' EXIT
  say "$tool $T_VERSION ($plat): downloading"
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 -o "$stage/download" "$T_URL" ||
    fail "$tool: the download failed"
  [ "$(sha256_of "$stage/download")" = "$T_SHA" ] ||
    fail "$tool $T_VERSION ($plat): the download's sha256 isn't tools.lock's ($T_SUMS): deleted"
  say "$tool: sha256 matches tools.lock ($T_SUMS)"
  mkdir "$stage/x" && tar -xzf "$stage/download" -C "$stage/x" "$T_MEMBER" 2>/dev/null ||
    fail "$tool: $T_MEMBER isn't in the checked archive"
  [ -f "$stage/x/$T_MEMBER" ] && [ ! -L "$stage/x/$T_MEMBER" ] ||
    fail "$tool: $T_MEMBER in the archive isn't a plain file"
  [ "$(sha256_of "$stage/x/$T_MEMBER")" = "$T_BIN" ] ||
    fail "$tool $T_VERSION ($plat): the binary's sha256 isn't tools.lock's: deleted"
  chmod 755 "$stage/x/$T_MEMBER" || fail "$tool: chmod failed"
  mkdir "$dir" && mv "$stage/x/$T_MEMBER" "$dir/$tool" || fail "$tool: cannot move into $dir"
  checked_binary "$tool" || fail "$tool: the fetched binary doesn't check"
  say "$tool $T_VERSION ($plat): $B_PATH"
}

action=${1:-}
[ -n "$action" ] && shift || usage
case "$action" in
  fetch)
    [ "$#" -le 1 ] || usage
    if [ "$#" = 1 ]; then
      fetch_one "$1"
    else
      for tool in $(lock_tools); do (fetch_one "$tool") || exit 1; done
    fi
    ;;
  path)
    [ "$#" = 1 ] || usage
    checked_binary "$1" || { echo "tools.sh: $1 isn't fetched and checked for $(platform) (tools.sh fetch $1)" >&2; exit 1; }
    echo "$B_PATH"
    ;;
  *) usage ;;
esac
exit 0
