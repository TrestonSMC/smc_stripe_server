require('dotenv').config({ path: './.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
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

// =====================================================
// 🧾 CREATE STRIPE INVOICE (OPTION B — REQUIRED)
// =====================================================
app.post('/create-stripe-invoice', async (req, res) => {
  try {
    const {
      customerId,        // Supabase user id
      customerEmail,
      amountCents,
      description,
    } = req.body;

    if (!customerId || !amountCents) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1️⃣ Find or create Stripe customer
    const existing = await stripe.customers.list({
      email: customerEmail,
      limit: 1,
    });

    const customer =
      existing.data.length > 0
        ? existing.data[0]
        : await stripe.customers.create({
            email: customerEmail,
            metadata: { supabase_user_id: customerId },
          });

    // 2️⃣ Create invoice (ACH requires auto-charge)
    const invoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: 'charge_automatically',
      auto_advance: true, // finalize automatically
      metadata: {
        supabase_user_id: customerId,
      },
    });

    // 3️⃣ Attach invoice item
    await stripe.invoiceItems.create({
      customer: customer.id,
      invoice: invoice.id,
      amount: amountCents,
      currency: 'usd',
      description: description || 'SMC Services',
    });

    res.json({
      ok: true,
      stripeInvoiceId: invoice.id,
    });
  } catch (err) {
    console.error('❌ Create invoice error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// 💳 INVOICE PAYMENT SHEET (CARD + ACH)
// =====================================================
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

    // Ensure ACH allowed
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

// =====================================================
// 🔔 STRIPE WEBHOOK (SOURCE OF TRUTH)
// =====================================================
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
  // Invoice finalized → insert Supabase
  // -------------------------------
  if (event.type === 'invoice.finalized') {
    const invoice = event.data.object;
    const userId = invoice.metadata?.supabase_user_id;

    await supabase.from('invoices').insert({
      customer_id: userId,
      stripe_invoice_id: invoice.id,
      stripe_customer_id: invoice.customer,
      amount: invoice.amount_due / 100,
      status: 'unpaid',
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
      .update({ status: 'paid' })
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
  // Rewards (Card only — ACH later)
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





