/**
 * /api/stripe-checkout — Creates a Stripe Checkout Session
 * Input: { priceId, userId, email }
 * Returns: { url } — redirect to Stripe hosted checkout
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe not configured' });

  const { priceId, userId, email } = req.body || {};
  if (!priceId || !userId) return res.status(400).json({ error: 'priceId and userId required' });

  const successUrl = process.env.STRIPE_SUCCESS_URL || 'https://rsa-studio.vercel.app?upgraded=true';
  const cancelUrl  = process.env.STRIPE_CANCEL_URL  || 'https://rsa-studio.vercel.app';

  try {
    const { Stripe } = await import('stripe');
    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

    // Find or create Stripe customer tied to Clerk userId
    const existing = await stripe.customers.list({ email, limit: 1 });
    let customer;
    if (existing.data.length > 0) {
      customer = existing.data[0];
      // Update metadata if missing
      if (!customer.metadata?.clerkUserId) {
        await stripe.customers.update(customer.id, { metadata: { clerkUserId: userId } });
      }
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { clerkUserId: userId },
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: {
        metadata: { clerkUserId: userId },
      },
      allow_promotion_codes: true,
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
