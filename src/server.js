import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ZomatoBrowser } from './browser.js';
import { JsonStore, ServiceError, token, sameSecret } from './security.js';
import { toolResult, toolError, toolMessageDecorator } from './responses.js';

process.umask(0o077);
const config = {
  port: Number(process.env.PORT || 9320),
  dataDir: process.env.DATA_DIR || './data',
  publicOrigin: process.env.PUBLIC_ORIGIN,
  mobile: process.env.ZOMATO_MOBILE,
  restaurantId: process.env.ZOMATO_RESTAURANT_ID,
  outletName: process.env.ZOMATO_OUTLET_NAME,
  mcpToken: process.env.MCP_TOKEN,
  ownerKey: process.env.OWNER_KEY,
  headless: process.env.BROWSER_HEADLESS !== 'false',
};
let publicUrl;
try {
  publicUrl = new URL(config.publicOrigin);
} catch {
  throw Error('Required configuration missing or invalid');
}
if (
  publicUrl.protocol !== 'https:' ||
  publicUrl.pathname !== '/' ||
  publicUrl.search ||
  publicUrl.hash ||
  config.publicOrigin !== publicUrl.origin ||
  !/^\d{10}$/.test(config.mobile || '') ||
  !/^\d{6,15}$/.test(config.restaurantId || '') ||
  !config.outletName ||
  [config.mcpToken, config.ownerKey].some((v) => !v || v.length < 32) ||
  !Number.isInteger(config.port) ||
  config.port < 1024 ||
  config.port > 65535
)
  throw Error('Required configuration missing or invalid');
const browser = new ZomatoBrowser(config, new JsonStore(config.dataDir));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  const host = publicUrl.host;
  if (![host, `127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(req.headers.host))
    return res.sendStatus(403);
  if (req.headers.origin && req.headers.origin !== config.publicOrigin) return res.sendStatus(403);
  next();
});
app.use(express.json({ limit: '8kb' }));
const sessions = new Map();
const attempts = new Map();
const responseError = (error, res) =>
  res.status(error instanceof ServiceError ? 409 : 503).json({
    error: error.code || 'SITE_UNAVAILABLE',
    message:
      error instanceof ServiceError ? error.message : 'Operation failed; check service status.',
  });
const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    responseError(error, res);
  }
};
app.get('/healthz', (_req, res) => res.json({ service: 'zomato-mcp', up: true }));
const here = fileURLToPath(new URL('.', import.meta.url));
for (const [url, file, type] of [
  ['/owner', 'owner.html', 'html'],
  ['/owner.js', 'owner.js', 'js'],
  ['/owner.css', 'owner.css', 'css'],
])
  app.get(url, async (_req, res) => res.type(type).send(await readFile(`${here}${file}`, 'utf8')));
app.post('/owner/session', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((time) => now - time < 600000);
  attempts.set(ip, recent);
  if (recent.length >= 10) return res.sendStatus(429);
  if (!sameSecret(req.body?.key, config.ownerKey)) {
    recent.push(now);
    return res.sendStatus(401);
  }
  const id = token();
  const csrf = token();
  sessions.set(id, { csrf, expiresAt: now + 3600000 });
  res.setHeader(
    'Set-Cookie',
    `zo_owner=${id}; HttpOnly; Secure; SameSite=Strict; Path=/owner; Max-Age=3600`,
  );
  res.json({ csrf });
});
app.use('/owner/api', (req, res, next) => {
  const id = (req.headers.cookie || '')
    .split('; ')
    .find((value) => value.startsWith('zo_owner='))
    ?.slice(9);
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) return res.sendStatus(401);
  if (
    req.method !== 'GET' &&
    (req.headers.origin !== config.publicOrigin ||
      !sameSecret(req.headers['x-csrf-token'], session.csrf))
  )
    return res.sendStatus(403);
  next();
});
app.get(
  '/owner/api/status',
  route(() => browser.status()),
);
app.post(
  '/owner/api/check',
  route(() => browser.queue.run(() => browser.check())),
);
app.post(
  '/owner/api/login/start',
  route(() => browser.queue.run(() => browser.startLogin())),
);
app.post(
  '/owner/api/login/complete',
  route((req) => browser.queue.run(() => browser.submitOtp(req.body?.challengeId, req.body?.otp))),
);
const mcp = () => {
  const server = new McpServer({ name: 'zomato-partner-mcp', version: '0.1.1' });
  const register = (name, description, inputSchema, fn) =>
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const value = await browser.queue.run(() => fn(args));
        return toolResult(value, browser.identity());
      } catch (error) {
        if (['AUTH_REQUIRED', 'ACCOUNT_MISMATCH', 'OUTLET_MISMATCH'].includes(error.code))
          browser.state = error.code;
        return toolError(error, browser.identity(), `${config.publicOrigin}/owner`);
      }
    });
  register('session_status', 'Check Zomato login and expected restaurant identity.', {}, () =>
    browser.check(),
  );
  register(
    'get_availability',
    'Read the current Zomato partner Online/Offline badge. Does not change availability.',
    {},
    () => browser.availability(),
  );
  register(
    'list_orders',
    'Read Zomato order history for an inclusive India date range, with continuation. No customer personal details.',
    {
      dateFrom: z.iso.date().optional(),
      dateTo: z.iso.date().optional(),
      status: z.enum(['DELIVERED', 'REJECTED']).optional(),
      cursor: z.string().optional(),
    },
    (args) => browser.listOrders(args),
  );
  register(
    'get_order',
    'Read a previously discovered order’s items, totals, and status without customer personal details.',
    {
      orderId: z.string().regex(/^\d{6,15}$/),
    },
    ({ orderId }) => browser.order(orderId),
  );
  register(
    'get_sales_report',
    'Read the Zomato business report with its returned outlet scope and actual period labels. No report settings are changed.',
    {},
    () => browser.salesReport(),
  );
  return server;
};
app.use('/mcp', (req, res, next) => {
  if (!sameSecret(req.headers.authorization, `Bearer ${config.mcpToken}`)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="zomato"');
    return res.sendStatus(401);
  }
  next();
});
app.post('/mcp', async (req, res) => {
  const server = mcp();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const send = transport.send.bind(transport);
  const decorate = toolMessageDecorator(req.body, () => browser.identity());
  transport.send = (message, options) => send(decorate(message), options);
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) responseError(error, res);
  }
});
app.all('/mcp', (_req, res) => res.sendStatus(405));
app.use((_error, _req, res, _next) => res.status(400).json({ error: 'INVALID_REQUEST' }));
await browser.start();
app.listen(config.port, '127.0.0.1', () =>
  console.log(JSON.stringify({ event: 'service_started', port: config.port })),
);
const timer = setInterval(() => {
  for (const [id, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(id);
  for (const [ip, values] of attempts)
    if (values.every((time) => Date.now() - time > 600000)) attempts.delete(ip);
  if (!browser.challenge || browser.challenge.expiresAt <= Date.now())
    void browser.queue.run(() => browser.check()).catch(() => {});
}, 15 * 60000);
timer.unref();
