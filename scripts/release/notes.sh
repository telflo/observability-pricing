#!/usr/bin/env bash
# notes.sh: a GitHub Release's notes, Markdown on stdout: the version's entry
# in CHANGELOG.md (the lines under `## <version> - YYYY-MM-DD`, up to the
# next `## `), then what the Release holds and where every price change is
# logged. The same bytes for the same inputs: no date, nothing from the
# network.
#
#   bash scripts/release/notes.sh <version> [--changelog <file>]
#
# Exit 0 written; 1 no entry for the version, or an empty one; 2 usage.
# bash 3.2 compatible.
set -euo pipefail

VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
REPOSITORY_URL="https://github.com/telflo/observability-pricing"

usage() { echo "usage: scripts/release/notes.sh <version> [--changelog <file>]" >&2; }
fail() { echo "notes: $1" >&2; exit 1; }
refuse_usage() { echo "notes: $1" >&2; usage; exit 2; }

version=""
changelog="CHANGELOG.md"
while [ $# -gt 0 ]; do
  case "$1" in
    --changelog) [ $# -ge 2 ] || refuse_usage "--changelog needs a file"; changelog="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) refuse_usage "unknown option: $1" ;;
    *) [ -z "$version" ] || refuse_usage "one version only"; version="$1"; shift ;;
  esac
done
[[ "$version" =~ $VERSION_RE ]] || refuse_usage "the version must be x.y.z"
[ -f "$changelog" ] || refuse_usage "$changelog is not a file"

# The entry's lines, without the blank lines at either end.
entry="$(awk -v heading="## $version - " '
  index($0, heading) == 1 && $0 ~ /- [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ { inside = 1; found = 1; next }
  inside && /^## / { exit }
  inside { print }
  END { if (!found) exit 3 }
' "$changelog")" || fail "$changelog has no entry '## $version - YYYY-MM-DD'"
entry="$(printf '%s\n' "$entry" | sed -e '/./,$!d')"
[ -n "$entry" ] || fail "$changelog's entry for $version is empty"

printf '%s\n' "$entry"
cat <<EOF

---

\`rates.json\` and \`rates.csv\` are every platform's rates at this version: the unit, the vendor
page each rate was read from and the day it was read. They are the files the site serves at
\`/data\`. \`SHA256SUMS\` holds their checksums.

Every price change, with the day the vendor's page was read, is in
[PRICE-LOG.md]($REPOSITORY_URL/blob/v$version/PRICE-LOG.md).
EOF
