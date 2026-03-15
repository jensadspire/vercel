/**
 * /api/stripe-webhook — Handles Stripe payment events
 * Updates Clerk user metadata on subscription changes
 */

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function setClerkPlan(clerkUserId, plan) {
  const clerkSecret = process.env.CLERK_SECRET_KEY;
  if (!clerkSecret || !clerkUserId) return;
  await fetch(`https://api.clerk.com/v1/users/${clerkUserId}/metadata`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${clerkSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ public_metadata: { plan } }),
  });
  console.log(`Clerk user ${clerkUserId} set to plan: ${plan}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripeKey    = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeKey || !webhookSecret) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const { Stripe } = await import('stripe');
  const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  console.log('Stripe event:', event.type);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const clerkUserId = session.subscription_data?.metadata?.clerkUserId
          || session.metadata?.clerkUserId;
        if (clerkUserId) await setClerkPlan(clerkUserId, 'pro');
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const clerkUserId = sub.metadata?.clerkUserId;
        if (clerkUserId) await setClerkPlan(clerkUserId, 'free');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        // Get clerkUserId from subscription metadata
        const subId = invoice.subscription;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const clerkUserId = sub.metadata?.clerkUserId;
          if (clerkUserId) await setClerkPlan(clerkUserId, 'past_due');
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const clerkUserId = sub.metadata?.clerkUserId;
        if (clerkUserId) {
          const plan = sub.status === 'active' ? 'pro'
            : sub.status === 'past_due' ? 'past_due'
            : 'free';
          await setClerkPlan(clerkUserId, plan);
        }
        break;
      }
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
