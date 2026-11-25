#!/usr/bin/env bash
# verify-tag.sh: a release tag is checked before anything else runs, in the
# release workflow's `version` job (CONTRIBUTING.md, "Releasing").
#
#   bash scripts/release/verify-tag.sh <tag> [--fetch] [--expect <sha>] [--main <ref>]
#
# In this order, the first failure stopping it (exit 1):
#   1. the tag is v<version>, the version x.y.z (digits only, no leading
#      zeros, nothing after). A tag that fails this is never printed;
#   2. the repository holds its full history (not a shallow clone: the
#      ancestry check below needs it);
#   3. refs/tags/<tag> is an annotated tag (a tag object, not a lightweight
#      tag), whose own name is <tag> and which tags a commit. With --fetch the
#      tag is fetched from origin first: actions/checkout can leave an
#      annotated tag it checked out as a lightweight one;
#   4. with --expect <sha> (the workflow's github.sha): that is the commit;
#   5. the commit is on main (--main, default origin/main);
#   6. at that commit, package.json's version and package-lock.json's (the
#      root's and packages[""]'s) are <version>;
#   7. at that commit, CHANGELOG.md has the version's entry, a heading
#      `## <version> - YYYY-MM-DD`.
#
# On success it prints the tag, version and commit, and when GITHUB_OUTPUT is
# set appends tag=, version= and commit= to it. Exit 0 the tag is good;
# 1 refused; 2 usage. bash 3.2 compatible.
set -euo pipefail

VERSION_RE='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
SHA_RE='^[0-9a-f]{40}$'

usage() { echo "usage: scripts/release/verify-tag.sh <tag> [--fetch] [--expect <sha>] [--main <ref>]" >&2; }
fail() { echo "verify-tag: $1" >&2; exit 1; }
refuse_usage() { echo "verify-tag: $1" >&2; usage; exit 2; }

tag=""
fetch=false
expect=""
main_ref="origin/main"
while [ $# -gt 0 ]; do
  case "$1" in
    --fetch) fetch=true; shift ;;
    --expect) [ $# -ge 2 ] || refuse_usage "--expect needs a commit sha"; expect="$2"; shift 2 ;;
    --main) [ $# -ge 2 ] || refuse_usage "--main needs a ref"; main_ref="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) refuse_usage "unknown option: $1" ;;
    *) [ -z "$tag" ] || refuse_usage "one tag only"; tag="$1"; shift ;;
  esac
done
[ -n "$tag" ] || refuse_usage "no tag given"
if [ -n "$expect" ] && [[ ! "$expect" =~ $SHA_RE ]]; then
  refuse_usage "--expect must be a full commit sha"
fi

# 1. The name. Nothing below reads the tag before this.
[[ "$tag" =~ $VERSION_RE ]] || fail "the tag must be v<x.y.z>, digits only, no leading zeros (git tag -a v0.2.0)"
version="${tag#v}"

# 2. The full history.
[ "$(git rev-parse --is-shallow-repository)" = false ] \
  || fail "the repository is a shallow clone: the check needs the full history (fetch-depth: 0)"

# 3. An annotated tag, of this name, of a commit.
if [ "$fetch" = true ]; then
  git fetch --quiet --force origin "refs/tags/$tag:refs/tags/$tag" || fail "$tag could not be fetched from origin"
fi
git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null || fail "there is no tag $tag"
[ "$(git cat-file -t "refs/tags/$tag")" = tag ] \
  || fail "$tag is a lightweight tag: a release is an annotated tag (git tag -a $tag -m \"observability-pricing $version\")"
tag_object="$(git cat-file tag "refs/tags/$tag")"
[ "$(printf '%s\n' "$tag_object" | sed -n 's/^tag //p' | head -n 1)" = "$tag" ] \
  || fail "the tag object at refs/tags/$tag is named otherwise"
[ "$(printf '%s\n' "$tag_object" | sed -n 's/^type //p' | head -n 1)" = commit ] \
  || fail "$tag doesn't tag a commit"
commit="$(git rev-parse "refs/tags/$tag^{commit}")"

# 4. The commit the workflow ran for.
if [ -n "$expect" ] && [ "$commit" != "$expect" ]; then
  fail "$tag tags $commit, not the expected $expect"
fi

# 5. On main.
git rev-parse --quiet --verify "$main_ref^{commit}" >/dev/null || fail "there is no $main_ref to check against"
git merge-base --is-ancestor "$commit" "$main_ref" || fail "$tag's commit $commit is not on $main_ref"

# 6. The version in package.json and package-lock.json, at the commit.
json_field() { # <file at the commit> <JavaScript expression of `j`>
  git show "$commit:$1" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=('"$2"');process.stdout.write(typeof v==="string"?v:"")})' \
    || true
}
found="$(json_field package.json 'j.version')"
[ "$found" = "$version" ] || fail "package.json at $tag has version '$found', not $version"
found="$(json_field package-lock.json 'j.version')"
[ "$found" = "$version" ] || fail "package-lock.json at $tag has version '$found', not $version"
found="$(json_field package-lock.json '(j.packages||{})[""]?.version')"
[ "$found" = "$version" ] || fail "package-lock.json at $tag has packages[\"\"].version '$found', not $version"

# 7. The version's dated entry in CHANGELOG.md, at the commit.
version_re="$(printf '%s' "$version" | sed 's/\./\\./g')"
git show "$commit:CHANGELOG.md" 2>/dev/null \
  | grep -Eq "^## $version_re - [0-9]{4}-[0-9]{2}-[0-9]{2}\$" \
  || fail "CHANGELOG.md at $tag has no entry '## $version - YYYY-MM-DD'"

echo "tag: $tag"
echo "version: $version"
echo "commit: $commit"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "tag=$tag"
    echo "version=$version"
    echo "commit=$commit"
  } >>"$GITHUB_OUTPUT"
fi
