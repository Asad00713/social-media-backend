import { config } from 'dotenv';
config({ path: '.env' });

import { db } from '../db';
import { plans, addonPricing } from '../schema';

export async function seedPlans() {
  console.log('Seeding plans...');

  // Insert plans
  await db.insert(plans).values([
    {
      code: 'FREE',
      name: 'Free Plan',
      basePriceCents: 0,
      stripePriceId: null, // No Stripe price for free plan
      channelsPerWorkspace: 3,
      membersPerWorkspace: 1,
      maxWorkspaces: 1,
      features: {
        basicScheduling: true,
        analytics: false,
        advancedScheduling: false,
        apiAccess: false,
        prioritySupport: false,
        whiteLabel: false,
      },
      isActive: true,
    },
    {
      code: 'PRO',
      name: 'Pro Plan',
      basePriceCents: 1000, // $10.00
      stripePriceId: null, // Will be set after creating in Stripe
      channelsPerWorkspace: 8,
      membersPerWorkspace: 5,
      maxWorkspaces: 3,
      features: {
        basicScheduling: true,
        analytics: true,
        advancedScheduling: true,
        apiAccess: true,
        prioritySupport: false,
        whiteLabel: false,
      },
      isActive: true,
    },
    {
      code: 'MAX',
      name: 'Max Plan',
      basePriceCents: 5000, // $50.00
      stripePriceId: null, // Will be set after creating in Stripe
      channelsPerWorkspace: 50,
      membersPerWorkspace: 25,
      maxWorkspaces: 10,
      features: {
        basicScheduling: true,
        analytics: true,
        advancedScheduling: true,
        apiAccess: true,
        prioritySupport: true,
        whiteLabel: true,
      },
      isActive: true,
    },
  ]).onConflictDoNothing();

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
