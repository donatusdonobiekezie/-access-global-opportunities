const crypto = require('crypto');

const PLAN_CODE = 'PLN_2j8ccj9c5c402k5';
const PLAN_AMOUNT_KOBO = 499900;
const PLAN_CURRENCY = 'NGN';

module.exports.config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function getCustomerEmail(data) {
  return normalizeEmail(
    data?.customer?.email ||
    data?.customer_email ||
    data?.email ||
    data?.customer?.customer_email
  );
}

function getCustomerCode(data) {
  return data?.customer?.customer_code || data?.customer_code || null;
}

function getSubscriptionCode(data) {
  return data?.subscription_code || data?.subscription?.subscription_code || null;
}

function getPeriodEnd(data) {
  const raw =
    data?.next_payment_date ||
    data?.subscription?.next_payment_date ||
    data?.current_period_end ||
    data?.subscription?.current_period_end ||
    null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function supabaseFetch(path, options = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Missing Supabase server environment variables');

  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function findAuthUserByEmail(email) {
  const wanted = normalizeEmail(email);
  if (!wanted) return null;

  for (let page = 1; page <= 20; page += 1) {
    const data = await supabaseFetch(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const users = Array.isArray(data?.users) ? data.users : [];
    const found = users.find((u) => normalizeEmail(u.email) === wanted);
    if (found) return found;
    if (users.length < 1000) break;
  }
  return null;
}

async function getSubscriptionByUserId(userId) {
  const rows = await supabaseFetch(
    `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=id,user_id,plan,status,paystack_customer_code,paystack_subscription_code,current_period_end&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function upsertSubscription(userId, patch) {
  const existing = await getSubscriptionByUserId(userId);

  if (existing) {
    await supabaseFetch(`/rest/v1/subscriptions?id=eq.${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    return;
  }

  await supabaseFetch('/rest/v1/subscriptions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId, ...patch }),
  });
}

async function fetchPaystackSubscription(code) {
  if (!code) return null;
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('Missing PAYSTACK_SECRET_KEY');

  const response = await fetch(`https://api.paystack.co/subscription/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const data = await response.json();
  if (!response.ok || !data?.status) {
    throw new Error(`Paystack subscription lookup failed: ${JSON.stringify(data)}`);
  }
  return data.data;
}

function extractPlanCode(subscription) {
  const p = subscription?.plan;
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object') return p.plan_code || p.code || p.planCode || null;
  return null;
}

function extractAmount(subscription) {
  const p = subscription?.plan;
  if (p && typeof p === 'object' && Number.isFinite(Number(p.amount))) return Number(p.amount);
  if (Number.isFinite(Number(subscription?.amount))) return Number(subscription.amount);
  return null;
}

async function activateFromSubscription(data) {
  let subscriptionCode = getSubscriptionCode(data);
  let customerCode = getCustomerCode(data);
  let email = getCustomerEmail(data);
  let periodEnd = getPeriodEnd(data);
  let remote = null;

  // Fetch the subscription from Paystack when possible so activation is based on
  // Paystack's current subscription record, not only the webhook payload.
  if (subscriptionCode) {
    remote = await fetchPaystackSubscription(subscriptionCode);
    subscriptionCode = remote?.subscription_code || subscriptionCode;
    customerCode = remote?.customer?.customer_code || customerCode;
    email = normalizeEmail(remote?.customer?.email) || email;
    periodEnd = getPeriodEnd(remote) || periodEnd;

    const remotePlanCode = extractPlanCode(remote);
    const remoteAmount = extractAmount(remote);
    if (remotePlanCode && remotePlanCode !== PLAN_CODE) {
      throw new Error(`Unexpected Paystack plan: ${remotePlanCode}`);
    }
    if (remoteAmount !== null && remoteAmount !== PLAN_AMOUNT_KOBO) {
      throw new Error(`Unexpected Paystack amount: ${remoteAmount}`);
    }
  }

  if (!email) throw new Error('No customer email in Paystack event');

  const user = await findAuthUserByEmail(email);
  if (!user?.id) throw new Error(`No ACCESS account found for ${email}`);

  await upsertSubscription(user.id, {
    plan: 'premium',
    status: 'active',
    paystack_customer_code: customerCode,
    paystack_subscription_code: subscriptionCode,
    current_period_end: periodEnd,
  });

  return { userId: user.id, email, subscriptionCode };
}

async function deactivateFromSubscription(data) {
  const subscriptionCode = getSubscriptionCode(data);
  let email = getCustomerEmail(data);
  let customerCode = getCustomerCode(data);

  if (subscriptionCode) {
    const remote = await fetchPaystackSubscription(subscriptionCode).catch(() => null);
    if (remote) {
      email = normalizeEmail(remote?.customer?.email) || email;
      customerCode = remote?.customer?.customer_code || customerCode;
    }
  }

  if (!email) throw new Error('No customer email in Paystack event');
  const user = await findAuthUserByEmail(email);
  if (!user?.id) return { ignored: true, reason: 'ACCESS account not found' };

  const existing = await getSubscriptionByUserId(user.id);
  if (!existing) return { ignored: true, reason: 'Subscription row not found' };

  await supabaseFetch(`/rest/v1/subscriptions?id=eq.${encodeURIComponent(existing.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'inactive',
      paystack_customer_code: customerCode || existing.paystack_customer_code,
      paystack_subscription_code: subscriptionCode || existing.paystack_subscription_code,
    }),
  });

  return { userId: user.id, email };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const raw = await readRawBody(req);
    const signature = req.headers['x-paystack-signature'];
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return res.status(500).json({ ok: false, error: 'Webhook secret is not configured' });

    const expected = crypto.createHmac('sha512', secret).update(raw).digest('hex');
    if (!safeEqual(signature, expected)) {
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }

    const event = JSON.parse(raw.toString('utf8'));
    const name = event?.event;

    if (name === 'subscription.create') {
      const result = await activateFromSubscription(event.data || {});
      return res.status(200).json({ ok: true, event: name, result });
    }

    if (name === 'subscription.disable') {
      const result = await deactivateFromSubscription(event.data || {});
      return res.status(200).json({ ok: true, event: name, result });
    }

    if (name === 'invoice.payment_failed') {
      const result = await deactivateFromSubscription(event.data || {});
      return res.status(200).json({ ok: true, event: name, result });
    }

    if (name === 'subscription.not_renew') {
      // Keep access active through the already-paid period. The dashboard should
      // use current_period_end when deciding whether premium access has expired.
      return res.status(200).json({ ok: true, event: name, action: 'kept_active_until_period_end' });
    }

    // Other Paystack events are acknowledged so Paystack doesn't retry them.
    return res.status(200).json({ ok: true, ignored: true, event: name || null });
  } catch (error) {
    console.error('Paystack webhook error:', error);
    return res.status(500).json({ ok: false, error: 'Webhook processing failed' });
  }
};
