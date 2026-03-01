require('dotenv').config();

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

// ⚠️ Webhook must use RAW body
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
// 🏠 Health Check
// ===============================
app.get('/', (_, res) => res.send('🚀 SMC Stripe backend live'));

// ============================================================
// 💳 CREATE PAYMENT INTENT (Single invoices table)
// ============================================================
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { invoiceId, customerId, customerEmail } = req.body;

    if (!invoiceId || !customerId) {
      return res.status(400).json({ error: 'Missing invoiceId or customerId' });
    }

    const { data: invoice, error } = await supabase
      .from('invoices')
      .select(
        'id, customer_id, status, currency, amount_total_cents, paid, stripe_customer_id, title'
      )
      .eq('id', invoiceId)
      .single();

    if (error || !invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (invoice.customer_id !== customerId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (invoice.status !== 'sent') {
      return res.status(409).json({ error: 'Invoice must be sent before payment' });
    }

    if (invoice.paid || invoice.status === 'paid') {
      return res.status(409).json({ error: 'Invoice already paid' });
    }

    const amount = invoice.amount_total_cents;

    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid invoice amount' });
    }

    // Stripe Customer
    let stripeCustomerId = invoice.stripe_customer_id;

    if (!stripeCustomerId) {
      const existing = await stripe.customers.list({
        email: customerEmail,
        limit: 1,
      });

      const customer =
        existing.data[0] ||
        (await stripe.customers.create({ email: customerEmail }));

      stripeCustomerId = customer.id;
    }

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: stripeCustomerId },
      { apiVersion: '2023-10-16' }
    );

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: (invoice.currency || 'USD').toLowerCase(),
      customer: stripeCustomerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        invoice_id: invoiceId,
        customer_id: customerId,
      },
      description: invoice.title
        ? `Invoice: ${invoice.title}`
        : 'SMC Invoice Payment',
    });

    await supabase
      .from('invoices')
      .update({
        stripe_payment_intent_id: intent.id,
        stripe_customer_id: stripeCustomerId,
        last_payment_error: null,
        last_stripe_event: 'payment_intent.created',
        updated_at: new Date().toISOString(),
      })
      .eq('id', invoiceId);

    res.json({
      clientSecret: intent.client_secret,
      customerId: stripeCustomerId,
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (err) {
    console.error('❌ create-payment-intent:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🔔 STRIPE WEBHOOK (Source of Truth)
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

  const updateInvoice = async (intentId, updates) => {
    await supabase
      .from('invoices')
      .update({
        ...updates,
        last_stripe_event: event.type,
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_payment_intent_id', intentId);
  };

  try {
    const intent = event.data.object;

    if (event.type === 'payment_intent.succeeded') {
      await updateInvoice(intent.id, {
        status: 'paid',
        paid: true,
        paid_at: new Date().toISOString(),
        last_payment_error: null,
      });
    }

    if (event.type === 'payment_intent.processing') {
      // Keep status as 'sent'
      await updateInvoice(intent.id, {});
    }

    if (event.type === 'payment_intent.payment_failed') {
      await updateInvoice(intent.id, {
        last_payment_error:
          intent.last_payment_error?.message || 'Payment failed',
        paid: false,
        paid_at: null,
      });
    }

    if (event.type === 'payment_intent.canceled') {
      await updateInvoice(intent.id, {
        last_payment_error: 'Payment canceled',
        paid: false,
        paid_at: null,
      });
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
  console.log(`🚀 SMC Stripe server running on port ${PORT}`)
);