import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "vitest";
import { runAcceptance } from "../lib/acceptance.js";
import { ACCEPTANCE } from "../lib/catalog.js";
import { treeEvents, serviceUrls } from "../lib/console-flow.js";
import { notImplemented } from "../lib/not-implemented.js";
import { DemoManifest, MONEY_EVENTS as MONEY, spedUpMoments, timelineGaps } from "../lib/demo-manifest.js";
import { repoPath } from "../lib/repo.js";
import { escrowFlows, escrowMatcher, preprodHashes, tokenBurned } from "../lib/tree-chain.js";

describe(`A20 ${ACCEPTANCE.A20.title}`, () => {
  it("runs the section 21 demo flow on preprod and records it without cuts in any money movement", async () => {
    await runAcceptance("A20", async (run) => {
      const manifestPath = repoPath("demo", "out", "cascade-demo.json");
      const videoPath = repoPath("demo", "out", "cascade-demo.mp4");
      if (!existsSync(manifestPath) || !existsSync(videoPath)) notImplemented("the final recording demo/out/cascade-demo.mp4 and its manifest (W8 demo/record.ts final mode)");
      const m = DemoManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
      run.artefact("demo/out/cascade-demo.json");
      run.artefact("demo/out/cascade-demo.mp4");

      // The recording itself: final mode, clean, the buyer signed, a playable video of the stated length.
      run.check("final recording, not a dry run or rehearsal", { dryRun: false, rehearsal: false }, { dryRun: m.dryRun, rehearsal: m.rehearsal });
      run.check("recorder reported no failure", null, m.failure);
      // The buyer's wallet signed and submitted the funding transaction on camera.
      const submitted = m.walletSigned.filter((w) => w.submitted).map((w) => w.txHash);
      run.check("the buyer's wallet signed and submitted the funding tx on camera", true, m.fundTx !== null && submitted.includes(m.fundTx));
      run.check("video file is not empty", true, statSync(videoPath).size > 1_000_000);
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", videoPath], { encoding: "utf8" });
      const seconds = Number(probe.stdout.trim());
      run.check("video duration matches the manifest (within 2 s)", true, probe.status === 0 && Math.abs(seconds - m.outputSeconds) <= 2);

      // No cuts: the segments tile the raw recording and the video; idle waits only play faster.
      run.check("timeline only changes speed (no footage removed, no gap)", [], timelineGaps(m));
      run.check("every captioned money movement and wallet signature plays at real time", [], spedUpMoments(m));

      // The demo tree on chain: every money movement the indexer knows is captioned, confirmed and reconciled.
      if (m.treeId === null) throw new Error("the manifest names no demo tree");
      run.note(`demo tree ${m.treeId}, recorded ${m.recordedAt}`);
      const chainEvents = (await treeEvents(serviceUrls(), m.treeId)).filter((e) => MONEY.has(e.type));
      const captioned = new Set(m.events.map((e) => e.tx));
      run.check("every money movement of the demo tree is captioned with its tx in the recording", [], [...new Set(chainEvents.map((e) => e.tx_id))].filter((tx) => !captioned.has(tx)));
      const txs = [];
      for (const tx of new Set(chainEvents.map((e) => e.tx_id))) txs.push(await run.confirmTx(`demo ${chainEvents.find((e) => e.tx_id === tx)!.type}`, tx));
      const types = new Set(chainEvents.map((e) => e.type));
      run.check("the PRD 21.2 flow is complete on chain (fund, draws, a refund, settlements, close)", [], ["tree.funded", "node.drawn", "node.refunded", "node.settled", "tree.closed"].filter((t) => !types.has(t)));
      const h = preprodHashes();
      const flows = escrowFlows(txs, escrowMatcher(h));
      run.check("demo tree reconciles to the lovelace", flows.deposited, flows.released);
      run.check("demo root token burned", true, await tokenBurned(h.node, m.treeId));
    });
  });
});
