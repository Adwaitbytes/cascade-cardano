/**
 * On-chain proof shown on the landing page. Every transaction id is a preprod transaction from the
 * README's redeemer table and docs/sokosumi-coworker.md, which read each one back from Blockfrost
 * before recording it. Nothing here is a sample: if a row is wrong, those documents are wrong.
 */

export const REPO_URL = "https://github.com/Adwaitbytes/cascade-cardano";

export interface ActionProof {
  redeemer: string;
  tx: string;
  proves: string;
}

/** The 17 contract actions run on the current deployment by demo/redeemers.ts (README, "Every redeemer on preprod"). */
export const CONTRACT_ACTIONS: readonly ActionProof[] = [
  { redeemer: "FundRoot", tx: "a4d28ac98a371dd43eadf8cef3ca2c6f417dd07bc05e90a2ce48d5c402708cdf", proves: "Buyer locks 20 ADA and the plan root in one root escrow." },
  { redeemer: "TopUp", tx: "ee128e5a67ea46d4f64e13a256b7d112bba069723eb4d1978b69d9d750f8c54a", proves: "Buyer adds 1 ADA to the root budget." },
  { redeemer: "Freeze", tx: "a5cb0366affa6e4bd45d41b1f6eec9f5a6b925d07da98af065b8786d47b5370a", proves: "Buyer freezes the root; no hire can draw from it." },
  { redeemer: "Unfreeze", tx: "d96f602ad290cdb85cc3435d555adbc35419f6d150af397533a04a2a582e0e40", proves: "Buyer unfreezes the root; hires resume." },
  { redeemer: "Draw (native)", tx: "21514966fb1f80d33ee8037c6f74b33e9a3add9ff9ccf5d9744ebba9ed28eec9", proves: "Conductor hires three agents, each checked against the plan root." },
  { redeemer: "Draw (receipt)", tx: "fb9bab1e94b957010bf332c4ade622d16add47911e5e7ac4be96e0f2a70918ae", proves: "A metered voucher channel and a Masumi escrow lock in one transaction." },
  { redeemer: "Submit", tx: "ae62495eb1dde7be1ef1ff444efe1e25cd69638f2831984e5bf86496d36decfd", proves: "Scout commits its result hash before its deadline." },
  { redeemer: "Accept", tx: "e3d8013ea393b1487aaebd72aa2204ddf26ff56bd39ffcb94014e03ce6a8eb47", proves: "The parent's signature accepts Scout's result." },
  { redeemer: "SettleChild", tx: "da37ee899e391eb1d515bc187f04b7a6ae2c177d094c13ca4a51fe3ea95aae4f", proves: "Scout is paid 1 ADA; the unused 2 ADA folds back into the root." },
  { redeemer: "Challenge", tx: "d784c83542101a7ce7947fd82ff5389f65822dce11abdf918e8b03dda53bc480", proves: "The parent challenges Pricer's result and posts a 4 ADA bond." },
  { redeemer: "Escalate", tx: "3a45f8f2af4c0ca6a4e1adfec716a487a403f24ae1374bda8023807dbd1746bb", proves: "Pricer escalates the challenge to the arbiters." },
  { redeemer: "Resolve", tx: "baf314d8b9d6f363ca021bef105fab3d2008cf0febb4837fc001c02adbc742f2", proves: "Two of three arbiters split Pricer's fee and slash the bond." },
  { redeemer: "Refund", tx: "fb8280c71a523c5d423af87edc355f191feea126ba1e1722d514e66a279d6472", proves: "A test agent misses its deadline; its whole value returns to the root." },
  { redeemer: "CloseReceipt (metered)", tx: "1db9f31149273c8096ef33708e50deadd3a5757bde58fe3916ad5685deebec48", proves: "The unused 3 ADA voucher deposit returns to the root." },
  { redeemer: "CloseReceipt (Masumi)", tx: "2f419757cafdfaa2e6da23968d2bc55dcc0c9428db2fe16c9098df744e270182", proves: "The refunded Masumi receipt closes and its token burns." },
  { redeemer: "CloseRoot", tx: "69720f3162300f9b04febd20723a5f3d51135504c3b5d62f404fcc1b9dbc9df0", proves: "Conductor gets its 1 ADA fee; everything unused returns to the buyer." },
  { redeemer: "Cancel", tx: "232d2d8f8cf11e57d67f084bc5aa45d5403172c3d999f25bc57140272986d414", proves: "Buyer cancels a tree with nothing drawn and gets a full refund." },
];

/** The tree those actions ran on, on today's script hashes. */
export const ACTIONS_TREE_ID = "ade682cb5f8e007cb68584a35f8696b78f36d4c32b29fdda7cfad206";

export interface PaidTask {
  task: string;
  date: string;
  brief: string;
  lock: string;
  resultHash: string;
  collection: string;
  treeFunding: string;
}

/** Cascade's Coworker on Sokosumi preprod (docs/sokosumi-coworker.md). */
export const COWORKER = {
  id: "01a110cd-4ee0-763b-ae63-4008564c9f8e",
  registrationTx: "27f2aa49f9245d826b1837745d2a54d247f857ced77a7a2ef36856da7b8906a3",
  command: `sokosumi --preprod tasks create --personal --coworker-id 01a110cd-4ee0-763b-ae63-4008564c9f8e --name "Brief" --description "Market-entry brief for cold-pressed juice in Dubai with a competitor price table." --status READY --json`,
  tasks: [
    {
      task: "01a11176-0b37-75cb-a4d9-d568b3fd9cdb",
      date: "7 Oct 2026",
      brief: "Market-entry brief for a cold-pressed juice brand in Dubai. Full deliverable, paid out.",
      lock: "a7a8afe4a4092d4d048616feb97865c9f11f6864bf82c3acabd01b4e18787950",
      resultHash: "ac5706a15d9cad115f62488668949822302797385d4b7c51c426fe7a9e2af952",
      collection: "f37ffe31f43bbbbb5c5f2c3834c62cf791c7bd218fe2e7ee9855be55830f769e",
      treeFunding: "49d52a7576be879c3f0aca14ad572265b0431ba94b402c3c6adf18639329307e",
    },
    {
      task: "01a110e2-b1ca-752c-bc65-123cd12ae594",
      date: "6 Oct 2026",
      brief: "First paid Task. Proves the Sokosumi, Masumi escrow and seller payout path; the result was partial.",
      lock: "caafb951464f87f3f2f2f972875657f6723c870e81a7152bd8ca61116472c589",
      resultHash: "a9cefb55e6a6b035ef6cbee15332691b09741204d2e86cc1beec7e85aa578d1c",
      collection: "0e584a87be1ce0315a42a39a7c1c18b100f7c75074ede6825f8c351bb3dc93c4",
      treeFunding: "ffe6216e97f7fd70027a545ad4e0d0e2af17a351edd9b03e19c22ab4cf7d71ed",
    },
  ] satisfies PaidTask[],
} as const;
