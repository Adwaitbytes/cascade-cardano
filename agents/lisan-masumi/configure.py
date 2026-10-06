"""Writes template/.env for Lisan from the repo environment, then exits.

Only the variables the template reads are written, so its ``load_dotenv(override=True)`` finds this
file first and never climbs to the repo-root ``.env`` (which holds treasury keys). Values are never
printed. Refuses to run when OpenRouter usage has reached the Cascade spend cap (2.50 USD), because
the template's CrewAI calls bypass Cascade's own LLM spend guard.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import httpx
from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent
REPO_ENV = HERE.parents[1] / ".env"
SPEND_CAP_USD = 2.5


def main() -> int:
    env = {**{k: v for k, v in dotenv_values(REPO_ENV).items() if v is not None}, **os.environ}

    def need(name: str) -> str:
        value = (env.get(name) or "").strip()
        if not value:
            print(f"missing {name}", file=sys.stderr)
            raise SystemExit(2)
        return value

    openrouter_key = need("OPENROUTER_API_KEY")
    usage = httpx.get("https://openrouter.ai/api/v1/key", headers={"authorization": f"Bearer {openrouter_key}"}, timeout=15).json()["data"]["usage"]
    if usage >= SPEND_CAP_USD:
        print(f"OpenRouter usage {usage:.4f} USD reached the {SPEND_CAP_USD} USD cap; not starting Lisan", file=sys.stderr)
        return 3

    service = env.get("LISAN_PAYMENT_SERVICE_URL", "http://localhost:23101/api/v1").rstrip("/")
    api_key = env.get("LISAN_PAYMENT_API_KEY") or need("MASUMI_LISAN_ADMIN_KEY")
    # The selling wallet's vkey (payment key hash) is public; GET /wallet/list returns it.
    wallets = httpx.get(f"{service}/wallet/list", headers={"token": api_key}, timeout=20).json()["data"]["Wallets"]
    selling = [w for w in wallets if w.get("type") == "Selling"]
    if not selling:
        print("the Lisan payment service has no selling wallet", file=sys.stderr)
        return 4
    seller_vkey = selling[0]["walletVkey"]

    shim_port = env.get("LISAN_SHIM_PORT", "23111")
    values = {
        "PAYMENT_SERVICE_URL": f"http://127.0.0.1:{shim_port}/api/v1",
        "PAYMENT_API_KEY": api_key,
        "AGENT_IDENTIFIER": need("CASCADE_AGENT_ID_LISAN"),
        "SELLER_VKEY": seller_vkey,
        "NETWORK": "Preprod",
        "PAYMENT_AMOUNT": env.get("LISAN_PAYMENT_AMOUNT", "10000000"),
        "PAYMENT_UNIT": "lovelace",
        "MODEL": env.get("LISAN_MODEL", "openrouter/openai/gpt-4.1-nano"),
        "OPENROUTER_API_KEY": openrouter_key,
        "API_HOST": env.get("LISAN_API_HOST", "127.0.0.1"),
        "API_PORT": env.get("LISAN_API_PORT", "24009"),
        "CREWAI_DISABLE_TELEMETRY": "true",
        "OTEL_SDK_DISABLED": "true",
    }
    target = HERE / "template" / ".env"
    target.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    target.chmod(stat.S_IRUSR | stat.S_IWUSR)
    print(f"wrote template/.env ({len(values)} variables); shim port {shim_port}; OpenRouter usage {usage:.4f} USD")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
