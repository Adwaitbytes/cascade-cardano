#!/usr/bin/env bash
# Rebuilds demo/out/cascade-pitch.pptx with demo/out/cascade-demo.mp4 embedded on the demo slide.
# Run after the recording lands: demo/deck2/embed-video.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
video="$root/demo/out/cascade-demo.mp4"
if [[ ! -s "$video" ]]; then
  echo "embed-video: $video is missing or empty; the deck keeps its poster" >&2
  exit 1
fi
cd "$root"
uv run --with python-pptx --with pillow python demo/deck2/build.py
