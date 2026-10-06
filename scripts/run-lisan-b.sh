#!/usr/bin/env bash
# Runs Lisan-B for A4: a second copy of the unmodified crewai-masumi-quickstart-template at the same
# pinned commit as Lisan (agents/lisan-masumi/fetch.sh), configured with an invalid model id so every
# job errors and never submits. Test agent: fails on purpose to demonstrate Masumi refunds.
# Reuses W4's Python environment and V1-to-V2 payment shim without editing them; the checkout lives
# in git-ignored infra/.data/lisan-b/template so its .env never touches Lisan's.
#
# Usage: scripts/run-lisan-b.sh [start|stop]
set -euo pipefail
set -m
root="$(cd "$(dirname "$0")/.." && pwd)"
lisan="$root/agents/lisan-masumi"
data="$root/infra/.data/lisan-b"
dest="$data/template"
mkdir -p "$data"
repo="https://github.com/masumi-network/crewai-masumi-quickstart-template.git"
commit="$(sed -n 's/^commit="\([0-9a-f]\{40\}\)"$/\1/p' "$lisan/fetch.sh")"
[[ -n "$commit" ]] || { echo "cannot read the pinned commit from agents/lisan-masumi/fetch.sh" >&2; exit 1; }

stop() {
  for f in "$data"/*.pid; do
    [[ -f "$f" ]] || continue
    kill -- "-$(cat "$f")" 2>/dev/null || kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
}
if [[ "${1:-start}" == "stop" ]]; then stop; echo "Stopped Lisan-B."; exit 0; fi
stop

# Same pin and the same unmodified-checkout rule as agents/lisan-masumi/verify.sh.
if [[ ! -d "$dest/.git" || "$(git -C "$dest" rev-parse HEAD)" != "$commit" ]]; then
  rm -rf "$dest" && mkdir -p "$dest"
  git -C "$dest" init -q
  git -C "$dest" remote add origin "$repo"
  git -C "$dest" fetch -q --depth 1 origin "$commit"
  git -C "$dest" checkout -q --detach FETCH_HEAD
fi
git -C "$dest" diff --quiet HEAD -- || { echo "Lisan-B template has local modifications" >&2; exit 1; }
untracked="$(git -C "$dest" ls-files --others --exclude-standard | grep -v -E '^(\.env$|\.venv/|__pycache__/|.*\.pyc$|.*\.log$|logs/)' || true)"
[[ -z "$untracked" ]] || { echo "Lisan-B template has untracked files: $untracked" >&2; exit 1; }
echo "Lisan-B template verified: unmodified at $commit"

[[ -x "$lisan/.venv/bin/python" ]] || { echo "run agents/lisan-masumi/run.sh once to install the template's Python environment" >&2; exit 1; }
"$root/node_modules/.bin/tsx" "$root/scripts/lisan-b-env.ts" "$dest"

(LISAN_SHIM_UPSTREAM="http://localhost:23102/api/v1" exec "$lisan/.venv/bin/python" -m uvicorn --app-dir "$lisan/shim" \
  --factory payment_shim:app_from_env --host 127.0.0.1 --port 23112) >"$data/shim.log" 2>&1 &
echo $! >"$data/shim.pid"
(cd "$dest" && export CREWAI_STORAGE_DIR=cascade-lisan-b && exec "$lisan/.venv/bin/python" main.py api) >"$data/agent.log" 2>&1 &
echo $! >"$data/agent.pid"
echo "started Lisan-B on 127.0.0.1:24011 (shim 23112 -> payment service 23102); logs in infra/.data/lisan-b/"
