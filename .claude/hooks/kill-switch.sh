#!/usr/bin/env bash
# Blocks every tool call while an AGENT_STOP file exists at the project root.
# Create it to pause the run:  touch AGENT_STOP     Remove it to allow work again.
if [ -f "${CLAUDE_PROJECT_DIR:-.}/AGENT_STOP" ]; then
  echo "AGENT_STOP is present: the operator paused this run. Stop all work and end the turn." >&2
  exit 2
fi
exit 0
