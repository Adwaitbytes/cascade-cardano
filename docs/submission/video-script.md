# Cascade demo video script

Two cuts: the full demo (2:30) and a 20-second hook. The operator records the screen and reads the voiceover. Every number on screen comes from the live run; do not read numbers that are not on screen.

Values in `{{DOUBLE_BRACES}}` come from the paid Task in [docs/sokosumi-coworker.md](../sokosumi-coworker.md).

## Before recording

- Open these tabs, logged in, at 1920x1080, browser zoom 110 %:
  1. Sokosumi preprod, TOKEN2049 workspace, Cascade Coworker page.
  2. https://cascade-alpha-amber.vercel.app/tree/{{TREE_ID}} (open once the Task starts its tree).
  3. https://cascade-alpha-amber.vercel.app/receipt/{{TREE_ID}}
  4. https://preprod.cardanoscan.io/transaction/{{MASUMI_LOCK_TX}}
- A tree takes tens of minutes on preprod. Record the Sokosumi part live, then speed up the waits in editing and show a visible "sped up" badge whenever footage runs faster than real time. Do not cut out failures or refunds.
- If the run hires Flaky Lisan or Lisan-B, keep their "test agent" label in frame: they fail on purpose to show refunds.
- Hide bookmarks, notifications and any wallet balance that is not part of the story.

## Full cut: 2:30

| # | Time | Shot (what is on screen) | Voiceover (read exactly) |
| --- | --- | --- | --- |
| 1 | 0:00 to 0:12 | Title card: "Cascade. Every hire, at every level, paid into escrow." Then cut to the Sokosumi workspace. | "Agents that hire other agents need someone to hold the money. Today the agent in the middle fronts it and hopes everyone delivers. Cascade fixes that on Cardano." |
| 2 | 0:12 to 0:30 | Sokosumi: open Cascade Coworker, create a Task. Type the goal: "{{TASK_GOAL}}". Show the price, click to assign and pay. | "This is Cascade, a Coworker on Sokosumi. I give it one Task and pay once, with Sokosumi credits. Sokosumi locks that payment in Masumi escrow on Cardano preprod." |
| 3 | 0:30 to 0:45 | Task timeline: the `masumiPayment` event and status RUNNING. Zoom on the event. | "Cascade signs the payment terms through its Masumi Payment Service. The money sits in escrow until the result hash is on chain." |
| 4 | 0:45 to 1:05 | Tree Explorer: the root node appears, then the plan. Hover the root to show budget and plan root. | "Cascade plans the work and commits the plan on chain as a Merkle root. It locks the tree budget in a root escrow. Only tasks in this plan can ever be paid." |
| 5 | 1:05 to 1:30 | Tree Explorer animating: child nodes appear as agents are hired (Scout, Pricer, Scribe, Checkers). Badge "sped up" visible. | "Now it hires. Each agent gets its own child escrow, drawn from the parent's budget. The validator checks that a child never holds more than its parent drew, and that its deadlines end before its parent's. Agents quote and pay each other with x402." |
| 6 | 1:30 to 1:50 | A node turns red or shows "missed deadline", then Refund; the value moves back to the parent; a replacement node appears. Keep the "test agent" label in frame if present. | "When an agent misses its deadline, anyone can trigger the refund. Its whole budget returns to the parent in one transaction, and Cascade hires a replacement with it." |
| 7 | 1:50 to 2:05 | Checker votes appear; nodes settle green; root accepted. Back on Sokosumi: Task COMPLETED, scroll the deliverable and the "How Cascade did it" table. | "Checker agents verify each result before money moves. The Task completes with the deliverable, plus a table of every agent hired, what each was paid and the transaction that paid it." |
| 8 | 2:05 to 2:20 | Receipt page: deposits, payouts, refunds, "balanced". Click one payout link; Cardanoscan opens. Then the Masumi escrow tab: {{MASUMI_LOCK_TX}} on Cardanoscan, scroll to the script address and datum. | "The receipt balances to the lovelace. Every line links to Cardano preprod. This is the Masumi escrow that paid Cascade for the Task." |
| 9 | 2:20 to 2:30 | End card: "cascade-alpha-amber.vercel.app", Coworker ID `01a110cd-4ee0-763b-ae63-4008564c9f8e`, repo URL. | "Cascade. One Task, a whole team of agents, escrow at every level. Try it on Sokosumi today." |

Word count of the voiceover: about 250 words, about 100 words a minute over 2:30. If a take runs long, drop the second sentence of shot 5 first.

## Hook cut: 20 seconds

| Time | Shot | Voiceover |
| --- | --- | --- |
| 0:00 to 0:05 | Sokosumi: Task assigned to Cascade Coworker. | "One Task on Sokosumi. One payment." |
| 0:05 to 0:13 | Tree Explorer, sped up: nodes appear, one refunds, a replacement appears, nodes settle. | "Cascade hires a team of agents and pays each one from its own escrow on Cardano. Failed work refunds up the tree." |
| 0:13 to 0:20 | Receipt, then Cardanoscan. End card with the site URL. | "Every payment, on chain. Cascade, on Sokosumi now." |

## After recording

- Export 1080p MP4, H.264, under 100 MB.
- Add captions from the voiceover column.
- Put the video URL into [builderbase.md](builderbase.md) (`{{VIDEO_URL}}`).
