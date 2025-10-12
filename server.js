require('dotenv').config({ path: './.env' });
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const mime = require('mime-types');

// ✅ Stripe setup
const stripeKey = process.env.STRIPE_SECRET_KEY;
console.log('Loaded Stripe key:', stripeKey ? '✅ Found' : '❌ Missing');

const stripe = new Stripe(stripeKey);
const app = express();

app.use(cors());
app.use(express.json());

// ✅ Supabase setup (must use service role key)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🏠 Root
app.get('/', (req, res) => {
  res.send('🚀 Stripe & Supabase Server is live and ready for production!');
});

// ✅ Test endpoint
app.get('/test', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ message: '✅ Stripe API Live Mode Connected', balance });
  } catch (err) {
    console.error('❌ Stripe test error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 💳 Create PaymentIntent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, customerEmail, customerId } = req.body;
    if (!amount) return res.status(400).json({ error: 'Missing amount' });

    console.log(`💰 Creating Live PaymentIntent for $${(amount / 100).toFixed(2)}`);

    // ✅ Create or reuse customer
    let customer;
    if (customerId) {
      customer = customerId;
    } else if (customerEmail) {
      const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
      customer = existing.data.length
        ? existing.data[0].id
        : (await stripe.customers.create({
            email: customerEmail,
            name: customerEmail.split('@')[0],
          })).id;
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer,
      setup_future_usage: 'on_session',
      automatic_payment_methods: { enabled: true },
      receipt_email: customerEmail || undefined,
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      customerId: customer,
    });
  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🎥 Generate signed Supabase upload URL
app.post('/get-upload-url', async (req, res) => {
  try {
    const { fileName } = req.body;

    if (!fileName) {
      return res.status(400).json({ error: 'Missing fileName' });
    }

    const ext = fileName.split('.').pop().toLowerCase();
    const allowed = ['mp4', 'mov', 'm4v', 'avi'];
    if (!allowed.includes(ext)) {
      return res.status(400).json({ error: `Unsupported file type: .${ext}` });
    }

    const mimeType = mime.lookup(ext) || 'application/octet-stream';
    const filePath = `videos/${Date.now()}_${fileName}`;

    console.log(`🎬 Request received to sign upload for: ${filePath} (${mimeType})`);

    // 🧾 Generate signed upload URL (valid for 1 hour)
    const { data, error } = await supabase.storage
      .from('client_videos') // ⚠️ must match your Supabase bucket name exactly
      .createSignedUploadUrl(filePath, 60 * 60);

    if (error) {
      console.error('❌ Supabase storage error:', error);
      throw error;
    }

    console.log('✅ Signed upload URL successfully created');
    res.json({
      signedUrl: data.signedUrl,
      path: filePath,
      mimeType,
      expiresIn: '1 hour',
    });
  } catch (err) {
    console.error('❌ Error creating signed upload URL:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

