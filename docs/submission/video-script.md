# Cascade demo video script

The submission film, about 2:50, built by `demo/film` from real footage: the live site, Cardanoscan, GitHub and the Coworker journal of paid Sokosumi Task `01a114cd`. Voiceover by `openai/gpt-audio` (voice coral) through OpenRouter; captions are the lines below. Output: `demo/out/cascade-demo.mp4`.

## Build

```sh
scripts/heavy.sh demo/node_modules/.bin/tsx demo/film/record.ts <raw_dir>        # headed Chrome, one shot per context
OPENROUTER_ENV=<env file> python3 demo/film/tts.py openai/gpt-audio coral <vo_dir> demo/film/lines.json
scripts/heavy.sh demo/node_modules/.bin/tsx demo/film/overlays.ts <overlay_dir>
python3 demo/film/build.py <raw_dir> <vo_dir> <overlay_dir> <work_dir> demo/out/cascade-demo.mp4
```

## Shots and voiceover

| # | Scene | Judging focus | On screen | Voiceover |
| --- | --- | --- | --- | --- |
| 1 | Hook | Pitch | Title card, then the landing page with live preprod jobs; Flaky Lisan carries a "test agent, fails on purpose" label. | Agents are starting to hire other agents. Every hire moves money. Today the agent in the middle fronts the cash and hopes everyone delivers. Cascade fixes that, on Cardano. |
| 2 | What Cascade is | Innovation | Landing page, zoom on registered agents, scroll through how it works, then the Network page. | Cascade is recursive escrow for agent teams: the missing layer on top of Masumi and x402. A buyer funds one root escrow. The plan is committed on chain as a Merkle root, so only planned tasks can be paid. Every sub-hire gets its own child escrow. The validator checks its budget and deadlines against the parent. A quorum of checker agents verifies the work. When an agent fails, its money refunds up the tree. |
| 3 | Sokosumi Task | Technical: Masumi | Paid Task 01a114cd rendered from the Coworker journal, then the Masumi escrow lock on Cardanoscan. | A real paid Task on Sokosumi preprod: a market-entry brief for a coffee subscription brand in Singapore. The buyer pays once. Masumi locks that payment in escrow on Cardano before any work starts. |
| 4 | Cascade tree | Technical: eUTXO, smart contracts | Tree Explorer stage view replays tree 4b50da32 from funding to close; Pricer's refund. | Cascade turns the Task into a tree. The Conductor funds a 60 ADA root and hires: Scout researches, Scribe writes, Checker A verifies. Pricer failed its job, so its 14.25 ADA went straight back to the parent. Nobody had to ask. |
| 5 | Buyer console | UX and design | New job, plan review, Fund this plan, wallet step. The planner wait is sped up 8x with a badge. | Any buyer can start the same flow in the console: describe the goal, review the plan and budget, sign one transaction. |
| 6 | Result and payout | Technical: Masumi | Delivered brief, receipt, Masumi result hash tx, seller withdrawal tx. | The brief comes back with cited sources, a competitor table and a Chinese summary. The receipt balances to the lovelace, with a preprod link for every payment and refund. The result hash goes on chain through Masumi, and after the unlock time the seller collects. |
| 7 | Why Cardano | Technical: eUTXO, Plutus V3, native tokens | Cascade FundRoot tx on Cardanoscan: script outputs, datum, minted thread tokens. | Why Cardano? In eUTXO every escrow is its own UTxO, so siblings settle in parallel with no shared state. Fees are known before signing. The rules are Plutus V3 validators in Aiken, and every node carries a native thread token. |
| 8 | Impact | Impact and feasibility | Network page, then the GitHub README. | Cascade is for agent marketplaces like Sokosumi, and any team whose agents subcontract work. It runs on preprod today, with real paid Tasks, and it is open source. |
| 9 | Close | Pitch | End card with the site and repo. | Cascade. Escrow at every hop. cascade-alpha-amber.vercel.app |

## Rules kept

- Every frame is the real product or a real explorer page; the Task page is rendered from the journal and says so on screen.
- Flaky Lisan and Lisan-B are labelled on screen as test agents that fail on purpose.
- Sped-up footage carries a visible badge. The tree replay is the explorer's own replay of indexed preprod events.
