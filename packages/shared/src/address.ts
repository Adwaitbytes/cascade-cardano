import { bech32 } from "@scure/base";
import { bytesToHex, concatBytes, hexToBytes } from "./bytes.js";
import type { Credential, PlutusAddress } from "./types.js";

/** Cardano network id in the address header: 0 for every testnet (preprod, preview, Yaci), 1 for mainnet. */
export type NetworkId = 0 | 1;

const BECH32_LIMIT = 1023;

/**
 * Shelley address header types (CIP-19) supported for Plutus conversion.
 * Pointer (4, 5), Byron (8) and reward (14, 15) addresses are rejected: they cannot appear in a Cascade datum.
 */
const HEADER = {
  baseKeyKey: 0,
  baseScriptKey: 1,
  baseKeyScript: 2,
  baseScriptScript: 3,
  enterpriseKey: 6,
  enterpriseScript: 7,
} as const;

export function addressBytesFromBech32(address: string): Uint8Array {
  const { prefix, words } = bech32.decode(address as `${string}1${string}`, BECH32_LIMIT);
  if (prefix !== "addr" && prefix !== "addr_test") throw new Error(`not a payment address prefix: ${prefix}`);
  const bytes = bech32.fromWords(words);
  const networkId = (bytes[0] ?? 0) & 0x0f;
  if ((prefix === "addr") !== (networkId === 1)) throw new Error(`address prefix ${prefix} does not match network id ${networkId}`);
  return bytes;
}

export function addressBytesToBech32(bytes: Uint8Array): string {
  const networkId = (bytes[0] ?? 0) & 0x0f;
  const prefix = networkId === 1 ? "addr" : "addr_test";
  return bech32.encode(prefix, bech32.toWords(bytes), BECH32_LIMIT);
}

function credential(isScript: boolean, hash: Uint8Array): Credential {
  return { type: isScript ? "Script" : "VerificationKey", hash: bytesToHex(hash) };
}

/** Parse raw Shelley address bytes (base or enterprise) into the Plutus `Address` shape. */
export function plutusAddressFromBytes(bytes: Uint8Array): { network_id: NetworkId; address: PlutusAddress } {
  const header = bytes[0];
  if (header === undefined) throw new Error("empty address");
  const type = header >> 4;
  const networkId = header & 0x0f;
  if (networkId !== 0 && networkId !== 1) throw new Error(`unsupported network id ${networkId}`);
  const payment = bytes.subarray(1, 29);
  switch (type) {
    case HEADER.baseKeyKey:
    case HEADER.baseScriptKey:
    case HEADER.baseKeyScript:
    case HEADER.baseScriptScript: {
      if (bytes.length !== 57) throw new Error(`base address must be 57 bytes, got ${bytes.length}`);
      return {
        network_id: networkId,
        address: {
          payment_credential: credential((type & 1) === 1, payment),
          stake_credential: { type: "Inline", credential: credential((type & 2) === 2, bytes.subarray(29, 57)) },
        },
      };
    }
    case HEADER.enterpriseKey:
    case HEADER.enterpriseScript: {
      if (bytes.length !== 29) throw new Error(`enterprise address must be 29 bytes, got ${bytes.length}`);
      return {
        network_id: networkId,
        address: { payment_credential: credential(type === HEADER.enterpriseScript, payment), stake_credential: null },
      };
    }
    default:
      throw new Error(`unsupported address type ${type}: only base and enterprise addresses are allowed`);
  }
}

export function plutusAddressFromBech32(address: string): PlutusAddress {
  return plutusAddressFromBytes(addressBytesFromBech32(address)).address;
}

export function plutusAddressToBytes(address: PlutusAddress, networkId: NetworkId): Uint8Array {
  const pay = address.payment_credential;
  const payScript = pay.type === "Script" ? 1 : 0;
  const stake = address.stake_credential;
  if (stake === null) {
    return concatBytes(Uint8Array.of(((6 | payScript) << 4) | networkId), hexToBytes(pay.hash));
  }
  if (stake.type !== "Inline") throw new Error("pointer stake credentials cannot be encoded as a bech32 address");
  const stakeScript = stake.credential.type === "Script" ? 2 : 0;
  return concatBytes(
    Uint8Array.of(((payScript | stakeScript) << 4) | networkId),
    hexToBytes(pay.hash),
    hexToBytes(stake.credential.hash),
  );
}

export function plutusAddressToBech32(address: PlutusAddress, networkId: NetworkId): string {
  return addressBytesToBech32(plutusAddressToBytes(address, networkId));
}

/** Payment key hash of a key-credential address, or throws for a script payment credential. */
export function paymentKeyHash(address: string | PlutusAddress): string {
  const parsed = typeof address === "string" ? plutusAddressFromBech32(address) : address;
  if (parsed.payment_credential.type !== "VerificationKey") throw new Error("address has a script payment credential");
  return parsed.payment_credential.hash;
}
