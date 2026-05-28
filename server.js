require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Database Setup ───────────────────────────────────────────────
async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      device_id VARCHAR(255) PRIMARY KEY,
      free_analyses_used INTEGER DEFAULT 0,
      stripe_customer_id VARCHAR(255),
      subscription_status VARCHAR(50) DEFAULT 'free',
      subscription_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}

// ─── Helper: Get or create user ───────────────────────────────────
async function getOrCreateUser(deviceId) {
  let result = await pool.query(
    'SELECT * FROM users WHERE device_id = $1',
    [deviceId]
  );
  if (result.rows.length === 0) {
    result = await pool.query(
      'INSERT INTO users (device_id) VALUES ($1) RETURNING *',
      [deviceId]
    );
  }
  return result.rows[0];
}

// ─── Helper: Check if user can analyze ────────────────────────────
function canAnalyze(user) {
  const FREE_LIMIT = 3;
  if (user.subscription_status === 'active') return { allowed: true, reason: 'subscribed' };
  if (user.free_analyses_used < FREE_LIMIT) {
    return {
      allowed: true,
      reason: 'free_trial',
      remaining: FREE_LIMIT - user.free_analyses_used
    };
  }
  return { allowed: false, reason: 'limit_reached' };
}

// ─── Route: Check user status ─────────────────────────────────────
app.post('/api/status', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const user = await getOrCreateUser(deviceId);
    const access = canAnalyze(user);

    res.json({
      subscriptionStatus: user.subscription_status,
      freeAnalysesUsed: user.free_analyses_used,
      freeAnalysesTotal: 3,
      canAnalyze: access.allowed,
      reason: access.reason,
      remaining: access.remaining || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Route: Analyze bill ──────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { deviceId, billType, billText, imageBase64, mediaType } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const user = await getOrCreateUser(deviceId);
    const access = canAnalyze(user);

    if (!access.allowed) {
      return res.status(403).json({
        error: 'limit_reached',
        message: 'Free trial used. Please subscribe to continue.',
        freeAnalysesUsed: user.free_analyses_used,
      });
    }

    const prompt = `You are an expert bill analyst. Analyze the following ${billType} bill and respond ONLY with a valid JSON object (no markdown, no backticks, no extra text).

JSON structure:
{
  "summary": {
    "total": "$XXX.XX",
    "flagCount": N,
    "potentialSavings": "$XXX.XX",
    "billType": "string"
  },
  "lineItems": [
    {"name": "string", "amount": "$XX.XX", "status": "ok|warn|flag", "explanation": "plain English 1-2 sentences"}
  ],
  "flags": [
    {"issue": "string", "severity": "high|medium|low", "detail": "string"}
  ],
  "disputes": [
    {"title": "string", "action": "string"}
  ],
  "glossary": [
    {"term": "string", "definition": "string"}
  ]
}

Rules: 4-8 lineItems, 2-4 flags, 2-3 disputes, 3-5 glossary terms. Write for non-expert readers.`;

    let messages;
    if (imageBase64 && mediaType) {
      const isImage = mediaType.startsWith('image/');
      messages = [{
        role: 'user',
        content: [
          isImage
            ? { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } }
            : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      }];
    } else {
      messages = [{ role: 'user', content: `${prompt}\n\nBill content:\n${billText}` }];
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages,
    });

    const raw = response.content.map(c => c.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(clean);

    // Increment free usage if on trial
    if (access.reason === 'free_trial') {
      await pool.query(
        'UPDATE users SET free_analyses_used = free_analyses_used + 1, updated_at = NOW() WHERE device_id = $1',
        [deviceId]
      );
    }

    res.json({
      analysis,
      freeAnalysesUsed: user.free_analyses_used + (access.reason === 'free_trial' ? 1 : 0),
      freeAnalysesTotal: 3,
      subscriptionStatus: user.subscription_status,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
});

// ─── Route: Create Stripe checkout session ────────────────────────
app.post('/api/subscribe', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const user = await getOrCreateUser(deviceId);

    // Get or create Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { deviceId },
      });
      customerId = customer.id;
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE device_id = $2',
        [customerId, deviceId]
      );
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Explain My Bill — Monthly',
            description: 'Unlimited bill analysis powered by Claude AI',
          },
          unit_amount: 299, // $2.99
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/cancel`,
      metadata: { deviceId },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// ─── Route: Stripe webhook ────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const deviceId = session.metadata.deviceId;
        await pool.query(
          'UPDATE users SET subscription_status = $1, subscription_id = $2, updated_at = NOW() WHERE device_id = $3',
          ['active', session.subscription, deviceId]
        );
        break;
      }
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused': {
        const sub = event.data.object;
        await pool.query(
          'UPDATE users SET subscription_status = $1, updated_at = NOW() WHERE subscription_id = $2',
          ['cancelled', sub.id]
        );
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await pool.query(
          'UPDATE users SET subscription_status = $1, updated_at = NOW() WHERE stripe_customer_id = $2',
          ['past_due', invoice.customer]
        );
        break;
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// ─── Route: Cancel subscription ───────────────────────────────────
app.post('/api/cancel', async (req, res) => {
  try {
    const { deviceId } = req.body;
    const user = await getOrCreateUser(deviceId);

    if (user.subscription_id) {
      await stripe.subscriptions.cancel(user.subscription_id);
      await pool.query(
        'UPDATE users SET subscription_status = $1, updated_at = NOW() WHERE device_id = $2',
        ['cancelled', deviceId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not cancel subscription' });
  }
});

// ─── Route: Health check ──────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ─── Start server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
setupDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
/ /   v 2   -   f r e s h   d e p l o y  
 / /   v 2  
 