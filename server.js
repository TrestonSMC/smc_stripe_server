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
// 💳 CREATE PAYMENT INTENT (Rewards Only)
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

    console.log(`💰 PaymentIntent: $${(amount / 100).toFixed(2)}`);

    // -------------------------------
    // 1️⃣ Find or Create Stripe Customer
    // -------------------------------
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

    // -------------------------------
    // 2️⃣ Ephemeral Key (Mobile)
    // -------------------------------
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2023-10-16' }
    );

    // -------------------------------
    // 3️⃣ Create PaymentIntent
    // -------------------------------
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: customer.id,
      automatic_payment_methods: { enabled: true },
      setup_future_usage: 'off_session',
      receipt_email: customerEmail || undefined,
      metadata: {
        user_id: customerId, // Supabase auth.users.id
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      customerId: customer.id,
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (error) {
    console.error('❌ PaymentIntent error:', error);
    res.status(500).json({ error: error.message });
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

  // ===============================
  // 🧾 INVOICE FINALIZED (PAYABLE)
  // ===============================
  if (event.type === 'invoice.finalized') {
    const invoice = event.data.object;

    console.log(`🧾 Invoice finalized: ${invoice.id}`);

    await supabase.from('invoices').upsert({
      stripe_invoice_id: invoice.id,
      stripe_customer_id: invoice.customer,
      amount_due: invoice.amount_due / 100,
      status: 'open',
      hosted_invoice_url: invoice.hosted_invoice_url,
      created_at: new Date(invoice.created * 1000),
    });
  }

  // ===============================
  // ✅ INVOICE PAID
  // ===============================
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    console.log(`✅ Invoice paid: ${invoice.id}`);

    await supabase
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: new Date(invoice.status_transitions.paid_at * 1000),
      })
      .eq('stripe_invoice_id', invoice.id);
  }

  // ===============================
  // ❌ INVOICE FAILED
  // ===============================
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;

    console.warn(`❌ Invoice payment failed: ${invoice.id}`);

    await supabase
      .from('invoices')
      .update({ status: 'failed' })
      .eq('stripe_invoice_id', invoice.id);
  }

  // ===============================
  // ⭐ PAYMENT SUCCEEDED (REWARDS)
  // ===============================
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;

    const userId = intent.metadata?.user_id;
    const amountCents = intent.amount_received;

    if (!userId) {
      console.warn('⚠️ PaymentIntent missing user_id metadata');
      return res.json({ received: true });
    }

    const points = Math.floor(amountCents / 1000); // $10 = 1 point

    if (points > 0) {
      console.log(`⭐ Awarding ${points} pts to user ${userId}`);

      await supabase.rpc('award_points_for_payment', {
        p_user_id: userId,
        p_amount_cents: amountCents,
      });
    }
  }

  res.json({ received: true });
});

// ===============================
// 🎥 SUPABASE SIGNED UPLOAD URL
// ===============================
app.post('/get-upload-url', async (req, res) => {
  try {
    const { fileName } = req.body;
    if (!fileName) {
      return res.status(400).json({ error: 'Missing fileName' });
    }

    const ext = fileName.split('.').pop().toLowerCase();
    const allowed = ['mp4', 'mov', 'm4v', 'avi'];
    if (!allowed.includes(ext)) {
      return res.status(400).json({ error: `Unsupported type: ${ext}` });
    }

    const mimeType = mime.lookup(ext) || 'application/octet-stream';
    const filePath = `videos/${Date.now()}_${fileName}`;

    const { data, error } = await supabase.storage
      .from('client_videos')
      .createSignedUploadUrl(filePath, 60 * 60);

    if (error) throw error;

    res.json({
      signedUrl: data.signedUrl,
      path: filePath,
      mimeType,
      expiresIn: '1 hour',
    });
  } catch (err) {
    console.error('❌ Upload URL error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// ▶️ Start Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});




