#!/usr/bin/env bash
# github-release.sh: the GitHub Release v<version>, last step of the release
# workflow's `publish` job, from the tag's checked-out commit with its
# dependencies installed (npm ci).
#
#   TAG=v<version> VERSION=<version> GH_TOKEN=... GH_REPO=owner/name \
#     bash scripts/release/github-release.sh
#
# It writes the data files (npm run data), copies rates.json and rates.csv
# into a folder of their own with their SHA256SUMS, writes the notes
# (scripts/release/notes.sh) and creates the Release from the existing tag
# (--verify-tag: gh never makes a tag). A Release that exists already is
# never made again: the run ends there, so "Re-run failed jobs" is safe.
#
# Values come only from the environment; GH_TOKEN is read by gh, never
# printed. Exit 0 created, or there already; 1 a step failed; 2 usage.
set -euo pipefail

VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

fail() { echo "github-release: $1" >&2; exit 1; }
refuse_usage() { echo "github-release: $1" >&2; exit 2; }

: "${TAG:?}" "${VERSION:?}" "${GH_TOKEN:?}" "${GH_REPO:?}"
[[ "$VERSION" =~ $VERSION_RE ]] || refuse_usage "VERSION must be x.y.z"
[ "$TAG" = "v$VERSION" ] || refuse_usage "TAG must be v\$VERSION"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "::notice::the GitHub Release $TAG exists already: not made again"
  exit 0
fi

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

npm run --silent data
cp public/data/rates.json public/data/rates.csv "$out/"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$out" && sha256sum rates.json rates.csv >SHA256SUMS)
else
  (cd "$out" && shasum -a 256 rates.json rates.csv >SHA256SUMS)
fi
bash scripts/release/notes.sh "$VERSION" >"$out/notes.md"

gh release create "$TAG" \
  --verify-tag \
  --title "Observability Pricing $VERSION" \
  --notes-file "$out/notes.md" \
  "$out/rates.json" "$out/rates.csv" "$out/SHA256SUMS" \
  || fail "gh release create $TAG failed"

echo "Released $TAG: rates.json, rates.csv, SHA256SUMS"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "Released [$TAG](https://github.com/$GH_REPO/releases/tag/$TAG)"
    echo
    echo '```'
    cat "$out/SHA256SUMS"
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi
