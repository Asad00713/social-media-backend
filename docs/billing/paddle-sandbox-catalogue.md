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
- **No webhook/notification destination.** Was blocked on the adapter not
  existing; the adapter and webhook service now exist, so this is an owner
  action that is newly unblocked (see Next step 3).
- **No tax, payout or business-verification settings** — owner decisions.

## Next
1. ~~Write the Paddle adapter~~ — DONE. 12-method adapter, client, webhook
   service and signature verification all landed on `feat/paddle-adapter`.
   The API base URL is read from `PADDLE_API_BASE` with no default, so the
   sandbox/live host split cannot be hard-coded the way LemonSqueezy's BASE is.
2. ~~Insert these 15 rows into `provider_prices`~~ — DONE on the LOCAL dev
   database (2026-11-25), via `provider-prices.seed.ts`:

   ```
   npx ts-node src/drizzle/seeds/provider-prices.seed.ts paddle
   ```

   The seed takes a provider argument (default `lemonsqueezy`) and reads every
   id from the environment — the ids above are NOT committed to the seed,
   because a Paddle price id is not reusable across accounts and a committed
   sandbox id would point production at a price that does not exist there. The
   variable names are in `.env.example` under the Paddle block.

   Verified after seeding: 15 rows written, re-running adds none (upsert on
   `(provider, plan_code, item_type)`), LemonSqueezy's own 15 rows untouched,
   and `CatalogueService.resolveRef('paddle', …)` answers all 15 pairs while
   `FREE/BASE_PLAN` still throws "not provisioned".

   ⚠ The add-on rows are per PLAN, not shared. The same add-on costs different
   money per tier ($5 channel on BASIC/PRO, $3 on MAX), so each tier carries
   its own price id — fifteen distinct unique keys, not five.
3. Test checkout, plan change, add-on buy/change/remove, cancel, webhooks.
   Needs a sandbox webhook destination pointing at
   `POST /billing/webhooks/paddle`, which can be created now that the webhook
   service exists.
4. Only then rebuild the catalogue on the live account and capture new ids.
   ⚠ The live ids will all differ; re-run the seed with the live values in the
   environment rather than editing anything in the repo.
