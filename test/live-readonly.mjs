import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = process.env.PUBLIC_ORIGIN;
const token = process.env.MCP_TOKEN;
if (!origin?.startsWith('https://') || !token)
  throw Error('Set PUBLIC_ORIGIN and MCP_TOKEN in private configuration.');
const client = new Client({ name: 'zomato-readonly-smoke', version: '0.1.0' });
let reference;
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  assert.equal(result.isError, undefined, `${name} failed; inspect owner status and private logs.`);
  const value = result.structuredContent;
  assert.ok(value?.identity?.account.reference && value?.identity?.outlet.restaurantId);
  reference ??= value.identity.outlet.reference;
  assert.equal(value.identity.outlet.reference, reference);
  return value;
};
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', origin), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  for (const name of [
    'session_status',
    'get_availability',
    'list_orders',
    'get_order',
    'get_sales_report',
  ])
    assert.ok(names.has(name));
  assert.equal((await call('session_status')).state, 'READY');
  const availability = await call('get_availability');
  assert.ok(['ONLINE', 'OFFLINE'].includes(availability.status));
  const orders = await call('list_orders');
  assert.ok(Array.isArray(orders.orders));
  if (orders.orders.length) {
    const detail = await call('get_order', { orderId: orders.orders[0].orderId });
    assert.equal(detail.orderId, orders.orders[0].orderId);
    assert.ok(Array.isArray(detail.items));
  }
  const report = await call('get_sales_report');
  assert.ok(report.periods.length > 0 && report.periods.every((p) => p.label));
  console.log('Read-only Zomato smoke checks passed. No account payloads were printed.');
} finally {
  await client.close();
}
