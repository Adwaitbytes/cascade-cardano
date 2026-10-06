#!/usr/bin/env bash
# Builds plutus.json and bakes the deployment tag into the three leaf validators
# (cascade_config, cascade_bond, cascade_channel). The tag changes their hashes and,
# through the hash parameters, every other Cascade script hash, without touching any
# validator logic. The committed plutus.json is the output of this script; plain
# `aiken build` leaves the leaves parameterised and off-chain loaders reject it.
# Usage: contracts/scripts/build.sh   (tag read from contracts/deployment-tag)
set -euo pipefail
cd "$(dirname "$0")/.."
tag="$(tr -d '\n' < deployment-tag)"
len=${#tag}
if (( len == 0 || len > 64 )); then
  echo "deployment-tag must be 1 to 64 ASCII bytes, got $len" >&2
  exit 1
fi
hex="$(printf '%s' "$tag" | xxd -p | tr -d '\n')"
# CBOR byte string header: major type 2, one-byte length when len >= 24.
if (( len < 24 )); then header="$(printf '%02x' $((0x40 + len)))"; else header="58$(printf '%02x' "$len")"; fi
aiken build --trace-level silent
for v in cascade_config cascade_bond cascade_channel; do
  aiken blueprint apply -m "$v" -v "$v" "$header$hex" -o plutus.json
done
echo "Applied deployment tag \"$tag\" to the leaf validators"
