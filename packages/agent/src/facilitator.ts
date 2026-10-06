/**
 * `PaymentVerifier` backed by a facilitator's HTTP API (`POST /verify`, `POST /settle`, x402 v2),
 * such as the Cascade facilitator (services/facilitator).
 */
import type { PaymentPayload, PaymentRequirements, PaymentVerifier, SettleResponse, VerifyResult } from "./payment.js";

export class HttpFacilitatorVerifier implements PaymentVerifier {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(path: string, payload: PaymentPayload, requirements: PaymentRequirements): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status >= 500) throw new Error(`facilitator ${path} answered ${res.status}`);
    return body;
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult> {
    const b = await this.post("/verify", payload, requirements);
    const reason = typeof b["invalidReason"] === "string" ? b["invalidReason"] : undefined;
    const payer = typeof b["payer"] === "string" ? b["payer"] : undefined;
    return { isValid: b["isValid"] === true, ...(reason === undefined ? {} : { invalidReason: reason }), ...(payer === undefined ? {} : { payer }) };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const b = await this.post("/settle", payload, requirements);
    return {
      success: b["success"] === true,
      network: typeof b["network"] === "string" ? b["network"] : requirements.network,
      transaction: typeof b["transaction"] === "string" ? b["transaction"] : "",
      ...(typeof b["errorReason"] === "string" ? { errorReason: b["errorReason"] } : {}),
      ...(typeof b["extra"] === "object" && b["extra"] !== null ? { extra: b["extra"] as SettleResponse["extra"] & object } : {}),
    };
  }
}
