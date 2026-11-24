#!/usr/bin/env bash
# check-secrets.sh: the secret scan, gitleaks (tools.lock's version,
# sha256-checked: `bash scripts/ci/tools.sh fetch gitleaks` once), offline,
# from the repository's root.
#
#   bash scripts/ci/check-secrets.sh [--history]
#
# Without --history it scans every file git would commit (tracked, and
# untracked but not ignored: never node_modules, .tools or a local .env),
# copied into a temporary folder. With --history it scans every commit
# reachable from any ref instead (the CI runs it on main, with the full
# history checked out): a secret deleted from the tree is still published
# in the history of a public repository.
#
# Either way gitleaks runs with its own default rules (a .gitleaks.toml in
# the tree, GITLEAKS_CONFIG and GITLEAKS_CONFIG_TOML are never read) and
# --redact: a value gitleaks finds is never printed.
#
# .gitleaksignore at the root lists the findings reviewed as not secret (test
# fixtures, made-up values), one gitleaks fingerprint per line, with #
# comments and blank lines: <path>:<rule>:<line> for the tree, and
# <commit>:<path>:<rule>:<line> for the history. The check fails on a finding
# the file doesn't list. The tree scan also fails on a listed tree
# fingerprint gitleaks no longer finds (a line that moved or went away), so
# the list holds exactly today's reviewed findings. Never list a real
# credential: remove it, and rotate it.
#
# Exit 0 every finding is listed; 1 a finding not listed, a stale entry, or
# gitleaks failed; 2 usage, or no checked gitleaks. Adapted from
# telflo/telflo's scripts/release/check-secrets.sh. bash 3.2 compatible.
set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$SCRIPT_DIR/../.." && pwd)"
usage() {
  sed -n 's/^#   bash scripts\/ci\/check-secrets\.sh /check-secrets.sh /p' "$0" >&2
  exit 2
}

mode=tree
while [ "$#" -gt 0 ]; do
  case "$1" in
    --history) mode=history; shift ;;
    *) echo "check-secrets: unknown argument: $1" >&2; usage ;;
  esac
done
[ "$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$root" && pwd -P)" ] ||
  { echo "check-secrets: $root isn't a git checkout's root" >&2; exit 2; }

gitleaks=$(bash "$SCRIPT_DIR/tools.sh" path gitleaks 2>/dev/null) ||
  { echo "check-secrets: no checked gitleaks: run bash scripts/ci/tools.sh fetch gitleaks" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/check-secrets.XXXXXX") || { echo "check-secrets: FAIL: no temporary folder" >&2; exit 1; }
trap 'rm -rf "$work"' EXIT
printf '{{range .}}{{.Fingerprint}}\n{{end}}' >"$work/fingerprint.tmpl"

if [ "$mode" = tree ]; then
  mkdir "$work/tree"
  # The files git would commit that are there (a deleted tracked file isn't), plain files only.
  (
    cd "$root" || exit 1
    git ls-files -z -co --exclude-standard |
      while IFS= read -r -d '' f; do
        [ -f "$f" ] && [ ! -L "$f" ] && printf '%s\0' "$f"
      done
  ) >"$work/files" || { echo "check-secrets: FAIL: cannot list the files" >&2; exit 1; }
  scanned="$(tr -cd '\0' <"$work/files" | wc -c | tr -d ' ') files"
  if [ -s "$work/files" ]; then
    (cd "$root" && tar -cf - --null -T "$work/files") | tar -xf - -C "$work/tree" ||
      { echo "check-secrets: FAIL: cannot copy the files" >&2; exit 1; }
  fi
  # gitleaks' own rules, and every finding: the tree's settings for it aren't read.
  rm -f "$work/tree/.gitleaks.toml" "$work/tree/.gitleaksignore"
  scan=(dir .)
  scan_dir="$work/tree"
else
  [ "$(git -C "$root" rev-parse --is-shallow-repository)" = false ] ||
    { echo "check-secrets: FAIL: a shallow clone: --history needs the full history (fetch-depth: 0)" >&2; exit 1; }
  # A bare copy: no working tree, so no .gitleaks.toml or .gitleaksignore is read from it.
  git clone --quiet --bare --no-local "$root" "$work/history.git" ||
    { echo "check-secrets: FAIL: cannot copy the history" >&2; exit 1; }
  scanned="$(git -C "$work/history.git" rev-list --all | wc -l | tr -d ' ') commits"
  scan=(git . --log-opts=--all)
  scan_dir="$work/history.git"
fi

if ! (cd "$scan_dir" && env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML "$gitleaks" "${scan[@]}" \
  --redact --no-banner --no-color --log-level error --exit-code 0 \
  --report-format template --report-template "$work/fingerprint.tmpl" --report-path "$work/found") >"$work/log" 2>&1; then
  echo "check-secrets: FAIL: gitleaks failed:" >&2
  sed 's/^/  /' "$work/log" >&2
  exit 1
fi

sort -u "$work/found" | sed '/^$/d' >"$work/found.sorted"
if [ -f "$root/.gitleaksignore" ]; then
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$root/.gitleaksignore" | sed -e '/^#/d' -e '/^$/d' | sort -u >"$work/listed"
else
  : >"$work/listed"
fi
comm -23 "$work/found.sorted" "$work/listed" >"$work/new"
# Stale entries: the tree scan only, and only tree fingerprints (three fields).
if [ "$mode" = tree ]; then
  comm -13 "$work/found.sorted" "$work/listed" | awk -F: 'NF == 3' >"$work/stale"
else
  : >"$work/stale"
fi

found=$(wc -l <"$work/found.sorted" | tr -d ' ')
status=0
while IFS= read -r fp; do
  [ -n "$fp" ] || continue
  echo "check-secrets: FAIL: gitleaks finds a secret: $fp. Remove it (and rotate it); if it is a fake (a test fixture, a made-up value), list this fingerprint in .gitleaksignore after review."
  status=1
done <"$work/new"
while IFS= read -r fp; do
  [ -n "$fp" ] || continue
  echo "check-secrets: FAIL: .gitleaksignore lists $fp, which gitleaks no longer finds: remove the line (a moved finding is listed above under its new line)."
  status=1
done <"$work/stale"
if [ "$status" = 0 ]; then
  echo "check-secrets: $mode: $scanned, $found finding(s), each listed in .gitleaksignore"
fi
exit "$status"
