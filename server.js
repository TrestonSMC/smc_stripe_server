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
  res.send('🚀 Stripe Live Server is running and ready for production!');
});

app.get('/test', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ message: '✅ Stripe API Live Mode Connected', balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, customerEmail } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'Missing amount' });
    }

    console.log(`💰 Creating Live PaymentIntent for $${(amount / 100).toFixed(2)}`);

    // ✅ FIX: specify payment method type
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      payment_method_types: ['card'],
      receipt_email: customerEmail || undefined,
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Live Stripe Server running on http://localhost:${PORT}`)
);





