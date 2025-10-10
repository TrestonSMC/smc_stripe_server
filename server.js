require('dotenv').config({ path: './.env' });

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const stripeKey = process.env.STRIPE_SECRET_KEY;
console.log('Loaded Stripe key:', stripeKey ? '✅ Found' : '❌ Missing');

const stripe = new Stripe(stripeKey);
const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('🚀 Stripe server is running and connected!');
});

app.get('/test', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ message: 'Stripe API working ✅', balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create Payment Intent route
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, customerEmail } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'Missing amount' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      receipt_email: customerEmail || undefined,
      automatic_payment_methods: { enabled: true },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);



