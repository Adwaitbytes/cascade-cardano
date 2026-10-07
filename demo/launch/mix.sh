#!/usr/bin/env bash
# Mixes the synthesized score with the voiceover (starting at 26.9 s), then applies one static gain
# so the whole film measures about -18 LUFS integrated, with a -1.5 dBTP limiter as a safety net.
set -euo pipefail
cd "$(dirname "$0")"
node synth.mjs
premix() {
  ffmpeg -v error -y -i assets/audio/score.wav -i assets/audio/vo-coral.wav -filter_complex \
    "[1:a]aresample=48000,highpass=f=90,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,volume=${1}dB,adelay=26900|26900,apad[vo];\
     [0:a][vo]amix=inputs=2:normalize=0:duration=first,volume=${2}dB,alimiter=limit=0.84:level=false[out]" \
    -map "[out]" -ar 48000 -ac 2 -t 30 "$3"
}
lufs() { ffmpeg -hide_banner -i "$1" -af ebur128 -f null - 2>&1 | awk '/Summary/{s=1} s&&/I:/{print $2; exit}'; }
premix 15 0 assets/audio/premix.wav
gain=$(awk -v i="$(lufs assets/audio/premix.wav)" 'BEGIN{printf "%.2f", -18 - i}')
premix 15 "$gain" assets/audio/mix.wav
rm assets/audio/premix.wav
echo "integrated $(lufs assets/audio/mix.wav) LUFS (gain ${gain} dB)"
