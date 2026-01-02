require('dotenv').config({ path: './.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const mime = require('mime-types');
const bodyParser = require('body-parser');

// ===============================
// 🔐 Stripe Setup
// ===============================
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) throw new Error('❌ STRIPE_SECRET_KEY missing');

const stripe = new Stripe(stripeKey, {
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
// 🧠 Supabase Setup (Service Role)
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===============================
// 🏠 Root
// ===============================
app.get('/', (_, res) => {
  res.send('🚀 Stripe + Supabase backend is live');
});

// ===============================
// 🧪 Stripe Test
// ===============================
app.get('/test', async (_, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ ok: true, balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 💳 CREATE PAYMENT INTENT (REWARDS + MANUAL PAY)
// ===============================
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, customerEmail, customerId } = req.body;

    if (!amount || amount < 50) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    if (!customerId) {
      return res.status(400).json({ error: 'Missing Supabase user id' });
    }

    // --------------------------------
    // Find or create Stripe customer
    // --------------------------------
    let customer;
    const existing = await stripe.customers.list({
      email: customerEmail,
      limit: 1,
    });

    customer =
      existing.data.length > 0
        ? existing.data[0]
        : await stripe.customers.create({
            email: customerEmail,
            name: customerEmail?.split('@')[0],
          });

    // --------------------------------
    // Ephemeral key for PaymentSheet
    // --------------------------------
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2023-10-16' }
    );

    // --------------------------------
    // PaymentIntent (ACH + Card)
    // --------------------------------
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: customer.id,

      payment_method_types: ['card', 'us_bank_account'],
      setup_future_usage: 'off_session',

      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'always',
      },

      receipt_email: customerEmail || undefined,

      metadata: {
        user_id: customerId,
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      customerId: customer.id,
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (err) {
    console.error('❌ PaymentIntent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 💳 INVOICE PAYMENT SHEET (PAY NOW)
// ===============================
app.post('/invoice-payment-sheet', async (req, res) => {
  try {
    const { invoiceId } = req.body;

    if (!invoiceId) {
      return res.status(400).json({ error: 'Missing invoiceId' });
    }

    const invoice = await stripe.invoices.retrieve(invoiceId);

    if (!invoice.payment_intent) {
      return res.status(400).json({ error: 'Invoice not payable yet' });
    }

    // 🔑 Update intent to allow ACH
    const paymentIntent = await stripe.paymentIntents.update(
      invoice.payment_intent,
      {
        payment_method_types: ['card', 'us_bank_account'],
        setup_future_usage: 'off_session',
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'always',
        },
      }
    );

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: invoice.customer },
      { apiVersion: '2023-10-16' }
    );

    res.json({
      clientSecret: paymentIntent.client_secret,
      customerId: invoice.customer,
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (err) {
    console.error('❌ Invoice payment sheet error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 🔔 STRIPE WEBHOOK
// ===============================
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
    console.error('❌ Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // -------------------------------
  // Invoice created / finalized
  // -------------------------------
  if (event.type === 'invoice.finalized') {
    const invoice = event.data.object;

    await supabase.from('invoices').upsert({
      stripe_invoice_id: invoice.id,
      stripe_customer_id: invoice.customer,
      amount_due: invoice.amount_due / 100,
      status: 'open',
      hosted_invoice_url: invoice.hosted_invoice_url,
      created_at: new Date(invoice.created * 1000),
    });
  }

  // -------------------------------
  // Invoice paid
  // -------------------------------
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    await supabase
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: new Date(invoice.status_transitions.paid_at * 1000),
      })
      .eq('stripe_invoice_id', invoice.id);
  }

  // -------------------------------
  // Invoice failed
  // -------------------------------
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;

    await supabase
      .from('invoices')
      .update({ status: 'failed' })
      .eq('stripe_invoice_id', invoice.id);
  }

  // -------------------------------
  // Rewards points
  // -------------------------------
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const userId = intent.metadata?.user_id;

    if (userId) {
      await supabase.rpc('award_points_for_payment', {
        p_user_id: userId,
        p_amount_cents: intent.amount_received,
      });
    }
  }

  res.json({ received: true });
});

// ===============================
// ▶️ Start Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});




