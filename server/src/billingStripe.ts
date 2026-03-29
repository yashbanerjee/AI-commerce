import type { Request, Response } from 'express';
import Stripe from 'stripe';
import {
  BILLING_UPGRADE_BASE_URL,
  STRIPE_CHECKOUT_CANCEL_URL,
  STRIPE_CHECKOUT_SUCCESS_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
} from './config.js';
import { withClient } from './db.js';
import {
  findTenantByStripeCustomerId,
  getStripePriceIdForSlug,
  insertBillingEvent,
  resolvePlanSlugFromStripePriceId,
  updateTenantBillingFromStripe,
} from './billingRepo.js';
import { findTenantByApiKey, findTenantById } from './tenants.js';

export function getStripe(): Stripe | null {
  const k = STRIPE_SECRET_KEY.trim();
  if (!k) return null;
  return new Stripe(k);
}

async function applySubscriptionToTenant(
  client: import('pg').PoolClient,
  stripe: Stripe,
  sub: Stripe.Subscription,
  tenantIdHint: string | null
): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  let tenantId = tenantIdHint;
  if (!tenantId) {
    const meta = sub.metadata?.tenant_id;
    tenantId = typeof meta === 'string' && meta ? meta : null;
  }
  let tenant = tenantId ? await findTenantById(client, tenantId) : null;
  if (!tenant) {
    tenant = await findTenantByStripeCustomerId(client, customerId);
  }
  if (!tenant) {
    await insertBillingEvent(client, null, 'stripe:subscription_no_tenant', {
      subscription_id: sub.id,
      customer_id: customerId,
    });
    return;
  }

  const priceId = sub.items.data[0]?.price?.id ?? '';
  const planSlug = await resolvePlanSlugFromStripePriceId(client, priceId);
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

  await updateTenantBillingFromStripe(client, tenant.id, {
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    billing_plan_slug: sub.status === 'canceled' ? null : planSlug,
    subscription_status: sub.status,
    current_period_end: periodEnd,
  });

  await insertBillingEvent(client, tenant.id, `stripe:subscription:${sub.status}`, {
    subscription_id: sub.id,
    price_id: priceId,
    plan_slug: planSlug,
  });
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const sig = req.headers['stripe-signature'];
  const stripe = getStripe();
  const whSecret = STRIPE_WEBHOOK_SECRET.trim();
  if (!stripe || !whSecret) {
    res.status(503).json({ error: 'stripe_webhook_not_configured' });
    return;
  }
  if (typeof sig !== 'string') {
    res.status(400).json({ error: 'missing_stripe_signature' });
    return;
  }
  const raw = req.body;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}), 'utf8');
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, whSecret);
  } catch {
    res.status(400).json({ error: 'invalid_signature' });
    return;
  }

  try {
    await withClient(async (c) => {
      await insertBillingEvent(c, null, `stripe:${event.type}`, { id: event.id });

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const tenantId = typeof session.metadata?.tenant_id === 'string' ? session.metadata.tenant_id : null;
          const subId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription && typeof session.subscription === 'object'
                ? session.subscription.id
                : null;
          if (!subId || !stripe) break;
          const sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price'] });
          await applySubscriptionToTenant(c, stripe, sub, tenantId);
          break;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          await applySubscriptionToTenant(c, stripe, sub, null);
          break;
        }
        default:
          break;
      }
    });
    res.json({ received: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}

export async function handleCreateCheckoutSession(req: Request, res: Response): Promise<void> {
  try {
    const stripe = getStripe();
    if (!stripe) {
      res.status(503).json({ error: 'stripe_not_configured' });
      return;
    }
    const body = req.body as { plan?: string };
    const plan = String(body.plan ?? '').toLowerCase();
    if (plan !== 'starter' && plan !== 'growth' && plan !== 'pro') {
      res.status(400).json({ error: 'invalid_plan' });
      return;
    }

    const tenant = await withClient(async (c) => {
      const h = req.headers.authorization ?? '';
      const m = /^Bearer\s+(.+)$/i.exec(h);
      if (!m) return null;
      return findTenantByApiKey(c, m[1].trim());
    });
    if (!tenant) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const priceId = getStripePriceIdForSlug(plan);
    if (!priceId) {
      res.status(503).json({ error: 'stripe_price_not_configured', plan });
      return;
    }

    const baseUpgrade = BILLING_UPGRADE_BASE_URL.trim();
    const successUrlRaw =
      STRIPE_CHECKOUT_SUCCESS_URL.trim() ||
      (baseUpgrade
        ? `${baseUpgrade}${baseUpgrade.includes('?') ? '&' : '?'}checkout=success&session_id={CHECKOUT_SESSION_ID}`
        : 'https://example.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}');
    const cancelUrl = STRIPE_CHECKOUT_CANCEL_URL.trim() || baseUpgrade || 'https://example.com/?checkout=cancel';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrlRaw.includes('{CHECKOUT_SESSION_ID}')
        ? successUrlRaw
        : `${successUrlRaw}${successUrlRaw.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      client_reference_id: tenant.id,
      metadata: { tenant_id: tenant.id },
      subscription_data: {
        metadata: { tenant_id: tenant.id },
      },
      ...(tenant.billing_email ? { customer_email: tenant.billing_email } : {}),
    });

    res.json({ url: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    res.status(500).json({ error: msg });
  }
}
