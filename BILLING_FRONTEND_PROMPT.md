# Frontend Billing Integration Prompt for Claude CLI

Copy and use this prompt in your Next.js frontend project with Claude CLI:

---

## PROMPT START

I need you to implement a complete billing and subscription system in my Next.js frontend. This integrates with an existing NestJS backend that uses Stripe for payments.

### Project Context
- **Framework**: Next.js (App Router)
- **Styling**: [YOUR_STYLING_CHOICE - e.g., Tailwind CSS, shadcn/ui]
- **State Management**: [YOUR_STATE_CHOICE - e.g., React Query, Zustand, Context]
- **Backend API Base URL**: [YOUR_API_URL]
- **Authentication**: JWT tokens (stored in cookies/localStorage)

### Backend API Endpoints Available

#### Plans & Pricing
```
GET /billing/plans
Response: {
  plans: [{
    id: number,
    code: "FREE" | "PRO" | "MAX",
    name: string,
    basePriceCents: number,
    channelsPerWorkspace: number,
    membersPerWorkspace: number,
    maxWorkspaces: number,
    features: object,
    isActive: boolean
  }]
}

GET /billing/workspaces/:workspaceId/plans
Response: {
  plans: [...],
  currentPlanCode: string,
  downgradableToPlans: string[],
  upgradeableTo: string[]
}
```

#### Subscription Management
```
POST /billing/workspaces/:workspaceId/subscription
Body: { planCode: string, paymentMethodId?: string, trialPeriodDays?: number }
Response: { subscriptionId, stripeSubscriptionId, clientSecret?, status }

GET /billing/workspaces/:workspaceId/subscription
Response: {
  id: number,
  workspaceId: string,
  planCode: string,
  status: "active" | "past_due" | "trialing" | "canceled",
  currentPeriodStart: string,
  currentPeriodEnd: string,
  cancelAtPeriodEnd: boolean,
  trialEnd: string | null,
  stripeSubscriptionId: string
}

DELETE /billing/workspaces/:workspaceId/subscription
Body: { cancelAtPeriodEnd?: boolean }
Response: { message, canceledAt?, cancelAtPeriodEnd }
```

#### Plan Changes
```
GET /billing/workspaces/:workspaceId/plan-change/preview?newPlanCode=MAX
Response: {
  currentPlan: { code, name, ... },
  newPlan: { code, name, ... },
  proration: { amount: number, description: string },
  newLimits: { channels: number, members: number },
  canChange: boolean,
  validationIssues: string[]
}

POST /billing/workspaces/:workspaceId/plan-change
Body: { newPlanCode: string }
Response: { subscription, message, newLimits }

POST /billing/workspaces/:workspaceId/downgrade-to-free
Response: { message, subscription }
```

#### Usage Tracking
```
GET /billing/workspaces/:workspaceId/usage
Response: {
  channelsCount: number,
  channelsLimit: number,
  channelsAvailable: number,
  membersCount: number,
  membersLimit: number,
  membersAvailable: number,
  extraChannelsPurchased: number,
  extraMembersPurchased: number
}

GET /billing/users/workspace-limits
Response: {
  currentWorkspaces: number,
  maxWorkspaces: number,
  canCreateWorkspace: boolean
}
```

#### Add-ons
```
GET /billing/workspaces/:workspaceId/addons
Response: {
  addons: [{
    type: "EXTRA_CHANNEL" | "EXTRA_MEMBER" | "EXTRA_WORKSPACE",
    name: string,
    pricePerUnitCents: number,
    minQuantity: number,
    maxQuantity: number
  }]
}

GET /billing/workspaces/:workspaceId/addons/current
Response: {
  addons: [{
    type: string,
    quantity: number,
    totalCostCents: number
  }]
}

POST /billing/workspaces/:workspaceId/addons
Body: { addonType: string, quantity: number }
Response: { message, newLimits, monthlyCostChange }

DELETE /billing/workspaces/:workspaceId/addons/:addonType
Body: { quantity?: number }
Response: { message, newLimits }
```

#### Payment Methods
```
GET /billing/users/payment-methods
Response: {
  paymentMethods: [{
    id: string,
    stripePaymentMethodId: string,
    type: "card",
    last4: string,
    brand: string,
    expiryMonth: number,
    expiryYear: number,
    isDefault: boolean
  }]
}

POST /billing/users/payment-methods/setup-intent
Response: { clientSecret: string }

POST /billing/users/payment-methods
Body: { paymentMethodId: string, setAsDefault?: boolean }
Response: { paymentMethod }

POST /billing/users/payment-methods/:paymentMethodId/set-default
Response: { message }

DELETE /billing/users/payment-methods/:paymentMethodId
Response: { message }
```

#### Invoices
```
GET /billing/workspaces/:workspaceId/invoices?limit=10&offset=0
Response: {
  invoices: [{
    id: number,
    stripeInvoiceId: string,
    invoiceNumber: string,
    status: "draft" | "open" | "paid" | "void" | "uncollectible",
    amountDue: number,
    amountPaid: number,
    currency: string,
    periodStart: string,
    periodEnd: string,
    dueDate: string,
    paidAt: string | null,
    hostedInvoiceUrl: string,
    invoicePdfUrl: string
  }],
  total: number,
  hasMore: boolean
}

GET /billing/users/invoices?limit=10&offset=0
Response: { invoices: [...], total, hasMore }

GET /billing/invoices/:invoiceId
Response: {
  invoice: { ... },
  lineItems: [{
    description: string,
    quantity: number,
    unitAmountCents: number,
    totalAmountCents: number,
    type: "BASE_PLAN" | "EXTRA_CHANNEL" | "EXTRA_MEMBER" | "EXTRA_WORKSPACE"
  }]
}

GET /billing/invoices/:invoiceId/pdf
Response: { url: string }

GET /billing/workspaces/:workspaceId/upcoming-invoice
Response: {
  amountDue: number,
  periodStart: string,
  periodEnd: string,
  lineItems: [...]
}
```

#### Dashboards
```
GET /billing/workspaces/:workspaceId/dashboard
Response: {
  subscription: {
    id, planCode, planName, status,
    currentPeriodEnd, cancelAtPeriodEnd, trialEnd
  },
  usage: {
    channelsCount, channelsLimit, channelsPercentage,
    membersCount, membersLimit, membersPercentage,
    extraChannelsPurchased, extraMembersPurchased
  },
  billing: {
    monthlyTotal, monthlyTotalFormatted,
    basePlanCost, addonsCost, nextBillingDate
  },
  recentInvoices: [...],
  recentChanges: [...]
}

GET /billing/users/billing-summary
Response: {
  totalWorkspaces: number,
  totalMonthlySpend: number,
  totalMonthlySpendFormatted: string,
  workspaces: [{
    id, name, planCode, monthlyCost, status
  }]
}

GET /billing/workspaces/:workspaceId/subscription-history?limit=10
Response: {
  changes: [{
    id, changeType, previousPlan, newPlan,
    previousQuantity, newQuantity, prorationAmount,
    createdAt
  }]
}
```

### Pages/Components to Create

#### 1. Pricing Page (`/pricing`)
- Display all available plans in a comparison table/grid
- Show features, limits, and pricing for each plan
- Highlight current plan (if user is logged in)
- CTA buttons: "Get Started" (FREE), "Subscribe" (paid plans)
- Toggle between monthly/annual pricing (if applicable)

#### 2. Billing Dashboard (`/dashboard/[workspaceId]/billing` or `/settings/billing`)
- **Overview Section:**
  - Current plan name and status badge
  - Usage meters (channels used/limit, members used/limit)
  - Monthly cost breakdown (base + add-ons)
  - Next billing date
  - Upgrade/Downgrade buttons

- **Usage Cards:**
  - Visual progress bars for channels and members
  - "Add More" buttons linking to add-ons
  - Warning indicators when near limits

- **Quick Actions:**
  - Change Plan button
  - Manage Payment Methods
  - View Invoices
  - Cancel Subscription

#### 3. Plan Selection/Change Modal or Page
- Show all plans with current plan highlighted
- Preview proration when selecting a different plan
- Show validation warnings (e.g., "You're using 12 channels, PRO only allows 10")
- Confirmation step with cost breakdown
- Handle upgrade immediately, downgrade at period end

#### 4. Add-ons Management (`/settings/billing/addons`)
- List available add-ons for current plan
- Show currently purchased add-ons with quantities
- Quantity selector (+ / -) for each add-on type
- Real-time cost calculation
- Purchase/Remove buttons
- Validation: Can't remove if usage exceeds new limit

#### 5. Payment Methods Page (`/settings/billing/payment-methods`)
- List saved payment methods (cards)
- Show card brand icon, last 4 digits, expiry
- Default badge on primary card
- "Set as Default" button
- "Remove" button with confirmation
- "Add New Card" button -> Stripe Elements form

#### 6. Add Payment Method Flow
- Use Stripe Elements (CardElement or individual elements)
- Call `POST /billing/users/payment-methods/setup-intent` to get clientSecret
- Use `stripe.confirmCardSetup(clientSecret, { payment_method: {...} })`
- On success, call `POST /billing/users/payment-methods` with paymentMethodId
- Show loading states and error handling

#### 7. Checkout/Subscribe Flow
- For new subscriptions:
  1. Select plan
  2. If paid plan and no payment method: Show add card form
  3. Call `POST /billing/workspaces/:workspaceId/subscription`
  4. If clientSecret returned: Confirm payment with Stripe
  5. Show success/error state
  6. Redirect to dashboard

#### 8. Invoices Page (`/settings/billing/invoices`)
- Paginated table of invoices
- Columns: Invoice #, Date, Amount, Status, Actions
- Status badges: Paid (green), Open (yellow), Past Due (red)
- Download PDF button
- View Details button -> modal or page with line items
- Filter by workspace (for user-level view)

#### 9. Invoice Detail View
- Invoice header (number, date, status)
- Line items table (description, quantity, unit price, total)
- Subtotal, tax, total
- Payment status and date
- Download PDF button
- Link to Stripe hosted invoice

#### 10. Subscription Cancellation Flow
- Cancellation modal with:
  - Option: Cancel immediately vs. Cancel at period end
  - Warning about losing access
  - Retention offer (optional)
  - Confirmation button
- Post-cancellation: Show reactivation option

### State Management Recommendations

```typescript
// Types to define
interface Plan {
  id: number;
  code: 'FREE' | 'PRO' | 'MAX';
  name: string;
  basePriceCents: number;
  channelsPerWorkspace: number;
  membersPerWorkspace: number;
  maxWorkspaces: number;
  features: Record<string, any>;
}

interface Subscription {
  id: number;
  workspaceId: string;
  planCode: string;
  status: 'active' | 'past_due' | 'trialing' | 'canceled';
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
}

interface Usage {
  channelsCount: number;
  channelsLimit: number;
  channelsAvailable: number;
  membersCount: number;
  membersLimit: number;
  membersAvailable: number;
}

interface PaymentMethod {
  id: string;
  stripePaymentMethodId: string;
  brand: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  isDefault: boolean;
}

// React Query hooks to create
useQuery: usePlans, useSubscription, useUsage, usePaymentMethods, useInvoices, useBillingDashboard
useMutation: useCreateSubscription, useChangePlan, useCancelSubscription, useAddPaymentMethod, usePurchaseAddon
```

### Stripe Integration Setup

```typescript
// Install: npm install @stripe/stripe-js @stripe/react-stripe-js

// lib/stripe.ts
import { loadStripe } from '@stripe/stripe-js';
export const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

// Wrap app or billing pages with Elements provider
import { Elements } from '@stripe/react-stripe-js';

<Elements stripe={stripePromise}>
  <PaymentForm />
</Elements>
```

### UI/UX Requirements

1. **Loading States**: Skeleton loaders for all data fetching
2. **Error Handling**: Toast notifications for API errors
3. **Optimistic Updates**: For quick actions like marking default payment method
4. **Confirmation Modals**: For destructive actions (cancel, remove)
5. **Real-time Validation**: Disable buttons when action not allowed
6. **Responsive Design**: Mobile-friendly billing pages
7. **Accessibility**: Proper ARIA labels, keyboard navigation

### Error Scenarios to Handle

1. **Payment Failed**: Show banner with "Update Payment Method" CTA
2. **Past Due Subscription**: Prominent warning, restrict certain features
3. **Usage Limit Reached**: Disable "Add Channel/Member" with upgrade prompt
4. **Plan Change Blocked**: Show why (usage exceeds new limits)
5. **Card Declined**: Clear error message with retry option
6. **Network Errors**: Retry buttons, offline indicators

### Feature Flags / Conditional Rendering

```typescript
// Show/hide based on subscription status
const canCreateChannel = usage.channelsAvailable > 0;
const canCreateMember = usage.membersAvailable > 0;
const canCreateWorkspace = workspaceLimits.canCreateWorkspace;
const isPastDue = subscription.status === 'past_due';
const isTrial = subscription.status === 'trialing';
const isFreePlan = subscription.planCode === 'FREE';
```

### File Structure Suggestion

```
app/
├── (dashboard)/
│   ├── [workspaceId]/
│   │   └── settings/
│   │       └── billing/
│   │           ├── page.tsx          # Billing dashboard
│   │           ├── plans/
│   │           │   └── page.tsx      # Plan selection
│   │           ├── addons/
│   │           │   └── page.tsx      # Add-ons management
│   │           ├── payment-methods/
│   │           │   └── page.tsx      # Payment methods
│   │           └── invoices/
│   │               ├── page.tsx      # Invoice list
│   │               └── [invoiceId]/
│   │                   └── page.tsx  # Invoice detail
├── pricing/
│   └── page.tsx                      # Public pricing page

components/
├── billing/
│   ├── PlanCard.tsx
│   ├── PlanComparisonTable.tsx
│   ├── UsageMeter.tsx
│   ├── BillingOverview.tsx
│   ├── AddPaymentMethodForm.tsx
│   ├── PaymentMethodCard.tsx
│   ├── InvoiceTable.tsx
│   ├── InvoiceLineItems.tsx
│   ├── AddonSelector.tsx
│   ├── PlanChangePreview.tsx
│   ├── CancellationModal.tsx
│   └── UpgradePrompt.tsx

hooks/
├── billing/
│   ├── usePlans.ts
│   ├── useSubscription.ts
│   ├── useUsage.ts
│   ├── usePaymentMethods.ts
│   ├── useInvoices.ts
│   ├── useBillingDashboard.ts
│   └── mutations/
│       ├── useCreateSubscription.ts
│       ├── useChangePlan.ts
│       ├── useCancelSubscription.ts
│       ├── useAddPaymentMethod.ts
│       └── usePurchaseAddon.ts

lib/
├── stripe.ts                         # Stripe initialization
└── api/
    └── billing.ts                    # API client functions

types/
└── billing.ts                        # TypeScript interfaces
```

### Implementation Order

1. **Phase 1 - Foundation**
   - Set up Stripe client
   - Create TypeScript types
   - Create API client functions
   - Create React Query hooks

2. **Phase 2 - Core Pages**
   - Pricing page (public)
   - Billing dashboard
   - Payment methods page

3. **Phase 3 - Subscription Flow**
   - Plan selection/change
   - Checkout flow with Stripe Elements
   - Cancellation flow

4. **Phase 4 - Add-ons & Invoices**
   - Add-ons management
   - Invoice list and detail views

5. **Phase 5 - Polish**
   - Error handling
   - Loading states
   - Mobile responsiveness
   - Edge cases

### Important Notes

1. **Stripe Publishable Key**: Add `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to environment
2. **API Authentication**: Include JWT token in all API requests
3. **Workspace Context**: Most billing endpoints require workspaceId
4. **Currency**: All amounts are in cents (divide by 100 for display)
5. **Webhooks**: Backend handles Stripe webhooks - frontend just reflects state

---

## PROMPT END

---

# Quick Reference: Key Flows

## Subscribe to Paid Plan Flow
```
1. GET /billing/plans -> Show plans
2. User selects plan
3. If no payment method:
   - POST /billing/users/payment-methods/setup-intent -> Get clientSecret
   - stripe.confirmCardSetup() -> Get paymentMethodId
   - POST /billing/users/payment-methods -> Save card
4. POST /billing/workspaces/:id/subscription { planCode, paymentMethodId }
5. If clientSecret in response: stripe.confirmCardPayment()
6. Redirect to dashboard
```

## Upgrade Plan Flow
```
1. GET /billing/workspaces/:id/plan-change/preview?newPlanCode=MAX
2. Show proration amount and new limits
3. User confirms
4. POST /billing/workspaces/:id/plan-change { newPlanCode: "MAX" }
5. Show success, refresh dashboard
```

## Add Payment Method Flow
```
1. POST /billing/users/payment-methods/setup-intent -> Get clientSecret
2. Render Stripe CardElement
3. stripe.confirmCardSetup(clientSecret, { payment_method: { card: cardElement } })
4. POST /billing/users/payment-methods { paymentMethodId: result.setupIntent.payment_method }
5. Refresh payment methods list
```

## Purchase Add-on Flow
```
1. GET /billing/workspaces/:id/addons -> Show available add-ons
2. User selects add-on and quantity
3. POST /billing/workspaces/:id/addons { addonType: "EXTRA_CHANNEL", quantity: 5 }
4. Show success with new limits
5. Refresh usage data
```
