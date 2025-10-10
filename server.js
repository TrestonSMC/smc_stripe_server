require('dotenv').config({ path: './.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const stripeKey = process.env.STRIPE_SECRET_KEY;
console.log('Loaded Stripe key:', stripeKey ? '✅ Found' : '❌ Missing');

const stripe = new Stripe(stripeKey);
const app = express();

// ✅ CORS setup for Flutter & web access
app.use(
  cors({
    origin: [
      'http://localhost:3000',   // local dev
      'http://localhost:8080',
      'https://smc-stripe-server.onrender.com', // Render backend
      'https://smc-app.web.app',  // your Flutter web or domain (optional)
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  })
);

app.use(express.json());

// ✅ Root route
app.get('/', (req, res) => {
  res.send('🚀 Stripe server is running and connected to Render!');
});

// ✅ Stripe connection test route
app.get('/test', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ message: 'Stripe API working ✅', balance });
  } catch (err) {
    console.error('❌ Stripe test error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create PaymentIntent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, customerEmail } = req.body;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Missing or invalid amount' });
    }

    console.log(`💰 Creating PaymentIntent for $${(amount / 100).toFixed(2)}`);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      receipt_email: customerEmail || undefined,
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Health check endpoint for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);



