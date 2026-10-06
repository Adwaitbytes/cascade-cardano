import type { Registration } from "../src/config.js";
import { TUSDM_PREPROD } from "../src/config.js";
import { sha256Hex, type SignedTerms } from "../src/payment.js";

export const registration: Registration = {
  registrationId: "reg",
  registrationState: "RegistrationConfirmed",
  agentIdentifier: `${"ab".repeat(28)}${"cd".repeat(20)}`,
  supportedPaymentSourceIndex: 0,
  paymentSourceId: "src",
  smartContractAddress: "addr_test1wcontract",
  policyId: "ab".repeat(28),
  sellingWalletId: "seller-wallet",
  sellerVkey: "ef".repeat(28),
  sellerAddress: "addr_test1qseller",
  apiBaseUrl: "https://example.org/cascade-coworker",
};
export const quote = { amount: "1000000", unit: TUSDM_PREPROD };
export const input = "Market-entry brief\nwith \"quotes\" and \\ backslash";

export const terms = (over: Partial<SignedTerms> = {}): SignedTerms => ({
  blockchainIdentifier: "signed-id",
  agentIdentifier: registration.agentIdentifier,
  inputHash: sha256Hex(input),
  payByTime: String(Date.now() + 600_000),
  submitResultTime: String(Date.now() + 6_000_000),
  unlockTime: String(Date.now() + 7_200_000),
  externalDisputeUnlockTime: String(Date.now() + 8_400_000),
  sellerReturnAddress: null,
  forceLayer: null,
  RequestedFunds: [{ ...quote }],
  PaymentSource: { network: "Preprod", paymentSourceType: "Web3CardanoV2", smartContractAddress: registration.smartContractAddress, policyId: registration.policyId },
  SmartContractWallet: { id: registration.sellingWalletId, walletVkey: registration.sellerVkey },
  ...over,
});
