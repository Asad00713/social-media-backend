# Paddle SANDBOX catalogue — Schedura
Created 2026-11-24 on sandbox-vendors.paddle.com.

⚠ SANDBOX ONLY. These ids do NOT exist on the live account — the live
catalogue has to be rebuilt and will have different ids.

All prices: Recurring, Monthly, USD, tax category "Standard digital goods",
sales tax "Account default". No trials. BASE_PLAN prices are capped at
max quantity 1; add-ons keep the default max so quantity can scale.

Every price carries custom data `item_type`, every product `plan_code`, and the
AI packs also carry `units_per_quantity=5000` — so a Paddle webhook identifies
itself without the adapter keeping a hard-coded id map.

## Products
| plan_code | product id |
|---|---|
| BASIC | pro_01m86y25arst191ysep6papd7h |
| PRO   | pro_01m86yadz05zwyhgjz1n5y7bgp |
| MAX   | pro_01m86ye5byp1edvq5f5csz3srg |

FREE has no Paddle product: the app never sends a free plan to checkout.

## Prices — for provider_prices (provider='paddle')
| plan_code | item_type | price | provider_ref |
|---|---|---|---|
| BASIC | BASE_PLAN        | $12.00 | pri_01m86y44err565asst14n0wtcr |
| BASIC | EXTRA_CHANNEL    | $5.00  | pri_01m86y5zdkb6e0hs1g3rxrat1f |
| BASIC | EXTRA_MEMBER     | $3.00  | pri_01m86y6f5f1vfqjcq3yjq86n8r |
| BASIC | EXTRA_WORKSPACE  | $8.00  | pri_01m86y6y1z3632r07s3asjatz5 |
| BASIC | EXTRA_AI_TOKENS  | $5.00  | pri_01m86y849xg1edx5bhnzjq7ykc |
| PRO   | BASE_PLAN        | $29.00 | pri_01m86yb7qbemvm5tm20h4e3zar |
| PRO   | EXTRA_CHANNEL    | $5.00  | pri_01m86ybk938kd5rehxq28r6xy6 |
| PRO   | EXTRA_MEMBER     | $3.00  | pri_01m86yc06c9e0p4favg9p4ab03 |
| PRO   | EXTRA_WORKSPACE  | $8.00  | pri_01m86ycb49m4c2mz1fq8c56jbr |
| PRO   | EXTRA_AI_TOKENS  | $5.00  | pri_01m86yd2n294g7xfceetfn4d4z |
| MAX   | BASE_PLAN        | $79.00 | pri_01m86yew2ffqa46tw5hbc5whjt |
| MAX   | EXTRA_CHANNEL    | $3.00  | pri_01m86yf7xbd1z8e6fhrrx7r3dk |
| MAX   | EXTRA_MEMBER     | $2.00  | pri_01m86yfjxwnx22c9f7yfbntpvj |
| MAX   | EXTRA_WORKSPACE  | $5.00  | pri_01m86yfy1qqftv880h9s9efgy9 |
| MAX   | EXTRA_AI_TOKENS  | $4.00  | pri_01m86ygk1pngvfzf5t6qgdgz9w |

## Deliberately NOT done
- **No annual prices.** The app has no annual support (no `interval` column,
  and the billing screen's toggle is disabled on purpose). Annual SKUs would
  be unusable today.
- **No webhook/notification destination.** There is no Paddle adapter yet, so
  nothing would receive it.
- **No tax, payout or business-verification settings** — owner decisions.

## Next
1. Write the Paddle adapter (12-method `PaymentProviderAdapter` + webhook
   service). ⚠ Put the API base URL in an env var: Paddle's sandbox and live
   hosts differ (`sandbox-api.paddle.com` vs `api.paddle.com`). The
   LemonSqueezy client hard-codes its BASE, which is the shape that let
   `PINTEREST_USE_SANDBOX=true` reach production once.
2. Insert these 15 rows into `provider_prices` on the LOCAL/dev database only.
3. Test checkout, plan change, add-on buy/change/remove, cancel, webhooks.
4. Only then rebuild the catalogue on the live account and capture new ids.
