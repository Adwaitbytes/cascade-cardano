#!/usr/bin/env bash
# Vendors masumi-network/crewai-masumi-quickstart-template at a pinned commit into ./template.
# The checkout is never edited: verify.sh fails if any tracked file differs from the pinned commit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="https://github.com/masumi-network/crewai-masumi-quickstart-template.git"
commit="0d13f37b2285f3a0e5e23987c6db5456dd9cd79a"
dest="$here/template"

if [ -d "$dest/.git" ] && [ "$(git -C "$dest" rev-parse HEAD)" = "$commit" ]; then
  echo "template already at $commit"
else
  rm -rf "$dest"
  mkdir -p "$dest"
  git -C "$dest" init -q
  git -C "$dest" remote add origin "$repo"
  git -C "$dest" fetch -q --depth 1 origin "$commit"
  git -C "$dest" checkout -q --detach FETCH_HEAD
fi
"$here/verify.sh"
