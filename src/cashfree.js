// Thin client for Cashfree PG (payment links + webhooks). Test mode only.
import crypto from 'node:crypto';

function base() {
  return process.env.CASHFREE_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

function headers() {
  const id = process.env.CASHFREE_CLIENT_ID;
  const secret = process.env.CASHFREE_CLIENT_SECRET;
  if (!id || !secret) throw new Error('CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET not set in .env');
  return {
    'content-type': 'application/json',
    'x-client-id': id,
    'x-client-secret': secret,
    'x-api-version': process.env.CASHFREE_API_VERSION || '2026-01-01',
  };
}

async function call(path, init = {}) {
  const res = await fetch(base() + path, { ...init, headers: headers() });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Cashfree ${path} ${res.status}: ${text}`);
  return body;
}

// Create a payment link. Set minPartial to allow part payment with a minimum first amount.
export async function createPaymentLink({ linkId, amount, purpose, customer, minPartial, expiresInHours = 72, notes = {} }) {
  const expiry = new Date(Date.now() + expiresInHours * 3600_000).toISOString();
  const body = {
    link_id: linkId,
    link_amount: amount,
    link_currency: 'INR',
    link_purpose: purpose,
    customer_details: {
      customer_name: customer.name,
      customer_phone: customer.phone,
      ...(customer.email ? { customer_email: customer.email } : {}),
    },
    link_partial_payments: Boolean(minPartial),
    ...(minPartial ? { link_minimum_partial_amount: minPartial } : {}),
    link_expiry_time: expiry,
    // Sandbox only delivers email notifications; SMS/WhatsApp work in production only.
    link_notify: { send_sms: true, send_email: Boolean(customer.email) },
    link_notes: notes,
    ...(process.env.PUBLIC_URL ? { link_meta: { notify_url: `${process.env.PUBLIC_URL}/webhooks/cashfree` } } : {}),
  };
  return call('/links', { method: 'POST', body: JSON.stringify(body) });
}

// Link status: ACTIVE | PAID | PARTIALLY_PAID | EXPIRED | CANCELLED
export async function getPaymentLink(linkId) {
  return call(`/links/${encodeURIComponent(linkId)}`);
}

export async function cancelPaymentLink(linkId) {
  return call(`/links/${encodeURIComponent(linkId)}/cancel`, { method: 'POST' });
}

// Webhook signature: base64(HMAC_SHA256(timestamp + rawBody, clientSecret))
export function verifyWebhook(rawBody, timestamp, signature) {
  if (!timestamp || !signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.CASHFREE_CLIENT_SECRET || '')
    .update(timestamp + rawBody)
    .digest('base64');
  return expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
