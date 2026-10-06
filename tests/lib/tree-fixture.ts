/**
 * A funded Cascade deployment on the local devnet plus helpers to plan, fund and draw trees.
 * Every state change goes through the SDK and is signed, submitted and confirmed on chain.
 */
import {
  acceptanceHash,
  bytesToHex,
  merkleProof,
  merkleRoot,
  sha256,
  utf8,
  ZERO_HASH,
  ZERO_PAYEE_HASH,
  type Acceptance,
  type PlanLeaf,
  type TreeConfig,
} from "@cascade/shared";
import type { BuiltTx, CascadeClient, NativeChild } from "@cascade/sdk";
import { chainTimeMs, connectCascade, faucet, localDeployment, party, sleep, submitBuilt, type Party } from "./devnet.js";
import { KOIOS_OGMIOS_PREPROD, preprodClient, preprodRole } from "./preprod.js";
import { optionalEnv } from "./repo.js";

export const ADA = 1_000_000n;
export const LOVELACE = { policy: "", name: "" } as const;
export const h32 = (label: string): string => bytesToHex(sha256(utf8(label)));

export interface Parties {
  buyer: Party;
  operator: Party;
  workerA: Party;
  workerB: Party;
  seller: Party;
  arbiterA: Party;
  arbiterB: Party;
  /** Pays fees for transactions that must not touch the buyer's wallet UTxOs. */
  cranker: Party;
}

/** A plan: the leaves in Plan order and their Merkle root. Leaf 0 is the root node. */
export interface Plan {
  leaves: PlanLeaf[];
  root: string;
}

export interface LeafSpec {
  tag: string;
  parent: number;
  kind?: PlanLeaf["kind"];
  /** Acceptance the child will carry; its hash is bound in the leaf (ADR 1.6 E7). Default ParentAccept. */
  acceptance?: Acceptance;
  maxBudget: bigint;
  maxFee: bigint;
  payeeHash?: string;
}

export class TreeLab {
  private constructor(
    /** Fee payer: the buyer's wallet. */
    readonly client: CascadeClient,
    /** Same deployment, fee payer: the cranker's wallet. */
    readonly crankerClient: CascadeClient,
    readonly parties: Parties,
    readonly network: "yaci" | "preprod",
    /** Ogmios JSON-RPC over HTTP: the local node, or Koios's proxy to a preprod node. */
    readonly ogmiosHttp: string,
  ) {}

  /**
   * Role wallets from the treasury mnemonic on the deployed preprod scripts. Budgets stay small.
   * `buyer` is the calling test's own wallet (lib/acceptance-wallets.ts), so its inputs are never
   * spent underneath it by a test running beside it.
   */
  static async preprod(buyer: Party): Promise<TreeLab> {
    const parties: Parties = {
      buyer,
      operator: preprodRole("conductor"),
      workerA: preprodRole("scout"),
      workerB: preprodRole("pricer"),
      seller: preprodRole("lookup-api"),
      arbiterA: preprodRole("arbiter-1"),
      arbiterB: preprodRole("arbiter-2"),
      // Not "watchtower": the running watchtower service spends that wallet's inputs.
      cranker: preprodRole(optionalEnv("CASCADE_QA_CRANKER_ROLE") ?? "qa-cranker"),
    };
    return new TreeLab(await preprodClient(parties.buyer), await preprodClient(parties.cranker), parties, "preprod", KOIOS_OGMIOS_PREPROD);
  }

  /** What the adversarial runner needs: client, Ogmios endpoint, signing keys other than the fee payer. */
  caseContext() {
    return { client: this.client, ogmiosHttp: this.ogmiosHttp, network: this.network, parties: this.all.filter((p) => p !== this.parties.buyer) };
  }

  /** Fresh keys funded by the devnet faucet, connected to the locally deployed scripts. */
  static async create(buyerAda = 2_000): Promise<TreeLab> {
    const parties: Parties = {
      buyer: party("buyer"),
      operator: party("operator"),
      workerA: party("workerA"),
      workerB: party("workerB"),
      seller: party("seller"),
      arbiterA: party("arbiterA"),
      arbiterB: party("arbiterB"),
      cranker: party("cranker"),
    };
    await faucet(parties.buyer.address, buyerAda);
    await faucet(parties.cranker.address, 200);
    await sleep(3000);
    return new TreeLab(
      await connectCascade(parties.buyer),
      await connectCascade(parties.cranker),
      parties,
      "yaci",
      localDeployment().endpoints.ogmiosHttp,
    );
  }

  get all(): Party[] {
    return Object.values(this.parties);
  }

  now(): bigint {
    return chainTimeMs(this.client.lucid);
  }

  plan(tag: string, rootMaxBudget: bigint, children: LeafSpec[]): Plan {
    const rootLeaf: PlanLeaf = {
      spec_hash: h32(`${tag}/root`),
      parent_spec_hash: ZERO_HASH,
      kind: "Native",
      max_budget: rootMaxBudget,
      max_fee: rootMaxBudget,
      payee_hash: ZERO_PAYEE_HASH,
      acceptance_hash: acceptanceHash({ type: "BuyerAccept", key: this.parties.buyer.vkh }),
    };
    const leaves: PlanLeaf[] = [rootLeaf];
    for (const c of children) {
      const parent = leaves[c.parent];
      if (parent === undefined) throw new Error(`leaf ${c.tag}: parent ${c.parent} is not defined before it`);
      leaves.push({
        spec_hash: h32(`${tag}/${c.tag}`),
        parent_spec_hash: parent.spec_hash,
        kind: c.kind ?? "Native",
        max_budget: c.maxBudget,
        max_fee: c.maxFee,
        payee_hash: c.payeeHash ?? ZERO_PAYEE_HASH,
        acceptance_hash: acceptanceHash(c.acceptance ?? { type: "ParentAccept", key: this.parties.operator.vkh }),
      });
    }
    return { leaves, root: merkleRoot(leaves) };
  }

  leaf(plan: Plan, index: number): { leaf: PlanLeaf; proof: ReturnType<typeof merkleProof> } {
    const leaf = plan.leaves[index];
    if (leaf === undefined) throw new Error(`plan has no leaf ${index}`);
    return { leaf, proof: merkleProof(plan.leaves, index) };
  }

  config(plan: Plan, overrides: Partial<TreeConfig> = {}): Omit<TreeConfig, "tree_id"> {
    const { buyer, arbiterA, arbiterB } = this.parties;
    return {
      buyer: buyer.vkh,
      buyer_refund: buyer.plutus,
      asset: LOVELACE,
      arbiters: [arbiterA.vkh, arbiterB.vkh],
      arbiter_threshold: 2n,
      arbiter_fee_address: arbiterA.plutus,
      max_depth: 3n,
      max_fanout: 4n,
      max_child_share_bps: 10_000n,
      min_challenge_window: 20_000n,
      min_safety_margin: 5_000n,
      // Children get 20 s between challenge_until and dispute_until; the root gets 30 s.
      min_dispute_window: 20_000n,
      allowed_leaf_kinds: ["Native", "AddressPayment"],
      masumi_script_hash: "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
      channel_script_hash: this.client.scripts.channelHash,
      plan_root: plan.root,
      protocol_fee_bps: 0n,
      protocol_fee_address: buyer.plutus,
      challenge_bond: 5n * ADA,
      slash_wronged_bps: 7_000n,
      ...overrides,
    };
  }

  /** Funds a root operated by `operator` whose submit window ends `windowMs` from now. */
  async fund(
    plan: Plan,
    budget: bigint,
    fee: bigint,
    windowMs: bigint,
    structural: bigint,
    config: Partial<TreeConfig> = {},
  ): Promise<{ treeId: string; txHash: string }> {
    const submitBy = this.now() + windowMs;
    const built = await this.client.fundRoot({
      config: this.config(plan, config),
      root: {
        operator: this.parties.operator.vkh,
        payee: this.parties.operator.plutus,
        budget,
        fee,
        structural,
        spec_hash: plan.leaves[0]!.spec_hash,
        input_hash: h32("root-input"),
        submit_by: submitBy,
        challenge_until: submitBy + 30_000n,
        refund_after: submitBy,
        dispute_until: submitBy + 60_000n,
      },
    });
    const txHash = await this.submit(built);
    return { treeId: built.treeId, txHash };
  }

  /** A native child that fits inside `parentSubmitBy` with the config's margins. */
  nativeChild(
    plan: Plan,
    leafIndex: number,
    worker: Party,
    budget: bigint,
    fee: bigint,
    parentSubmitBy: bigint,
    acceptance: Acceptance,
    submitInMs = 60_000n,
  ): NativeChild {
    const submitBy = this.now() + submitInMs;
    const disputeUntil = submitBy + 40_000n;
    if (disputeUntil + 5_000n > parentSubmitBy) throw new Error("child window does not fit inside the parent's submit_by");
    return {
      kind: "native",
      ...this.leaf(plan, leafIndex),
      operator: worker.vkh,
      payee: worker.plutus,
      budget,
      fee,
      input_hash: h32(`input/${leafIndex}`),
      acceptance,
      submit_by: submitBy,
      challenge_until: submitBy + 20_000n,
      refund_after: submitBy,
      dispute_until: disputeUntil,
    };
  }

  /** Signs with the fee payer (buyer) and every party whose key the tx requires. */
  async submit(built: BuiltTx): Promise<string> {
    const keys = this.all.filter((p) => built.signers.includes(p.vkh) && p !== this.parties.buyer);
    return submitBuilt(this.client, built, keys);
  }

  /** Waits until the provider shows node `nodeId` at an output of `txHash` (indexers lag the node). */
  async awaitNodeAt(nodeId: string, txHash: string, timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if ((await this.client.node(nodeId)).utxo.txHash === txHash) return;
      } catch {
        // Not indexed yet.
      }
      if (Date.now() > deadline) throw new Error(`node ${nodeId} not seen at ${txHash} within ${timeoutMs} ms`);
      await sleep(3000);
    }
  }

  /** Waits until node `nodeId` is gone from the provider's view (token burned). */
  async awaitNodeGone(nodeId: string, timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.client.node(nodeId);
      } catch {
        return;
      }
      if (Date.now() > deadline) throw new Error(`node ${nodeId} still visible after ${timeoutMs} ms`);
      await sleep(3000);
    }
  }

  /** Same as `submit` for a tx built by `crankerClient`: the cranker pays, the buyer only signs. */
  async submitByCranker(built: BuiltTx): Promise<string> {
    const keys = this.all.filter((p) => built.signers.includes(p.vkh) && p !== this.parties.cranker);
    return submitBuilt(this.crankerClient, built, keys);
  }
}
