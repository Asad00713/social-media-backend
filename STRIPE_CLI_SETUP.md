# Stripe CLI Setup Guide for Windows

## Quick Option: Download Stripe CLI

### Step 1: Download
1. Go to: https://github.com/stripe/stripe-cli/releases/latest
2. Download: `stripe_X.X.X_windows_x86_64.zip`
3. Extract the ZIP file to a folder (e.g., `C:\stripe` or `D:\tools\stripe`)

### Step 2: Add to PATH (Optional but Recommended)
**PowerShell (as Administrator):**
```powershell
$env:Path += ";C:\stripe"
[Environment]::SetEnvironmentVariable("Path", $env:Path, [EnvironmentVariableTarget]::User)
```

Or manually:
1. Right-click "This PC" → Properties → Advanced System Settings
2. Click "Environment Variables"
3. Under "User variables", select "Path" and click "Edit"
4. Click "New" and add the path to your stripe folder (e.g., `C:\stripe`)
5. Click OK on all dialogs
6. Restart your terminal

### Step 3: Login to Stripe
```bash
cd C:\stripe  # Or wherever you extracted it
.\stripe login
```

This will open a browser window. Click "Allow access" to authenticate.

### Step 4: Start Webhook Forwarding
```bash
stripe listen --forward-to localhost:3000/billing/webhooks/stripe
```

You'll see output like:
```
> Ready! Your webhook signing secret is whsec_xxxxxxxxxxxxxxxxxxxxx (^C to quit)
```

**Copy that `whsec_...` value** and add it to your `.env` file:
```env
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxx
```

### Step 5: Test Webhooks
In another terminal, trigger test events:
```bash
# Test subscription created
stripe trigger customer.subscription.created

# Test invoice paid
stripe trigger invoice.paid

# Test payment failed
stripe trigger invoice.payment_failed
```

---

## Alternative: Get Webhook Secret from Stripe Dashboard

If you don't want to use Stripe CLI for local development:

1. Go to: https://dashboard.stripe.com/test/webhooks
2. Click "Add endpoint"
3. Enter your endpoint URL:
   - For production: `https://yourdomain.com/billing/webhooks/stripe`
   - For local testing with ngrok: `https://xxxx.ngrok.io/billing/webhooks/stripe`
4. Select events to listen to:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.created`
   - `invoice.finalized`
   - `invoice.paid`
   - `invoice.payment_failed`
5. Click "Add endpoint"
6. Click on the endpoint you just created
7. Click "Reveal" under "Signing secret"
8. Copy the `whsec_...` value to your `.env`

---

## For Now: Temporary Webhook Secret

If you want to test the app without webhooks, add this temporary value to `.env`:

```env
STRIPE_WEBHOOK_SECRET=whsec_temp_development_only
```

**Note:** Webhooks won't work with this temporary secret, but the rest of the billing functionality will work fine. You can create subscriptions, cancel them, etc. The webhook handler will just fail if Stripe tries to send real events.

---

## Testing Without Webhooks

You can still test subscription creation without webhooks:

### 1. Start Your App
```bash
npm run start:dev
```

### 2. Create a FREE Subscription (No Payment Required)
```bash
# Register and login first to get a JWT token
# Create a workspace
# Then create subscription:

curl -X POST http://localhost:3000/billing/workspaces/{workspace_id}/subscription \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"planCode": "FREE"}'
```

### 3. Get Subscription Details
```bash
curl -X GET http://localhost:3000/billing/workspaces/{workspace_id}/subscription \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Recommended Setup for Development

1. **Use Stripe CLI** for local webhook forwarding (easiest)
2. **Or use ngrok** + Stripe Dashboard webhooks
3. **Or skip webhooks** for now and just test subscription creation/cancellation

Webhooks are mainly needed for:
- Real-time subscription updates
- Invoice payment confirmations
- Payment failure notifications

The core subscription functionality works without them!
