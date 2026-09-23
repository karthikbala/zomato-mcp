import test from 'node:test';
import assert from 'node:assert/strict';
import { dateRange, normalizeHistory, normalizeOrderDetail, parseSalesTable } from '../src/data.js';
import { readCursor, signedCursor, ServiceError } from '../src/security.js';
import { ZomatoBrowser } from '../src/browser.js';
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

test('sales parser uses rendered weekly labels even if URL claims daily dates', () => {
  const rows = [
    ['Metric', 'Trend', 'Week 38 14 - 20 Sep 2026', 'Week 39 21 - 22 Sep 2026', 'Change'],
    ['Sales overview'],
    ['Sales', 'trend', '₹5,570', '₹3,990', '+133.9%'],
    ['Delivered orders', 'trend', '19', '14', '+133.3%'],
    ['Online %', 'trend', '68.6%', '97.5%', '+7.5%'],
  ];
  const report = parseSalesTable(rows);
  assert.equal(report.periodBasis, 'displayed_labels');
  assert.equal(report.periods[1].label, 'Week 39 21 - 22 Sep 2026');
  assert.equal(report.periods[1].metrics.Sales, '₹3,990');
  assert.equal(report.periods[0].metrics['Online %'], '68.6%');
  assert.throws(() => parseSalesTable([['Metric']]), ServiceError);
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
  browser.apiHeaders = { 'x-zomato-csrft': 'private' };
  browser.historyHeaders = async () => {};
  const bodies = [];
  browser.context = {
    request: {
      post: async (_url, options) => {
        bodies.push(options.data);
        return {
          status: () => 200,
          json: async () =>
            bodies.length === 1
              ? { hasMore: true, postbackParams: 'next', snippets: [snippet(12345678)] }
              : { hasMore: false, postbackParams: '', snippets: [snippet(12345679)] },
        };
      },
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
