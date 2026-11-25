#!/usr/bin/env bash
# notes.test.sh: notes.sh against made-up changelogs.
#
#   bash scripts/release/notes.test.sh
#
# Exit 0 every case passed; 1 one failed. bash 3.2 compatible.
set -euo pipefail

SCRIPT="$(CDPATH='' cd -- "$(dirname -- "$0")" >/dev/null && pwd)/notes.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok   $1"; }
flunk() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

cat >"$WORK/CHANGELOG.md" <<'EOF'
# Changelog

## Unreleased

- Not yet.

## 0.2.0 - 2026-12-01

### Changed

- Datadog's log rate.

## 0.1.0 - 2026-11-24

The first release.

### Added

- The calculator.
EOF

notes="$(bash "$SCRIPT" 0.2.0 --changelog "$WORK/CHANGELOG.md")"
expected_head="$(printf '### Changed\n\n- Datadog'"'"'s log rate.\n\n---')"
if [ "$(printf '%s\n' "$notes" | head -n 5)" = "$expected_head" ]; then
  pass "a middle entry: its lines only, then the footer"
else
  flunk "a middle entry: got
$notes"
fi
if printf '%s\n' "$notes" | grep -qF "blob/v0.2.0/PRICE-LOG.md"; then
  pass "the footer links PRICE-LOG.md at the tag"
else
  flunk "the footer links PRICE-LOG.md at the tag"
fi

notes="$(bash "$SCRIPT" 0.1.0 --changelog "$WORK/CHANGELOG.md")"
if [ "$(printf '%s\n' "$notes" | head -n 1)" = "The first release." ] \
  && printf '%s\n' "$notes" | grep -qF -- "- The calculator." \
  && ! printf '%s\n' "$notes" | grep -qF "Datadog"; then
  pass "the last entry, to the end of the file"
else
  flunk "the last entry: got
$notes"
fi

if [ "$(bash "$SCRIPT" 0.2.0 --changelog "$WORK/CHANGELOG.md")" = "$(bash "$SCRIPT" 0.2.0 --changelog "$WORK/CHANGELOG.md")" ]; then
  pass "the same bytes for the same inputs"
else
  flunk "the same bytes for the same inputs"
fi

expect_code() { # <name> <code> <args...>
  local name="$1" want="$2" code=0; shift 2
  bash "$SCRIPT" "$@" >/dev/null 2>&1 || code=$?
  if [ "$code" -eq "$want" ]; then pass "$name"; else flunk "$name: exit $code, not $want"; fi
}
expect_code "a version with no entry" 1 0.3.0 --changelog "$WORK/CHANGELOG.md"
expect_code "not x.y.z" 2 v0.2.0 --changelog "$WORK/CHANGELOG.md"
expect_code "no changelog" 2 0.2.0 --changelog "$WORK/missing.md"

printf '# Changelog\n\n## 0.4.0 - 2026-12-09\n\n## 0.3.0 - 2026-12-08\n\n- Something.\n' >"$WORK/empty.md"
expect_code "an empty entry" 1 0.4.0 --changelog "$WORK/empty.md"

printf '# Changelog\n\n## 0.4.0\n\n- Undated.\n' >"$WORK/undated.md"
expect_code "an undated heading" 1 0.4.0 --changelog "$WORK/undated.md"

if [ "$failures" -gt 0 ]; then
  echo "notes.test.sh: $failures failed" >&2
  exit 1
fi
echo "notes.test.sh: every case passed"
