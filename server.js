require('dotenv').config({ path: './.env' });

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

// ⚠️ Stripe webhook must use RAW body
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
// 🏠 Root
// ===============================
app.get('/', (_, res) => res.send('🚀 Stripe backend live'));

// ============================================================
// 💳 CREATE PAYMENT INTENT (Invoice Payment)
// ✅ SINGLE TABLE: reads + writes only invoices
// ============================================================
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { invoiceId, customerId, customerEmail } = req.body;

    if (!invoiceId || !customerId) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    // 0) Load invoice (source of truth)
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select(
        'id, customer_id, status, currency, amount_total_cents, paid, stripe_customer_id, stripe_payment_intent_id, title'
      )
      .eq('id', invoiceId)
      .single();

    if (invErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });

    // 1) Ownership check
    if (invoice.customer_id !== customerId) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // 2) Must be sent to pay (industry standard)
    if (invoice.status !== 'sent') {
      return res.status(409).json({ error: 'Invoice must be sent before payment' });
    }

    // 3) Block duplicate payments
    if (invoice.paid === true || invoice.status === 'paid') {
      return res.status(409).json({ error: 'Invoice already paid' });
    }

    // 4) Validate amount
    const amount = invoice.amount_total_cents;
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invoice has invalid total amount' });
    }

    // 5) Stripe customer (reuse if saved)
    let stripeCustomerId = invoice.stripe_customer_id || null;

    if (!stripeCustomerId) {
      if (customerEmail) {
        const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
        const customer =
          existing.data[0] || (await stripe.customers.create({ email: customerEmail }));
        stripeCustomerId = customer.id;
      } else {
        const customer = await stripe.customers.create({});
        stripeCustomerId = customer.id;
      }
    }

    // 6) Ephemeral key (for PaymentSheet)
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: stripeCustomerId },
      { apiVersion: '2023-10-16' }
    );

    // 7) PaymentIntent
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: String(invoice.currency || 'USD').toLowerCase(), // "usd"
      customer: stripeCustomerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        invoice_id: invoiceId,
        customer_id: customerId,
      },
      description: invoice.title ? `Invoice: ${invoice.title}` : `Invoice Payment`,
    });

    // 8) Save Stripe IDs back to invoice
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

    return res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      customerId: stripeCustomerId,
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (err) {
    console.error('❌ create-payment-intent:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🔔 STRIPE WEBHOOK (SOURCE OF TRUTH)
// ✅ SINGLE TABLE: updates only invoices
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

  try {
    const updateInvoiceByIntent = async (intentId, patch) => {
      if (!intentId) return;
      const { error } = await supabase
        .from('invoices')
        .update({ ...patch, last_stripe_event: event.type, updated_at: new Date().toISOString() })
        .eq('stripe_payment_intent_id', intentId);

      if (error) console.error('❌ invoice update error:', error);
    };

    // ✅ SUCCEEDED (card OR ACH cleared)
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      await updateInvoiceByIntent(intent.id, {
        status: 'paid',
        paid: true,
        paid_at: new Date().toISOString(),
        last_payment_error: null,
      });
      return res.json({ received: true });
    }

    // ⏳ PROCESSING (ACH often sits here) -> keep status as "sent"
    // You said you want only your enum statuses; you don't have "processing",
    // so we store info in last_stripe_event and keep invoice.status unchanged.
    if (event.type === 'payment_intent.processing') {
      const intent = event.data.object;
      await updateInvoiceByIntent(intent.id, {
        // status unchanged (sent)
        last_payment_error: null,
      });
      return res.json({ received: true });
    }

    // ❌ FAILED
    if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object;
      const msg =
        intent.last_payment_error?.message ||
        intent.last_payment_error?.decline_code ||
        'Payment failed';

      await updateInvoiceByIntent(intent.id, {
        // keep as "sent" so they can try again
        last_payment_error: msg,
        paid: false,
        paid_at: null,
      });
      return res.json({ received: true });
    }

    // ❌ CANCELED
    if (event.type === 'payment_intent.canceled') {
      const intent = event.data.object;
      await updateInvoiceByIntent(intent.id, {
        last_payment_error: 'Payment canceled',
        paid: false,
        paid_at: null,
      });
      return res.json({ received: true });
    }

    // ignore other events
    return res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook handler error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ===============================
// ▶️ Start Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Stripe server running on port ${PORT}`));