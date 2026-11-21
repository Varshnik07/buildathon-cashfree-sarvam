// Relay → AWS Lambda (approved domain) → our server.
// Relay's HTTP actions can only reach approved domains, so this function forwards
// /api/relay/* calls to our server unchanged. Set the TARGET_URL environment variable to our PUBLIC_URL.
// Called through the organisers' router: https://<router>.lambda-url.ap-south-1.on.aws/<function-name>/api/relay/...
export const handler = async (event) => {
  const rawPath = event.rawPath || event.path || event.requestContext?.http?.path || '/';
  const match = rawPath.match(/\/api\/relay\/(context\/[^/?]+|payment-link|outcome)\/?$/);
  if (!match) return reply(404, { error: 'not found', path: rawPath });

  const method = (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  let body = event.body;
  if (body && event.isBase64Encoded) body = Buffer.from(body, 'base64').toString();
  if (body && typeof body === 'object') body = JSON.stringify(body);

  const url = process.env.TARGET_URL.replace(/\/$/, '') + `/api/relay/${match[1]}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      body: method === 'GET' ? undefined : body || '{}',
    });
    return { statusCode: res.status, headers: { 'content-type': 'application/json' }, body: await res.text() };
  } catch (err) {
    console.error('Forward failed', url, err);
    return reply(502, { error: `Could not reach our server: ${err.message}` });
  }
};

const reply = (statusCode, obj) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
