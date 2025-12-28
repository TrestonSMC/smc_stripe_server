require('dotenv').config({ path: './.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const mime = require('mime-types');

// ===============================
// 🔐 Stripe Setup
// ===============================
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  throw new Error('❌ STRIPE_SECRET_KEY missing');
}

const stripe = new Stripe(stripeKey, {
  apiVersion: '2023-10-16',
});

// ===============================
// 🚀 App Setup
// ===============================
const app = express();
app.use(cors());
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
// 💳 CREATE PAYMENT INTENT (FINAL)
// ===============================
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, customerEmail, customerId } = req.body;

    if (!amount || amount < 50) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    console.log(`💰 PaymentIntent: $${(amount / 100).toFixed(2)}`);

    // -------------------------------
    // 1️⃣ Find or Create Customer
    // -------------------------------
    let customer;

    if (customerId) {
      customer = await stripe.customers.retrieve(customerId);
    } else if (customerEmail) {
      const existing = await stripe.customers.list({
        email: customerEmail,
        limit: 1,
      });

      customer =
        existing.data.length > 0
          ? existing.data[0]
          : await stripe.customers.create({
              email: customerEmail,
              name: customerEmail.split('@')[0],
            });
    } else {
      return res.status(400).json({ error: 'Missing customer info' });
    }

    // -------------------------------
    // 2️⃣ Create Ephemeral Key
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
    });

    // -------------------------------
    // 4️⃣ Send Secrets to App
    // -------------------------------
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


