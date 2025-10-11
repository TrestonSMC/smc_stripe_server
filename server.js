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

// 🏠 Root
app.get('/', (req, res) => {
  res.send('🚀 Stripe Live Server is running and ready for production!');
});

// ✅ Test endpoint
app.get('/test', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ message: '✅ Stripe API Live Mode Connected', balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 💳 Create PaymentIntent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, customerEmail, customerId } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'Missing amount' });
    }

    console.log(`💰 Creating Live PaymentIntent for $${(amount / 100).toFixed(2)}`);

    // ✅ Create or reuse customer (for saved cards)
    let customer;
    if (customerId) {
      customer = customerId;
    } else if (customerEmail) {
      // Try to find existing customer by email
      const existingCustomers = await stripe.customers.list({
        email: customerEmail,
        limit: 1,
      });
      if (existingCustomers.data.length > 0) {
        customer = existingCustomers.data[0].id;
      } else {
        const newCustomer = await stripe.customers.create({
          email: customerEmail,
          name: customerEmail.split('@')[0],
        });
        customer = newCustomer.id;
      }
    }

    // ✅ Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer, // ✅ attaches PaymentIntent to customer
      setup_future_usage: 'on_session', // ✅ shows “Save card for future payments”
      automatic_payment_methods: { enabled: true }, // ✅ allows Apple Pay / Google Pay / Card
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

// ✅ Server start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Live Stripe Server running on http://localhost:${PORT}`)
);






