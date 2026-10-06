#!/usr/bin/env bash
# Entrypoint for the yaci-cli container: creates a fresh devnet and starts it.
# yaci-cli is an interactive shell that stops the node when its stdin closes,
# so the command is piped in and stdin is held open for the container's lifetime.
set -euo pipefail

cmd="create-node --overwrite --slot-length 1 --block-time 1 --start"
echo "start-devnet: running '${cmd}'"
{ printf '%s\n' "${cmd}"; exec sleep infinity; } | exec /app/yaci-cli.sh
