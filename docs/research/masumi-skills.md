# masumi-skills (digest)

## Source

`masumi-network/masumi-skills`, commit `3eabe4a243dfd3ee326a105736215eeb0d83c787`. Licence: MIT ("Copyright (c) 2025 Masumi Network").

## What exists

The repo holds **one** skill, named `masumi`. It has a `SKILL.md` plus reference files:

```
masumi-skills/
├── .env.example
├── install.sh
├── skill/
│   ├── SKILL.md                       # frontmatter: name: masumi
│   └── references/
│       ├── api-debug-recipes.md       # safe .env handling + curl/Python recipes
│       ├── sokosumi-api-reference.md  # Sokosumi v1 endpoint catalog
│       ├── masumi-registry-api.md     # Registry Service endpoints
│       ├── masumi-payments.md         # Payment Service
│       ├── registry-identity.md       # registry concepts, DIDs, NFTs
│       ├── smart-contracts.md
│       ├── cardano-blockchain.md
│       ├── agentic-services.md        # MIP-003
│       ├── sokosumi-marketplace.md
│       └── kodosumi-runtime.md
└── README.md
```

The `SKILL.md` frontmatter description triggers on "monetize my agent", "setup agent payments", "list on marketplace", "A2A transactions", "deploy agent at scale", and "MIP-003 implementation".

This file is a secondary source. It is Masumi's own summary, so treat its facts as lower priority than the primary repos cited in the other digests.

## Installing for Claude Code

There are two documented ways.

1. **skills.sh:**

   ```
   npx skills add https://github.com/masumi-network/masumi-skills --skill masumi
   ```

2. **Manual:**

   ```
   git clone https://github.com/masumi-network/masumi-skills
   cd masumi-skills && ./install.sh
   ```

   `install.sh` picks a target directory in this priority order:
   - `$SKILLS_DIR`
   - `~/.claude/skills` (if it exists)
   - `~/.cursor/skills`
   - `~/.windsurf/skills`
   - `~/.cline/skills`
   - `~/.ai-skills` (created)

   It then copies `skill/*` into `<target>/masumi/` and copies `.env.example` alongside.

The resulting Claude Code layout is `~/.claude/skills/masumi/SKILL.md` with `~/.claude/skills/masumi/references/*.md`. This is the standard Claude Code skill layout: `<skills dir>/<skill-name>/SKILL.md`. For a project-scoped install, set `SKILLS_DIR=<repo>/.claude/skills` before running `install.sh`.

The README says it also works with Cursor, Windsurf, Cline, Aider, and Codex. It also points to an entry point at `https://masumi.network/skill.md`.

The skill's API-key rule, stated in the README: keys are read only from a local `.env`. The skill never asks for a key in chat, never logs a key, and never commits one.
