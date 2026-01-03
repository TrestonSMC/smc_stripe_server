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

const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

// ===============================
// 🧠 Supabase Setup (Service Role)
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===============================
// 🚀 App Setup
// ===============================
const app = express();
app.use(cors());

// Stripe webhook must use RAW body
app.use('/webhooks/stripe', bodyParser.raw({ type: 'application/json' }));
app.use(express.json());

// ===============================
// 🏠 Root
// ===============================
app.get('/', (_, res) => res.send('🚀 Stripe + Supabase backend is live'));

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
// 🔎 Helper: Find/Create Stripe Customer
// ===============================
async function getOrCreateCustomerByEmail(customerEmail) {
  const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];

  return stripe.customers.create({
    email: customerEmail,
    name: customerEmail?.split('@')[0],
  });
}

// ===============================
// 💳 Create PaymentIntent for an INVOICE (Supabase invoice is source of truth)
// ===============================
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { customerId, customerEmail, invoiceId } = req.body;

    if (!customerId) return res.status(400).json({ error: 'Missing customerId' });
    if (!customerEmail) return res.status(400).json({ error: 'Missing customerEmail' });
    if (!invoiceId) return res.status(400).json({ error: 'Missing invoiceId' });

    // Pull invoice from Supabase (authoritative)
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select('id, customer_id, amount, status')
      .eq('id', invoiceId)
      .maybeSingle();

    if (invErr) throw invErr;
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.customer_id !== customerId) {
      return res.status(403).json({ error: 'Invoice does not belong to this user' });
    }
    if (invoice.status === 'paid') {
      return res.status(409).json({ error: 'Invoice already paid' });
    }

    const amountCents = Math.round(Number(invoice.amount) * 100);
    if (!amountCents || amountCents < 50) {
      return res.status(400).json({ error: 'Invalid invoice amount' });
    }

    const customer = await getOrCreateCustomerByEmail(customerEmail);

    // Ephemeral key for PaymentSheet
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2023-10-16' }
    );

    // PaymentIntent supports Card + ACH (us_bank_account)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customer.id,

      // ACH + Card
      payment_method_types: ['card', 'us_bank_account'],

      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'always',
      },

      receipt_email: customerEmail,

      metadata: {
        user_id: customerId,
        invoice_id: invoiceId,
      },
    });

    // Save PI id on invoice (helps debugging + webhook backup)
    await supabase
      .from('invoices')
      .update({ payment_intent_id: paymentIntent.id })
      .eq('id', invoiceId);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      customerId: customer.id,
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (err) {
    console.error('❌ create-payment-intent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// 🔔 STRIPE WEBHOOK (backup safety net)
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

  try {
    // ✅ Success (card or ACH when Stripe marks it succeeded)
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const invoiceId = intent.metadata?.invoice_id;

      if (invoiceId) {
        // mark paid (if not already)
        await supabase
          .from('invoices')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            payment_method: intent.payment_method_types?.[0] ?? null,
            payment_intent_id: intent.id,
          })
          .eq('id', invoiceId);

        // award points if not already
        await supabase.rpc('award_points_for_invoice', { p_invoice_id: invoiceId });
      }
    }

    // ❌ Failure (ACH can fail later) — rollback points
    if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object;
      const invoiceId = intent.metadata?.invoice_id;

      if (invoiceId) {
        await supabase
          .from('invoices')
          .update({
            status: 'unpaid',
            payment_method: intent.payment_method_types?.[0] ?? null,
            payment_intent_id: intent.id,
          })
          .eq('id', invoiceId);

        await supabase.rpc('reverse_points_for_invoice', { p_invoice_id: invoiceId });
      }
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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));





