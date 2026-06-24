import { config } from 'dotenv';
config({ path: '.env' });

import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { plans, addonPricing } from '../schema';
import {
  ensurePlanPrice,
  ensureAddonPrice,
} from '../../stripe/price-provisioning';

async function provision() {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error('STRIPE_SECRET_KEY is not defined');
  }

  const stripe = new Stripe(apiKey, { apiVersion: '2025-12-15.clover' });

  // Guard: echo which account/mode we are about to write into.
  const mode = apiKey.startsWith('sk_live') ? 'LIVE' : 'TEST';
  const account = await stripe.accounts.retrieve();
  console.log('==========================================');
  console.log(`Stripe provisioning — mode: ${mode}`);
  console.log(
    `Account: ${account.id} (${account.settings?.dashboard?.display_name ?? 'n/a'})`,
  );
  console.log('==========================================');

  // 1. Paid plans (FREE has basePriceCents = 0 → skipped, no Stripe price).
  const allPlans = await db.select().from(plans);
  for (const plan of allPlans) {
    if (plan.basePriceCents <= 0) {
      console.log(`- plan ${plan.code}: free, no Stripe price (skipped)`);
      continue;
    }
    const priceId = await ensurePlanPrice(stripe, {
      code: plan.code,
      name: plan.name,
      basePriceCents: plan.basePriceCents,
    });
    await db
      .update(plans)
      .set({ stripePriceId: priceId, updatedAt: new Date() })
      .where(eq(plans.code, plan.code));
    console.log(`- plan ${plan.code}: ${priceId}`);
  }

  // 2. Addons.
  const allAddons = await db.select().from(addonPricing);
  for (const addon of allAddons) {
    const priceId = await ensureAddonPrice(stripe, {
      planCode: addon.planCode,
      addonType: addon.addonType,
      pricePerUnitCents: addon.pricePerUnitCents,
    });
    await db
      .update(addonPricing)
      .set({ stripePriceId: priceId })
      .where(eq(addonPricing.id, addon.id));
    console.log(`- addon ${addon.planCode}/${addon.addonType}: ${priceId}`);
  }

  console.log('Stripe provisioning complete.');
}

if (require.main === module) {
  provision()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Stripe provisioning failed:', error);
      process.exit(1);
    });
}

export { provision };
