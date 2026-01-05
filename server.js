require('dotenv').config({ path: './.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require('body-parser');

// ===============================
// 🔐 Stripe Setup
// ===============================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

// ===============================
// 🚀 App Setup
// ===============================
const app = express();
app.use(cors());

// ⚠️ Stripe webhook must use RAW body
app.use('/webhooks/stripe', bodyParser.raw({ type: 'application/json' }));
app.use(express.json());

// ===============================
// 🧠 Supabase (Service Role)
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===============================
// 🏠 Root
// ===============================
app.get('/', (_, res) => res.send('🚀 Stripe backend live'));

// ============================================================
// 💳 CREATE PAYMENT INTENT (CARD + ACH)
// ============================================================
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, customerEmail, customerId, transactionId } = req.body;

    if (!amount || !customerId || !transactionId) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    // 1️⃣ Stripe customer
    const existing = await stripe.customers.list({
      email: customerEmail,
      limit: 1,
    });

    const customer =
      existing.data[0] ||
      (await stripe.customers.create({
        email: customerEmail,
      }));

    // 2️⃣ Ephemeral key
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2023-10-16' }
    );

    // 3️⃣ PaymentIntent
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: customer.id,
      automatic_payment_methods: { enabled: true },
      metadata: {
        transaction_id: transactionId,
        user_id: customerId,
      },
    });

    // 🔗 Save intent → transaction
    await supabase
      .from('transactions')
      .update({
        payment_intent_id: intent.id,
      })
      .eq('id', transactionId);

    res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      customerId: customer.id,
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (err) {
    console.error('❌ create-payment-intent:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🔔 STRIPE WEBHOOK (SOURCE OF TRUTH)
// ============================================================
app.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ====================================================
    // ✅ PAYMENT SUCCEEDED (CARD OR ACH CLEARED)
    // ====================================================
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const transactionId = intent.metadata.transaction_id;

      if (!transactionId) return res.json({ received: true });

      await supabase
        .from('transactions')
        .update({
          status: 'succeeded',
        })
        .eq('id', transactionId);
    }

    // ====================================================
    // ❌ PAYMENT FAILED / CANCELED
    // ====================================================
    if (
      event.type === 'payment_intent.payment_failed' ||
      event.type === 'payment_intent.canceled'
    ) {
      const intent = event.data.object;
      const transactionId = intent.metadata.transaction_id;

      if (!transactionId) return res.json({ received: true });

      await supabase
        .from('transactions')
        .update({
          status: 'failed',
        })
        .eq('id', transactionId);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// ▶️ Start Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Stripe server running on port ${PORT}`)
);


