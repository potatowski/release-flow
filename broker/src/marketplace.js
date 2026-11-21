const encoder = new TextEncoder();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function signature(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * POST /marketplace: receives GitHub Marketplace webhook events.
 * The only plan is free, so there is nothing to provision: the signature is
 * checked, the action is logged and nothing is stored.
 */
export async function handleMarketplace(request, { secret }) {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!secret) {
    console.error('MARKETPLACE_WEBHOOK_SECRET is not set');
    return json(503, { error: 'Webhook not configured' });
  }

  const body = await request.text();
  const expected = await signature(secret, body);
  if (!timingSafeEqual(request.headers.get('x-hub-signature-256') || '', expected)) {
    return json(401, { error: 'Invalid signature' });
  }

  const event = request.headers.get('x-github-event');
  if (event === 'ping') return json(200, { ok: true });
  if (event !== 'marketplace_purchase') return json(202, { ignored: event });

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const plan = payload.marketplace_purchase?.plan?.name;
  console.log(`marketplace_purchase: ${payload.action} (plan: ${plan})`);
  return json(200, { ok: true });
}
