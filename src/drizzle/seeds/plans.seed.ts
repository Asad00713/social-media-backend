import { config } from 'dotenv';
config({ path: '.env' });

import { db } from '../db';
import { plans, addonPricing } from '../schema';
import { sql } from 'drizzle-orm';

export async function seedPlans() {
  console.log('Seeding plans...');

  // Insert or update plans (upsert)
  // Note: stripePriceId is NOT updated to preserve existing Stripe integrations
  const planData = [
    {
      code: 'FREE',
      name: 'Free Plan',
      basePriceCents: 0,
      channelsPerWorkspace: 3,
      membersPerWorkspace: 1,
      maxWorkspaces: 1,
      aiTokensPerMonth: 0, // No AI for free plan
      features: {
        basicScheduling: true,
        analytics: false,
        advancedScheduling: false,
        apiAccess: false,
        prioritySupport: false,
        whiteLabel: false,
        aiFeatures: false,
      },
      isActive: true,
    },
    {
      code: 'PRO',
      name: 'Pro Plan',
      basePriceCents: 1000, // $10.00
      channelsPerWorkspace: 8,
      membersPerWorkspace: 5,
      maxWorkspaces: 3,
      aiTokensPerMonth: 2000, // 2000 AI tokens per month
      features: {
        basicScheduling: true,
        analytics: true,
        advancedScheduling: true,
        apiAccess: true,
        prioritySupport: false,
        whiteLabel: false,
        aiFeatures: true,
      },
      isActive: true,
    },
    {
      code: 'MAX',
      name: 'Max Plan',
      basePriceCents: 5000, // $50.00
      channelsPerWorkspace: 50,
      membersPerWorkspace: 25,
      maxWorkspaces: 10,
      aiTokensPerMonth: 5000, // 5000 AI tokens per month
      features: {
        basicScheduling: true,
        analytics: true,
        advancedScheduling: true,
        apiAccess: true,
        prioritySupport: true,
        whiteLabel: true,
        aiFeatures: true,
      },
      isActive: true,
    },
  ];

  await db
    .insert(plans)
    .values(planData)
    .onConflictDoUpdate({
      target: plans.code,
      set: {
        name: sql`excluded.name`,
        basePriceCents: sql`excluded.base_price_cents`,
        channelsPerWorkspace: sql`excluded.channels_per_workspace`,
        membersPerWorkspace: sql`excluded.members_per_workspace`,
        maxWorkspaces: sql`excluded.max_workspaces`,
        aiTokensPerMonth: sql`excluded.ai_tokens_per_month`,
        features: sql`excluded.features`,
        isActive: sql`excluded.is_active`,
        updatedAt: new Date(),
        // NOTE: stripePriceId is NOT included to preserve existing Stripe prices
      },
    });

  console.log('Plans seeded successfully!');
}

export async function seedAddonPricing() {
  console.log('Seeding addon pricing...');

  // Insert addon pricing for PRO plan
  await db.insert(addonPricing).values([
    // PRO Plan Add-ons
    {
      planCode: 'PRO',
      addonType: 'EXTRA_CHANNEL',
      pricePerUnitCents: 500, // $5.00
      stripePriceId: '', // Will be set after creating in Stripe
      minQuantity: 1,
      maxQuantity: null,
      isActive: true,
    },
    {
      planCode: 'PRO',
      addonType: 'EXTRA_MEMBER',
      pricePerUnitCents: 300, // $3.00
      stripePriceId: '', // Will be set after creating in Stripe
      minQuantity: 1,
      maxQuantity: null,
      isActive: true,
    },
    {
      planCode: 'PRO',
      addonType: 'EXTRA_WORKSPACE',
      pricePerUnitCents: 800, // $8.00
      stripePriceId: '', // Will be set after creating in Stripe
      minQuantity: 1,
      maxQuantity: null,
      isActive: true,
    },
    {
      planCode: 'PRO',
      addonType: 'AI_TOKENS', // 500 extra AI tokens pack
      pricePerUnitCents: 500, // $5.00 per 500 tokens
      stripePriceId: '', // Will be set after creating in Stripe
      minQuantity: 1,
      maxQuantity: null, // Unlimited purchases allowed
      isActive: true,
    },
    // MAX Plan Add-ons
    {
      planCode: 'MAX',
      addonType: 'EXTRA_CHANNEL',
      pricePerUnitCents: 300, // $3.00
      stripePriceId: '', // Will be set after creating in Stripe
      minQuantity: 1,
      maxQuantity: null,
      isActive: true,
    },
    {
      planCode: 'MAX',
      addonType: 'EXTRA_MEMBER',
      pricePerUnitCents: 200, // $2.00
      stripePriceId: '', // Will be set after creating in Stripe
      minQuantity: 1,
      maxQuantity: null,
      isActive: true,
    },
    {
      planCode: 'MAX',
      addonType: 'EXTRA_WORKSPACE',
      pricePerUnitCents: 500, // $5.00
      stripePriceId: '', // Will be set after creating in Stripe
      minQuantity: 1,
      maxQuantity: null,
      isActive: true,
    },
    {
      planCode: 'MAX',
      addonType: 'AI_TOKENS', // 500 extra AI tokens pack (discounted for MAX)
      pricePerUnitCents: 400, // $4.00 per 500 tokens (discounted)
      stripePriceId: '', // Will be set after creating in Stripe
      minQuantity: 1,
      maxQuantity: null, // Unlimited purchases allowed
      isActive: true,
    },
  ]).onConflictDoNothing();

  console.log('Addon pricing seeded successfully!');
}

// Main seed function
export async function seedBillingData() {
  try {
    await seedPlans();
    await seedAddonPricing();
    console.log('All billing data seeded successfully!');
  } catch (error) {
    console.error('Error seeding billing data:', error);
    throw error;
  }
}

// Run if executed directly
if (require.main === module) {
  seedBillingData()
    .then(() => {
      console.log('Seed completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Seed failed:', error);
      process.exit(1);
    });
}
