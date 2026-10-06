# Market brief: Launching a cold-pressed juice brand in Dubai

> **Request:** We are thinking about launching a cold-pressed juice brand in Dubai. What does the market look like and what should we charge?

## Executive summary

Dubai has room for a mid-premium cold-pressed brand. Price at 24 to 26 AED per 300 ml, sell through gyms first, and register products with Dubai Municipality before launch. Competitor prices here are sample data; confirm them in store.

## Key findings

1. The UAE functional beverage market is forecast to grow about 7% a year to 2029. ([mordorintelligence.com](https://www.mordorintelligence.com/industry-reports/uae-functional-beverage-market))
2. Dubai food establishments must register products with Dubai Municipality before sale. ([dm.gov.ae](https://www.dm.gov.ae/business/food-safety/))
3. Delivery apps carry a large share of premium juice orders in Dubai. (estimate)

## Brief

### Market-entry brief: cold-pressed juice in Dubai
#### Recommendation
Launch at 24 to 26 AED per 300 ml bottle, between Super Juice and Pressed Juicery, through gyms first and delivery apps second.
#### Competitors
- Pressed Juicery Dubai: premium, malls and delivery
- Super Juice: mid-price, gyms and cafes
- Detox Delight: cleanse programmes
#### Risks
- Product registration with Dubai Municipality takes weeks (https://www.dm.gov.ae/business/food-safety/).
- Prices in this brief come from sample lookup data and need a store check.

## Price table

Cheapest is Super Juice Green Machine at 22 AED for 300 ml; the most expensive is Detox Delight Day cleanse (6 bottles) at 185 AED for 1500 ml; the median of 3 priced products is 29.5 AED.

| Brand | Product | Size (ml) | Avg price (AED) | Days observed |
| --- | --- | --- | --- | --- |
| Pressed Juicery Dubai | Greens 1 | 350 | 29.5 | 42 |
| Super Juice | Green Machine | 300 | 22 | 42 |
| Detox Delight | Day cleanse (6 bottles) | 1500 | 185 | 42 |

_Rows come from the demo Lookup API and are sample prices, not live retail data._

## Translation

لدى دبي مجال لعلامة عصير معصور على البارد في الفئة المتوسطة إلى الممتازة.

_Translate ar did not deliver; its backup did. That slot's budget was refunded on chain._

---

## How this was made

8 paid agents on one Cascade escrow tree (Cardano preprod); 3 independent checks, 2 accepted. Each agent was paid from escrow only after its work was accepted; anything unspent went back to the buyer.

| Agent | Did | Paid | Checks | Status |
| --- | --- | --- | --- | --- |
| Conductor | Planned the job, hired and paid the team | 8 ADA |  | [Accepted](https://preprod.cardanoscan.io/transaction/f585ae3b601d63c8f9c52ceb0303eccc636b59b12103eb307d11a2786f977680) |
| Scout | Researched competitors and sourced findings | 10 ADA | 2/3 accept | [Settled](https://preprod.cardanoscan.io/transaction/a7c94c2865bdf94795f8eeb38c6b03d437cf545fdef2701a3d9a2453e586e2e8) |
| Pricer | Collected competitor prices, paid per lookup | 3 ADA |  | [Settled](https://preprod.cardanoscan.io/transaction/deaa9a08079695ab14bba0c00f10a143628a6dd662d74d0bd6b0807df089a7fd) |
| Cascade Checker A | Checked Scout | 1 ADA | accept (0.92) | [Settled](https://preprod.cardanoscan.io/transaction/0397c3ecc64bb5962973c3b96e3bfc32ba6831b48824f4ab5ed048d42a0c014b) |
| Cascade Checker B | Checked Scout | 1 ADA | accept (0.88) | [Settled](https://preprod.cardanoscan.io/transaction/1e33487b218f3f397b02798eb97d0863118dc0d18c62236c1d3a94a60dd546c4) |
| Cascade Checker C | Checked Scout | 1 ADA | reject (0.41) | [Settled](https://preprod.cardanoscan.io/transaction/d5f9861650a70aec52fa6b09ac9243c3e84d9b70c3ba79e5da9f1f9b02d38f49) |
| Scribe | Wrote the brief and executive summary | 5 ADA |  | [Settled](https://preprod.cardanoscan.io/transaction/0185454d6077d0acef63f00dd5484887ee3e8b1e74bb70a4a94e3e5c743dfeb0) |
| Flaky Lisan (test agent) | Test agent: fails on purpose to demonstrate refunds | 0 ADA |  | [Refunded](https://preprod.cardanoscan.io/transaction/924f0f969bfa70c001fe7b968bdd44df8dfa186c3b2b3aad6a16187b355650bd) |
| Masumi agent | Translated the summary (backup) | Masumi escrow |  | [Delivered](https://preprod.cardanoscan.io/transaction/3c9b8a6d6b8b192547d97748a3dfb36aeba0563202b6484b79513461dbeae0fc) |

**Money.** 80 ADA locked · 30 ADA paid to agents · 46 ADA refunded · ledger balanced.

**Links.** [Live tree](https://cascade-alpha-amber.vercel.app/tree/e84e8433c9d7aa95152506fbdac813d88451dc5d2b6d924d4cbf6b56) · [Receipt](https://cascade-alpha-amber.vercel.app/receipt/e84e8433c9d7aa95152506fbdac813d88451dc5d2b6d924d4cbf6b56)
- Funding: [2f2d29ee…a69cfb](https://preprod.cardanoscan.io/transaction/2f2d29ee951da378ff99ac768dc8682f4bd96f27f565659a6ffd74ef43a69cfb)
- Payouts: [a7c94c28…86e2e8](https://preprod.cardanoscan.io/transaction/a7c94c2865bdf94795f8eeb38c6b03d437cf545fdef2701a3d9a2453e586e2e8), [deaa9a08…89a7fd](https://preprod.cardanoscan.io/transaction/deaa9a08079695ab14bba0c00f10a143628a6dd662d74d0bd6b0807df089a7fd), [0397c3ec…0c014b](https://preprod.cardanoscan.io/transaction/0397c3ecc64bb5962973c3b96e3bfc32ba6831b48824f4ab5ed048d42a0c014b), [1e33487b…d546c4](https://preprod.cardanoscan.io/transaction/1e33487b218f3f397b02798eb97d0863118dc0d18c62236c1d3a94a60dd546c4), [d5f98616…d38f49](https://preprod.cardanoscan.io/transaction/d5f9861650a70aec52fa6b09ac9243c3e84d9b70c3ba79e5da9f1f9b02d38f49), [0185454d…3dfeb0](https://preprod.cardanoscan.io/transaction/0185454d6077d0acef63f00dd5484887ee3e8b1e74bb70a4a94e3e5c743dfeb0), [f585ae3b…977680](https://preprod.cardanoscan.io/transaction/f585ae3b601d63c8f9c52ceb0303eccc636b59b12103eb307d11a2786f977680)
- Refunds: [924f0f96…5650bd](https://preprod.cardanoscan.io/transaction/924f0f969bfa70c001fe7b968bdd44df8dfa186c3b2b3aad6a16187b355650bd), [c2378ebd…f8e0da](https://preprod.cardanoscan.io/transaction/c2378ebdb2f1218ac54e25a16ab24997dfcdf13a1bab335a81a428ff13f8e0da)
- Root accepted: [f585ae3b…977680](https://preprod.cardanoscan.io/transaction/f585ae3b601d63c8f9c52ceb0303eccc636b59b12103eb307d11a2786f977680)
- This Task's Masumi escrow: payment acc7b152…3610c3, funded in [cca93fef…316a6e](https://preprod.cardanoscan.io/transaction/cca93fef9e470ac2521b1cb929ceaf8bd7a8d802e373fe0bcd350d25cd316a6e); released to the seller after the unlock time.
- Result hash on chain: `2c99416941a2c2ab5aba18b7b38442133f9d4222c745a19a7866f8d637d4e7e7`