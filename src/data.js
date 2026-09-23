import { ServiceError } from './security.js';

export function dateRange(from, to) {
  const valid = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  };
  if (!valid(from) || !valid(to) || from > to) throw new ServiceError('INVALID_DATE_RANGE');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (days > 30) throw new ServiceError('DATE_RANGE_TOO_LARGE', 'Select at most 31 calendar days.');
  const exclusiveTo = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { from, to, createdAt: `${from},${exclusiveTo}` };
}
const money = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
const plain = (value) =>
  typeof value === 'string'
    ? (value.match(/^<[^|]*\|\{[^|]*\|([\s\S]*)\}>$/)?.[1] ?? value).replace(/\s+/g, ' ').trim()
    : null;

export function normalizeOrderSnippet(snippet) {
  const id = String(snippet?.id ?? '');
  if (!/^\d{6,15}$/.test(id) || !Array.isArray(snippet.infoList))
    throw new ServiceError('ORDER_SCHEMA_CHANGED');
  const itemText = plain(snippet.infoList[1]?.leftText?.text);
  const billText = plain(snippet.infoList[1]?.rightText?.text);
  return {
    orderId: id,
    status: plain(snippet.primaryTag?.label?.text),
    timeLabel: plain(snippet.topRightText?.text),
    itemSummary: itemText,
    displayedBill: billText,
    source: 'zomato_order_history',
  };
}
export function normalizeHistory(payload) {
  if (
    !payload ||
    typeof payload.hasMore !== 'boolean' ||
    !Array.isArray(payload.snippets) ||
    typeof payload.postbackParams !== 'string'
  )
    throw new ServiceError('ORDER_SCHEMA_CHANGED');
  if (payload.hasMore && !payload.postbackParams)
    throw new ServiceError('ORDER_SCHEMA_CHANGED', 'History continuation is missing.');
  return {
    orders: payload.snippets.map(normalizeOrderSnippet),
    hasMore: payload.hasMore,
    postback: payload.postbackParams,
  };
}
export function normalizeOrderDetail(raw, expectedId, expectedRestaurantId) {
  const order = raw?.order;
  if (
    raw?.status !== 'success' ||
    String(order?.id) !== String(expectedId) ||
    String(order?.resId) !== String(expectedRestaurantId) ||
    !Array.isArray(order?.cartDetails?.items?.dishes)
  )
    throw new ServiceError('ORDER_SCHEMA_CHANGED');
  return {
    orderId: String(order.id),
    restaurantId: String(order.resId),
    status: order.state || null,
    createdAt: order.createdAt || null,
    updatedAt: order.updatedAt || null,
    items: order.cartDetails.items.dishes.map((dish) => ({
      itemId: dish.id ? String(dish.id) : null,
      name: dish.name || null,
      quantity: typeof dish.quantity === 'number' ? dish.quantity : null,
      unitPrice: money(dish.unitCost),
      totalPrice: money(dish.totalCost),
      customisations: (dish.customisations || []).map((item) => ({
        name: item.name || null,
        groupName: item.groupName || null,
        quantity: typeof item.quantity === 'number' ? item.quantity : null,
        totalPrice: money(item.totalCost),
      })),
    })),
    amounts: {
      subtotal: money(order.cartDetails.subtotal?.amountDetails?.totalCost),
      totalBill: money(order.cartDetails.total?.amountDetails?.totalCost),
      charges: (order.cartDetails.charges || []).map((charge) => ({
        label: charge.amountDetails?.itemName || charge.amountBreakup?.title || null,
        amount: money(charge.amountDetails?.totalCost),
        display: charge.amountDetails?.displayCost || null,
      })),
      discounts: (order.cartDetails.discountApplied?.discounts || []).map((item) => ({
        name: item.discount?.name || null,
        amount: money(item.discount?.totalDiscountAmount),
      })),
    },
    paymentMethod: order.paymentDetails?.paymentMethod || null,
    source: 'zomato_order_detail',
  };
}
export function parseSalesTable(rows) {
  if (!Array.isArray(rows) || rows.length < 3) throw new ServiceError('REPORT_SCHEMA_CHANGED');
  const header = rows[0];
  if (header[0] !== 'Metric') throw new ServiceError('REPORT_SCHEMA_CHANGED');
  const periods = header.slice(2, -1).map((label) => ({ label, metrics: {} }));
  if (!periods.length) throw new ServiceError('REPORT_SCHEMA_CHANGED');
  for (const cells of rows.slice(1)) {
    if (cells.length === 1) continue;
    if (cells.length < periods.length + 2) continue;
    const metric = cells[0];
    if (!metric) continue;
    for (let i = 0; i < periods.length; i++) periods[i].metrics[metric] = cells[i + 2] ?? null;
  }
  if (!periods.some((period) => period.metrics.Sales && period.metrics['Delivered orders']))
    throw new ServiceError('REPORT_SCHEMA_CHANGED');
  return {
    periods,
    source: 'zomato_business_reports_visible_weekly_table',
    periodBasis: 'displayed_labels',
  };
}
