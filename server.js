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


// ============================================================
// 🧾 CREATE STRIPE INVOICE (FROM ADMIN DASHBOARD)
// ============================================================
app.post('/create-stripe-invoice', async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) {
      return res.status(400).json({ error: 'Missing invoiceId' });
    }

    // 1️⃣ Fetch invoice + items
    const { data: invoice, error } = await supabase
      .from('invoices')
      .select(`
        id,
        customer_id,
        amount,
        invoice_items (
          description,
          quantity,
          unit_price
        ),
        profiles!invoices_customer_id_fkey (
          email
        )
      `)
      .eq('id', invoiceId)
      .single();

    if (error || !invoice) {
      throw new Error('Invoice not found');
    }

    // 2️⃣ Find or create Stripe customer
    const email = invoice.profiles.email;
    const existing = await stripe.customers.list({ email, limit: 1 });

    const customer =
      existing.data.length > 0
        ? existing.data[0]
        : await stripe.customers.create({ email });

    // 3️⃣ Create Stripe invoice
    const stripeInvoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: 30,
      metadata: {
        supabase_invoice_id: invoice.id,
        user_id: invoice.customer_id,
      },
    });

    // 4️⃣ Add invoice items
    for (const item of invoice.invoice_items) {
      await stripe.invoiceItems.create({
        customer: customer.id,
        invoice: stripeInvoice.id,
        description: item.description,
        quantity: item.quantity,
        unit_amount: Math.round(item.unit_price * 100),
        currency: 'usd',
      });
    }

    // 5️⃣ Finalize invoice
    await stripe.invoices.finalizeInvoice(stripeInvoice.id);

    // 6️⃣ Save Stripe IDs back to Supabase
    await supabase
      .from('invoices')
      .update({
        stripe_invoice_id: stripeInvoice.id,
        stripe_customer_id: customer.id,
      })
      .eq('id', invoice.id);

    res.json({
      success: true,
      stripeInvoiceId: stripeInvoice.id,
    });
  } catch (err) {
    console.error('❌ Stripe invoice create error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// 💳 PAYMENT SHEET FOR STRIPE INVOICE (ACH + CARD)
// ============================================================
app.post('/invoice-payment-sheet', async (req, res) => {
  try {
    const { stripeInvoiceId } = req.body;
    if (!stripeInvoiceId) {
      return res.status(400).json({ error: 'Missing stripeInvoiceId' });
    }

    const invoice = await stripe.invoices.retrieve(stripeInvoiceId);
    if (!invoice.payment_intent) {
      throw new Error('Invoice not payable yet');
    }

    const paymentIntent = await stripe.paymentIntents.update(
      invoice.payment_intent,
      {
        payment_method_types: ['card', 'us_bank_account'],
        setup_future_usage: 'off_session',
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'always',
        },
      }
    );

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: invoice.customer },
      { apiVersion: '2023-10-16' }
    );

    res.json({
      clientSecret: paymentIntent.client_secret,
      customerId: invoice.customer,
      ephemeralKey: ephemeralKey.secret,
    });
  } catch (err) {
    console.error('❌ Invoice payment sheet error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// 🔔 STRIPE WEBHOOK
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
    console.error('❌ Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Invoice paid
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    await supabase
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: new Date(invoice.status_transitions.paid_at * 1000),
      })
      .eq('stripe_invoice_id', invoice.id);
  }

  // Points award (ACH + card)
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const userId = intent.metadata?.user_id;

    if (userId) {
      await supabase.rpc('award_points_for_payment', {
        p_user_id: userId,
        p_amount_cents: intent.amount_received,
      });
    }
  }

  res.json({ received: true });
});

// ===============================
// ▶️ Start Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});


