# How to run the Cascade build with Claude Code

This kit turns the PRD into an autonomous build. The long instructions live in files the agent reads (`CLAUDE.md`, `docs/MASTER_PROMPT.md`, `docs/PRD.md`). A short `/goal` condition (`GOAL.txt`) keeps Claude Code working turn after turn until the finish line is proven in the transcript.

Why it is set up this way: `/goal` accepts a condition of up to 4,000 characters, and its evaluator (a small fast model) judges only what appears in the conversation, not files on disk. So the condition names measurable proof, and the agent prints a STATUS block every turn so progress is visible to the evaluator. Docs: https://code.claude.com/docs/en/goal.md

## 1. Timing rule (read first)

TOKEN2049 Origins requires projects to be built entirely during the official build window. Code written earlier makes the project ineligible. So:

- **Before the start:** only do sections 2 and 3 (accounts, keys, machine, empty repo with this kit). Do not launch the build.
- **At the official start:** run section 4.

## 2. Prepare accounts and keys

| Item | How | Goes in `.env` as |
| --- | --- | --- |
| Claude Code v2.1.139 or later, signed in on a plan with Opus 5.5 and auto mode | `npm i -g @anthropic-ai/claude-code`, then `claude --version` | not in `.env` |
| Anthropic API key for the product's own LLM calls | console.anthropic.com | `ANTHROPIC_API_KEY` |
| Optional second LLM key (different provider for Verifier B) | your provider | `SECOND_LLM_API_KEY` |
| Blockfrost preprod project | blockfrost.io | `BLOCKFROST_PROJECT_ID_PREPROD` |
| Preprod treasury wallet | Create a fresh wallet used only for testnet. Fund it from the Cardano testnet faucet on preprod. Put its mnemonic in `.env` only. | `CASCADE_TREASURY_MNEMONIC` |
| Preprod tUSDM (optional) | Check the Masumi docs or community for a preprod tUSDM source. If you get some, send it to the treasury. | `PREPROD_TUSDM_AVAILABLE=true` |
| GitHub repo and token | Create an empty repo; fine-grained token with repo write | `GITHUB_TOKEN`, `GIT_REMOTE_URL` |
| Hosting | Vercel token for the web app, plus either a Linux host with SSH or a Railway token for services | `VERCEL_TOKEN`, `DEPLOY_HOST`, `DEPLOY_SSH_KEY_PATH` or `RAILWAY_TOKEN` |
| Optional managed chain access | Demeter.run account if you do not want to run a preprod node | `DEMETER_API_KEY` |

Never put a mainnet key anywhere in this setup.

## 3. Prepare the machine and folder

1. Use a dedicated Linux VM or a spare Mac with Docker, Node 20 or later, git, and plenty of RAM and disk (a preprod node needs real disk space; use Demeter if short).
2. Make an empty folder, copy everything from this kit into it, then:

```bash
cd cascade
git init && git add . && git commit -m "Kit: PRD, master prompt, harness"
cp .env.example .env        # fill it in; .env is git-ignored
chmod +x .claude/hooks/kill-switch.sh
```

3. Check auto mode is available on your account: start `claude` in the folder and press Shift+Tab until you see "auto mode on". If it never appears, see section 7.

## 4. Launch at the official start

Load your environment in the shell, then start Claude Code on Opus 5.5 in auto mode:

```bash
set -a; source .env; set +a
claude --model claude-opus-5-5 --permission-mode auto
```

Inside Claude Code, type `/goal` followed by a space, paste the full contents of `GOAL.txt`, and press Enter. Setting the goal starts the first turn immediately; you do not need a separate prompt.

Headless alternative (same loop, no UI; stream output so it never looks stuck):

```bash
set -a; source .env; set +a
claude -p "/goal $(cat GOAL.txt)" --model claude-opus-5-5 --permission-mode auto \
  --output-format stream-json --verbose | tee run.log
```

## 5. Watch it work

Everything lands on disk. A tmux grid works well:

```bash
watch -n 5  'tail -40 PROGRESS.md'
watch -n 10 'git log --oneline -12'
watch -n 30 'cat test-results.json'
watch -n 30 'tail -20 BLOCKERS.md'
```

Inside Claude Code, run `/goal` with no arguments to see the condition, turns evaluated, token spend and the evaluator's latest reason.

## 6. Steer, pause, stop, resume

| You want to | Do this |
| --- | --- |
| Redirect mid-run | Write plain instructions into `STEER.md`. The agent reads it at the start of its next turn, follows it, logs it and clears it. |
| Pause everything | `touch AGENT_STOP` (the hook blocks every tool call). Remove it and send "continue" to resume. |
| Stop the goal | `/goal clear` in the session, or Ctrl+C for headless runs |
| Resume after a crash or reboot | `claude --continue` restores an active goal; the agent re-reads `PROGRESS.md` |

A goal also clears on its own after errors you must fix: authentication failure, exhausted credits, a context overflow that compaction could not clear, or an unavailable model. Fix the cause and run `/goal` again with the same condition.

If the build window is getting short, write this into `STEER.md`: "Prioritise the demo path: A1, A2, A3, A7, then the demo video, deck and README. Finish the remaining acceptance tests after that." The PRD scope is large, and this keeps a winning submission safe.

## 7. If auto mode is not available

- Use `--permission-mode acceptEdits` and add `permissions.allow` rules in `.claude/settings.json` for the commands the build needs (pnpm, npx, aiken, docker, git, curl, uv, python).
- Or, only inside a disposable VM holding nothing but testnet keys, use `--dangerously-skip-permissions`.

## 8. Cost and safety

- `/goal` has no built-in turn or time limit. Parallel agents multiply token use. Watch spend in the `/goal` status and set alerts on your plan or API console.
- Give the machine testnet keys only. The settings file blocks reading `.env` and force-pushes, and the agent rules forbid mainnet and printing secrets.

## 9. When it finishes

1. Read `FINAL_REPORT.md` and check every URL and tx link yourself.
2. Watch `demo/out/cascade-demo.mp4` end to end.
3. Open `demo/out/cascade-deck.pptx`, confirm the video plays inside the slide, add your team slide, and upload it to Google Drive.
4. Submit the GitHub repo, the live URL and the Drive link before the deadline. The deck is locked once submitted.

## 10. What is in this kit

| Path | Purpose |
| --- | --- |
| `GOAL.txt` | The `/goal` condition (under 4,000 characters) |
| `CLAUDE.md` | Standing rules loaded every session |
| `docs/MASTER_PROMPT.md` | Full build instructions: team, waves, quality bars, verify script, fallbacks |
| `docs/PRD.md` | The product spec |
| `.claude/settings.json` | Auto mode, agent teams flag, secret and force-push deny rules, kill-switch hook |
| `.claude/hooks/kill-switch.sh` | Pauses all tool calls while `AGENT_STOP` exists |
| `.claude/agents/*.md` | Evaluator plus one subagent per workstream |
| `test-results.json` | Default-FAIL contract for A1 to A20 |
| `PROGRESS.md`, `DECISIONS.md`, `BLOCKERS.md`, `THIRD_PARTY.md`, `STEER.md` | Harness files the agent maintains |
| `.env.example` | Every variable the build reads |

The harness pattern (default-FAIL results, fresh-context evaluator, agent-maintained handoff, kill switch, steer file) follows Anthropic's long-running agent primitives: https://github.com/anthropics/cwc-long-running-agents
