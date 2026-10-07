#!/usr/bin/env bash
# Builds the 1080x1350 cut as its own HyperFrames project in .vertical/ (git-ignored): index.html at
# 1080x1350 plus a copy of assets/. The layout code in index.html switches on the canvas aspect.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .vertical
mkdir -p .vertical
cp -R assets .vertical/assets
sed -e 's|data-width="1920" data-height="1080"|data-width="1080" data-height="1350"|' \
    -e 's|content="width=1920, height=1080"|content="width=1080, height=1350"|' \
    -e 's|<title>Cascade launch</title>|<title>Cascade launch vertical</title>|' index.html > .vertical/index.html
