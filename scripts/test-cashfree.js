// Smoke test: create a sandbox payment link with part payment, then read its status.
import * as cashfree from '../src/cashfree.js';

const linkId = `smoke-${Date.now()}`;
const link = await cashfree.createPaymentLink({
  linkId,
  amount: 2499,
  purpose: 'Buildathon smoke test',
  customer: { name: 'Test Customer', phone: '9999999999' },
  minPartial: 500,
});
console.log('created:', link.link_id, link.link_status, link.link_url);
const again = await cashfree.getPaymentLink(linkId);
console.log('status:', again.link_status, 'paid:', again.link_amount_paid);
console.log('Cashfree OK');
