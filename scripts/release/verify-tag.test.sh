#!/usr/bin/env bash
# verify-tag.test.sh: verify-tag.sh against throwaway repositories, one per
# case, made from scratch (no network, no global git configuration).
#
#   bash scripts/release/verify-tag.test.sh
#
# Exit 0 every case passed; 1 one failed. bash 3.2 compatible.
set -euo pipefail

SCRIPT="$(CDPATH='' cd -- "$(dirname -- "$0")" >/dev/null && pwd)/verify-tag.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GITHUB_OUTPUT

failures=0
pass() { echo "ok   $1"; }
flunk() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

# A repository at version <package> (lockfile <lock>, CHANGELOG heading
# <heading>), its one commit on main.
repo() { # <name> <package version> <lock version> <changelog heading>
  local dir="$WORK/$1"
  mkdir -p "$dir"
  git -C "$dir" init --quiet --initial-branch=main
  printf '{\n  "name": "observability-pricing",\n  "version": "%s"\n}\n' "$2" >"$dir/package.json"
  printf '{\n  "name": "observability-pricing",\n  "version": "%s",\n  "lockfileVersion": 3,\n  "packages": {\n    "": { "name": "observability-pricing", "version": "%s" }\n  }\n}\n' "$3" "$3" >"$dir/package-lock.json"
  printf '# Changelog\n\n## Unreleased\n\n%s\n\n- Something.\n' "$4" >"$dir/CHANGELOG.md"
  git -C "$dir" add . && git -C "$dir" commit --quiet -m one
  echo "$dir"
}

# expect_ok <name> <dir> <args...>: verify-tag passes.
expect_ok() {
  local name="$1" dir="$2"; shift 2
  if (cd "$dir" && bash "$SCRIPT" "$@" --main main) >"$WORK/out" 2>&1; then pass "$name"
  else flunk "$name: $(cat "$WORK/out")"; fi
}

# expect_refused <name> <dir> <message part> <args...>: verify-tag exits 1
# saying <message part>.
expect_refused() {
  local name="$1" dir="$2" says="$3" code=0; shift 3
  (cd "$dir" && bash "$SCRIPT" "$@" --main main) >"$WORK/out" 2>&1 || code=$?
  if [ "$code" -eq 1 ] && grep -qF -- "$says" "$WORK/out"; then pass "$name"
  else flunk "$name: exit $code, $(cat "$WORK/out")"; fi
}

good="$(repo good 0.2.0 0.2.0 '## 0.2.0 - 2026-11-24')"
git -C "$good" tag -a v0.2.0 -m "observability-pricing 0.2.0"
expect_ok "an annotated tag on main, the versions and the changelog agreeing" "$good" v0.2.0

commit="$(git -C "$good" rev-parse HEAD)"
expect_ok "--expect, the tag's commit" "$good" v0.2.0 --expect "$commit"
expect_refused "--expect, another commit" "$good" "not the expected" v0.2.0 --expect 0123456789abcdef0123456789abcdef01234567

output="$WORK/github-output"
: >"$output"
(cd "$good" && GITHUB_OUTPUT="$output" bash "$SCRIPT" v0.2.0 --main main) >/dev/null
if [ "$(cat "$output")" = "$(printf 'tag=v0.2.0\nversion=0.2.0\ncommit=%s' "$commit")" ]; then
  pass "the outputs, to GITHUB_OUTPUT"
else
  flunk "the outputs, to GITHUB_OUTPUT: $(cat "$output")"
fi

for bad in 0.2.0 v0.2 v0.2.0-rc.1 v01.2.0 v0.2.0x 'v0.2.0;x'; do
  expect_refused "the name '$bad' refused" "$good" "must be v<x.y.z>" "$bad"
done
if (cd "$good" && bash "$SCRIPT" 'not-a-tag;secret' --main main) 2>&1 | grep -qF secret; then
  flunk "a refused name isn't printed"
else
  pass "a refused name isn't printed"
fi

expect_refused "a tag that doesn't exist" "$good" "there is no tag" v9.9.9

light="$(repo light 0.2.0 0.2.0 '## 0.2.0 - 2026-11-24')"
git -C "$light" tag v0.2.0
expect_refused "a lightweight tag" "$light" "lightweight" v0.2.0

renamed="$(repo renamed 0.2.0 0.2.0 '## 0.2.0 - 2026-11-24')"
git -C "$renamed" tag -a v0.1.0 -m old
git -C "$renamed" update-ref refs/tags/v0.2.0 "$(git -C "$renamed" rev-parse refs/tags/v0.1.0)"
expect_refused "a tag object named otherwise" "$renamed" "named otherwise" v0.2.0

side="$(repo side 0.2.0 0.2.0 '## 0.2.0 - 2026-11-24')"
git -C "$side" switch --quiet -c side
git -C "$side" commit --quiet --allow-empty -m "off main"
git -C "$side" tag -a v0.2.0 -m "observability-pricing 0.2.0"
expect_refused "a commit not on main" "$side" "is not on main" v0.2.0

package="$(repo package 0.1.0 0.2.0 '## 0.2.0 - 2026-11-24')"
git -C "$package" tag -a v0.2.0 -m "observability-pricing 0.2.0"
expect_refused "package.json at another version" "$package" "package.json at v0.2.0 has version '0.1.0'" v0.2.0

lock="$(repo lock 0.2.0 0.1.0 '## 0.2.0 - 2026-11-24')"
git -C "$lock" tag -a v0.2.0 -m "observability-pricing 0.2.0"
expect_refused "package-lock.json at another version" "$lock" "package-lock.json at v0.2.0 has version '0.1.0'" v0.2.0

for heading in '## 0.2.0' '## 0.2.0 - soon' '## 0.2.01 - 2026-11-24' '## 0x2x0 - 2026-11-24'; do
  changelog="$(repo "changelog$RANDOM" 0.2.0 0.2.0 "$heading")"
  git -C "$changelog" tag -a v0.2.0 -m "observability-pricing 0.2.0"
  expect_refused "the changelog heading '$heading' refused" "$changelog" "CHANGELOG.md at v0.2.0 has no entry" v0.2.0
done

shallow="$WORK/shallow"
git clone --quiet --depth 1 "file://$good" "$shallow"
expect_refused "a shallow clone" "$shallow" "shallow clone" v0.2.0

code=0
(cd "$good" && bash "$SCRIPT" --nonsense) >/dev/null 2>&1 || code=$?
if [ "$code" -eq 2 ]; then pass "an unknown option is usage (2)"; else flunk "an unknown option is usage (2): exit $code"; fi

if [ "$failures" -gt 0 ]; then
  echo "verify-tag.test.sh: $failures failed" >&2
  exit 1
fi
echo "verify-tag.test.sh: every case passed"
