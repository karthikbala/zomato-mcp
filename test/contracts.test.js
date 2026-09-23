import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  dateRange,
  normalizeHistory,
  normalizeOrderDetail,
  parseBusinessReport,
} from '../src/data.js';
import { readCursor, signedCursor, ServiceError } from '../src/security.js';
import { ZomatoBrowser } from '../src/browser.js';
import { PortalSession, accountRedirect } from '../src/portal-session.js';
import { toolResult, toolError, toolMessageDecorator } from '../src/responses.js';

const snippet = (id) => ({
  id,
  primaryTag: { label: { text: '<semibold-200|{white-500|DELIVERED}>' } },
  topRightText: { text: '<regular-200|{grey-500|9:02 AM | 23 September}>' },
  infoList: [
    { leftText: { text: `<medium-200|{black-500|ID: ${id}}>` }, rightText: { text: 'By Someone' } },
    {
      leftText: { text: '<regular-200|{grey-500|1 x Example Drink}>' },
      rightText: { text: '<regular-200|{grey-500|₹149.23}>' },
    },
  ],
});

test('India date filters use an exclusive end and reject impossible or broad ranges', () => {
  assert.deepEqual(dateRange('2026-09-22', '2026-09-23'), {
    from: '2026-09-22',
    to: '2026-09-23',
    createdAt: '2026-09-22,2026-09-24',
  });
  assert.equal(dateRange('2026-12-31', '2026-12-31').createdAt, '2026-12-31,2027-01-01');
  for (const [from, to] of [
    ['2026-02-30', '2026-03-01'],
    ['2026-09-24', '2026-09-23'],
    ['2026-08-01', '2026-09-23'],
  ])
    assert.throws(() => dateRange(from, to), ServiceError);
});

test('order history parses source labels without exposing customer names or inventing completeness', () => {
  const result = normalizeHistory({
    hasMore: true,
    postbackParams: 'opaque-next',
    snippets: [snippet(12345678)],
  });
  assert.deepEqual(result.orders[0], {
    orderId: '12345678',
    status: 'DELIVERED',
    timeLabel: '9:02 AM | 23 September',
    itemSummary: '1 x Example Drink',
    displayedBill: '₹149.23',
    source: 'zomato_order_history',
  });
  assert.ok(!JSON.stringify(result).includes('Someone'));
  assert.throws(
    () => normalizeHistory({ hasMore: true, postbackParams: '', snippets: [] }),
    /History continuation/,
  );
});

test('order detail validates outlet/order binding and rounds upstream float artifacts', () => {
  const source = {
    status: 'success',
    order: {
      id: '12345678',
      resId: '87654321',
      state: 'DELIVERED',
      createdAt: '2026-09-23T03:32:00Z',
      updatedAt: '2026-09-23T03:45:00Z',
      creator: { name: 'Private customer', address: 'Private address' },
      cartDetails: {
        items: {
          dishes: [
            {
              id: '10',
              name: 'Example Drink',
              quantity: 1,
              unitCost: 161.899994,
              totalCost: 161.899994,
              customisations: [{ name: 'Dark Roast', quantity: 1, totalCost: 0 }],
            },
          ],
        },
        subtotal: { amountDetails: { totalCost: 161.899994 } },
        total: { amountDetails: { totalCost: 149.233994 } },
        charges: [
          { amountDetails: { itemName: 'Packaging', totalCost: 10, displayCost: '₹10.00' } },
        ],
        discountApplied: {
          discounts: [{ discount: { name: 'Offer', totalDiscountAmount: -22.6700001 } }],
        },
      },
      paymentDetails: { paymentMethod: 'ONLINE' },
    },
  };
  const value = normalizeOrderDetail(source, '12345678', '87654321');
  assert.equal(value.items[0].totalPrice, 161.9);
  assert.equal(value.amounts.totalBill, 149.23);
  assert.equal(value.amounts.discounts[0].amount, -22.67);
  assert.ok(!JSON.stringify(value).includes('Private'));
  assert.throws(() => normalizeOrderDetail(source, '1', '87654321'), /ORDER_SCHEMA_CHANGED/);
  assert.throws(() => normalizeOrderDetail(source, '12345678', '999999'), /ORDER_SCHEMA_CHANGED/);
});

test('signed cursors reject tampering and SDK errors carry identity in batches', () => {
  const key = 'a-private-installation-key';
  const cursor = signedCursor({ restaurantId: '87654321', postback: 'opaque' }, key);
  assert.deepEqual(readCursor(cursor, key), { restaurantId: '87654321', postback: 'opaque' });
  assert.throws(() => readCursor(`${cursor}x`, key), ServiceError);
  const identity = { account: { reference: 'synthetic' }, verification: 'unverified' };
  const decorate = toolMessageDecorator(
    [
      { id: 0, method: 'tools/call' },
      { id: 1, method: 'tools/list' },
    ],
    () => identity,
  );
  const invalid = decorate({
    id: 0,
    result: { isError: true, content: [{ type: 'text', text: 'Invalid input' }] },
  });
  assert.deepEqual(invalid.result.structuredContent.identity, identity);
  assert.equal(decorate({ id: 1, result: { tools: [] } }).result.structuredContent, undefined);
  assert.deepEqual(toolResult({ orders: [] }, identity).structuredContent.identity, identity);
  assert.equal(toolError(new ServiceError('AUTH_REQUIRED'), identity, '/owner').isError, true);
});

test('pagination signs source continuation and discovers only returned order IDs', async () => {
  const values = {};
  const store = {
    async read(k, fallback) {
      return structuredClone(values[k] ?? fallback);
    },
    async write(k, v) {
      values[k] = structuredClone(v);
    },
  };
  const browser = new ZomatoBrowser({ restaurantId: '87654321', mobile: '0000000000' }, store);
  browser.identityKey = 'key';
  browser.requireReady = async () => {};
  const bodies = [];
  browser.portal = {
    read: async (_url, options) => {
      bodies.push(options.data);
      return bodies.length === 1
        ? { hasMore: true, postbackParams: 'next', snippets: [snippet(12345678)] }
        : { hasMore: false, postbackParams: '', snippets: [snippet(12345679)] };
    },
  };
  const first = await browser.listOrders({ dateFrom: '2026-09-22', dateTo: '2026-09-23' });
  assert.equal(first.pagination.complete, false);
  assert.equal(bodies[0].created_at, '2026-09-22,2026-09-24');
  assert.equal(bodies[0].res_Id, '87654321');
  assert.deepEqual(Object.keys(values['discovered-orders'].ids), ['12345678']);
  const second = await browser.listOrders({ cursor: first.pagination.nextCursor });
  assert.equal(bodies[1].postback_params, 'next');
  assert.equal(second.pagination.complete, true);
  assert.deepEqual(Object.keys(values['discovered-orders'].ids).sort(), ['12345678', '12345679']);
});

test('business report binds the outlet and preserves actual periods when requested dates are ignored', () => {
  const source = {
    meta: { selected_res_ids: [87654321] },
    filters: { selected_filters: { outlet: 87654321, time: 'ist_isoweek' } },
    data: {
      column_headers: [
        { accessor: 'metric' },
        { accessor: 'trend' },
        {
          accessor: '2026_39',
          header: { value: 'Week 39' },
          subheader: { value: '21 - 22 Sep 2026' },
        },
        { accessor: 'growth' },
      ],
      sections: [
        {
          row_data: [
            { metric: { value: 'Sales' }, '2026_39': { value: '₹500' } },
            { metric: { value: 'Delivered orders' }, '2026_39': { value: '2' } },
          ],
        },
      ],
    },
  };
  const report = parseBusinessReport(source, '87654321');
  assert.equal(report.periods[0].label, 'Week 39 21 - 22 Sep 2026');
  assert.equal(report.selectedTimeFilter, 'ist_isoweek');
  assert.equal(report.periods[0].metrics.Sales, '₹500');
  assert.throws(() => parseBusinessReport(source, '99999999'), /OUTLET_MISMATCH/);
  source.meta.selected_res_ids.push(99999999);
  assert.throws(() => parseBusinessReport(source, '87654321'), /OUTLET_MISMATCH/);
});

test('OAuth rejects external redirects and a callback with the wrong state before exchanging credentials', async () => {
  for (const value of [
    'https://attacker.example/zoauth/callback',
    'http://accounts.zomato.com/zoauth/callback',
    'https://user@accounts.zomato.com/zoauth/callback',
    'https://accounts.zomato.com/signout',
  ])
    assert.throws(() => accountRedirect(value), /AUTH_REDIRECT_INVALID/);
  let posted = false;
  const session = new PortalSession(
    {
      request: {
        get: async () => ({
          status: () => 200,
          ok: () => true,
          url: () => 'https://accounts.zomato.com/zoauth/callback?state=wrong&code=fake',
        }),
        post: async () => {
          posted = true;
        },
      },
    },
    {},
    {},
  );
  session.challenge = {
    id: 'test',
    state: 'expected',
    redirect: 'https://accounts.zomato.com/oauth2/auth',
    expiresAt: Date.now() + 10000,
  };
  await assert.rejects(() => session.submitOtp('test', '123456'), /AUTH_STATE_MISMATCH/);
  assert.equal(posted, false);
});

test('account substitution fails closed even when another account can access the same restaurant', async () => {
  const browser = new ZomatoBrowser(
    { mobile: '0000000000', restaurantId: '87654321', outletName: 'Example Cafe' },
    {
      read: async () => 'original-account',
    },
  );
  browser.identityKey = 'synthetic-key';
  browser.portal = { read: async () => ({ loggedIn: true, userId: 'different-account' }) };
  const status = await browser.check();
  assert.equal(status.state, 'ACCOUNT_MISMATCH');
  assert.equal(status.identity.verification, 'unverified');
});

test('OTP login binds PKCE and state, follows consent, and saves cookies without saving the OTP', async () => {
  const cookieJar = [];
  const saved = [];
  let oauthState;
  let challengeHash;
  let verifying = false;
  let consented = false;
  const response = (url, body = {}, status = 200, location) => ({
    url: () => url,
    ok: () => status === 200,
    status: () => status,
    json: async () => body,
    headers: () => (location ? { location } : {}),
  });
  const context = {
    cookies: async () => cookieJar,
    addCookies: async (cookies) => cookieJar.push(...cookies),
    request: {
      get: async (address) => {
        const url = new URL(address);
        if (url.pathname === '/oauth2/auth') {
          if (!verifying) {
            oauthState = url.searchParams.get('state');
            challengeHash = url.searchParams.get('code_challenge');
            return response(address, {}, 302, '/zoauth/login?login_challenge=synthetic');
          }
          return response(
            address,
            {},
            302,
            consented
              ? `/zoauth/callback?code=synthetic&state=${oauthState}&scope=offline%20openid`
              : '/zoauth/consent?consent_challenge=synthetic',
          );
        }
        return response(address);
      },
      post: async (address, options) => {
        const path = new URL(address).pathname;
        if (path === '/login/phone') {
          if (options.multipart.type === 'initiate') return response(address, { status: true });
          assert.equal(options.multipart.otp, '123456');
          verifying = true;
          return response(address, {
            status: true,
            redirect_to: '/oauth2/auth?login_verifier=synthetic',
          });
        }
        if (path === '/consent') {
          assert.equal(options.multipart.cc, 'synthetic');
          consented = true;
          return response(address, {
            status: true,
            redirect_to: '/oauth2/auth?consent_verifier=synthetic',
          });
        }
        assert.equal(path, '/callback');
        assert.equal(options.multipart.state, oauthState);
        assert.equal(options.multipart.scope, 'offline openid');
        return response(address, { status: true });
      },
    },
  };
  const session = new PortalSession(
    context,
    { mobile: '0000000000' },
    {
      write: async (_name, value) => saved.push(structuredClone(value)),
    },
  );
  const challenge = await session.startLogin();
  const verifier = cookieJar.find((cookie) => cookie.name === 'zxcv').value;
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), challengeHash);
  await session.submitOtp(challenge.challengeId, '123456');
  assert.equal(session.challenge, null);
  assert.equal(saved.length, 1);
  assert.ok(!JSON.stringify(saved).includes('123456'));
});

test('OAuth never follows a redirect to another host', async () => {
  let calls = 0;
  const session = new PortalSession(
    {
      request: {
        get: async () => {
          calls++;
          return {
            status: () => 302,
            headers: () => ({ location: 'https://attacker.example/collect' }),
          };
        },
      },
    },
    {},
    {},
  );
  session.challenge = {
    id: 'test',
    state: 'expected',
    redirect: 'https://accounts.zomato.com/oauth2/auth',
    expiresAt: Date.now() + 10000,
  };
  await assert.rejects(() => session.submitOtp('test', '123456'), /AUTH_REDIRECT_INVALID/);
  assert.equal(calls, 1);
});

test('session renewal restores expired SDK client context and persists rotated cookies', async () => {
  let cookies = [];
  let saved;
  const session = new PortalSession(
    {
      addCookies: async (values) => {
        cookies = values;
      },
      cookies: async () => [...cookies, { name: 'synthetic-refresh', value: 'rotated' }],
      request: {
        post: async (url) => {
          assert.equal(url, 'https://accounts.zomato.com/token/refresh');
          assert.equal(cookies.find((c) => c.name === 'purl').value, 'https://www.zomato.com');
          assert.ok(cookies.find((c) => c.name === 'cid').expires > Date.now() / 1000 + 30000000);
          return { status: () => 200, ok: () => true, json: async () => ({ status: true }) };
        },
      },
    },
    {},
    {
      write: async (_name, value) => {
        saved = value;
      },
    },
  );
  session.headers = { stale: 'csrf' };
  await session.refresh();
  assert.equal(session.headers, null);
  assert.equal(saved.at(-1).value, 'rotated');
});
