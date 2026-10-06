#!/usr/bin/env bash
# Runs Lisan: the unmodified crewai-masumi-quickstart-template at the pinned commit, configured
# only through environment, behind the V1-to-V2 payment shim. See README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
"$here/fetch.sh"
[ -x "$here/.venv/bin/python" ] || { uv venv -q --python 3.12 "$here/.venv" && uv pip install -q --python "$here/.venv/bin/python" -r "$here/requirements.lock"; }
"$here/.venv/bin/python" "$here/configure.py"
shim_port="${LISAN_SHIM_PORT:-23111}"
LISAN_SHIM_UPSTREAM="${LISAN_PAYMENT_SERVICE_URL:-http://localhost:23101/api/v1}" \
  "$here/.venv/bin/python" -m uvicorn --app-dir "$here/shim" --factory payment_shim:app_from_env --host 127.0.0.1 --port "$shim_port" &
shim_pid=$!
trap 'kill "$shim_pid" 2>/dev/null || true' EXIT
cd "$here/template"
"$here/.venv/bin/python" main.py api
