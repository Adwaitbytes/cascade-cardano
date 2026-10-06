#!/usr/bin/env bash
# Proves ./template is the unmodified upstream template at the pinned commit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
commit="0d13f37b2285f3a0e5e23987c6db5456dd9cd79a"
dest="$here/template"
[ -d "$dest/.git" ] || { echo "template missing: run fetch.sh" >&2; exit 1; }
head="$(git -C "$dest" rev-parse HEAD)"
[ "$head" = "$commit" ] || { echo "template is at $head, expected $commit" >&2; exit 1; }
# Tracked files must match the commit exactly. Untracked files are allowed only for the .env that
# configure.py writes and runtime state the template creates (caches, logs), never for code.
if ! git -C "$dest" diff --quiet HEAD --; then
  echo "template has local modifications:" >&2
  git -C "$dest" diff --stat HEAD -- >&2
  exit 1
fi
untracked="$(git -C "$dest" ls-files --others --exclude-standard | grep -v -E '^(\.env$|\.venv/|__pycache__/|.*\.pyc$|.*\.log$|logs/)' || true)"
[ -z "$untracked" ] || { echo "template has untracked files: $untracked" >&2; exit 1; }
echo "template verified: unmodified at $commit"
