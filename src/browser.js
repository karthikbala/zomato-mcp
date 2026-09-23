import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { SerialQueue, ServiceError, signedCursor, readCursor, token } from './security.js';
import { dateRange, normalizeHistory, normalizeOrderDetail, parseBusinessReport } from './data.js';

import { PortalSession } from './portal-session.js';

const ORIGIN = 'https://www.zomato.com';
const HISTORY_PATH = '/merchant-gw/web/order/history/get-all-v2';
const DETAIL_PATH = '/merchant-api/orders/order-details';

export class ZomatoBrowser {
  queue = new SerialQueue();
  state = 'STARTING';
  lastVerifiedAt = null;
  challenge = null;
  constructor(config, store) {
    this.config = config;
    this.store = store;
  }
  async start() {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    this.identityKey = await this.store.read('identity-key');
    if (!this.identityKey) {
      this.identityKey = token();
      await this.store.write('identity-key', this.identityKey);
    }
    this.context = await chromium.launchPersistentContext(`${this.config.dataDir}/profile`, {
      headless: this.config.headless !== false,
      channel: 'chromium',
      chromiumSandbox: true,
      viewport: { width: 1440, height: 1000 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      acceptDownloads: false,
    });
    const cookies = await this.store.read('session-cookies', []);
    if (cookies.length) await this.context.addCookies(cookies);
    this.portal = new PortalSession(this.context, this.config, this.store);
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.setDefaultTimeout(20000);
    this.page.setDefaultNavigationTimeout(30000);
    this.context.on('close', () => {
      this.state = 'BROWSER_UNAVAILABLE';
    });
    await this.check();
  }
  identity() {
    const ref = (value) => createHmac('sha256', this.identityKey).update(value).digest('hex');
    return {
      account: {
        reference: ref(`account:${this.config.mobile}`),
        loginMobileMasked: `******${this.config.mobile.slice(-4)}`,
      },
      outlet: {
        reference: ref(`outlet:${this.config.mobile}:${this.config.restaurantId}`),
        restaurantId: this.config.restaurantId,
        name: this.config.outletName,
        source: 'configured_and_checked_against_partner_account_api',
      },
      verification: this.state === 'READY' ? 'outlet_verified' : 'unverified',
    };
  }
  status() {
    return {
      state: this.state,
      lastVerifiedAt: this.lastVerifiedAt,
      observedAt: new Date().toISOString(),
      loginUrl: `${this.config.publicOrigin}/owner`,
      identity: this.identity(),
    };
  }
  async check() {
    if (this.challenge && this.challenge.expiresAt > Date.now()) return this.status();
    this.challenge = null;
    try {
      const accountUrl = `${ORIGIN}/restaurant-onboard-diy/check-auth`;
      let account;
      try {
        account = await this.portal.read(accountUrl);
        if (account.loggedIn !== true) throw new ServiceError('AUTH_REQUIRED');
      } catch (error) {
        if (error.code !== 'AUTH_REQUIRED') throw error;
        await this.portal.refresh();
        account = await this.portal.read(accountUrl);
      }
      if (account.loggedIn !== true || !account.userId) throw new ServiceError('AUTH_REQUIRED');
      const pinnedAccount = await this.store.read('account-id');
      if (pinnedAccount && String(pinnedAccount) !== String(account.userId))
        throw new ServiceError('ACCOUNT_MISMATCH');
      const data = await this.portal.read(
        'https://api.zomato.com/merchant-gw/web/restaurant/get-all-minimal-lite',
      );
      if (!Array.isArray(data.entities)) throw new ServiceError('OUTLET_SCHEMA_CHANGED');
      if (data.is_degraded_mode) throw new ServiceError('PORTAL_DEGRADED');
      const outlet = data.entities.find((item) => String(item.id) === this.config.restaurantId);
      if (!outlet || outlet.name !== this.config.outletName)
        throw new ServiceError('OUTLET_MISMATCH');
      if (!pinnedAccount) await this.store.write('account-id', String(account.userId));
      this.outlet = outlet;
      this.state = 'READY';
      this.lastVerifiedAt = new Date().toISOString();
    } catch (error) {
      this.outlet = null;
      this.state = error instanceof ServiceError ? error.code : 'SITE_UNAVAILABLE';
    }
    return this.status();
  }
  async requireReady() {
    await this.check();
    if (this.state !== 'READY') throw new ServiceError(this.state);
  }
  async startLogin() {
    if (this.challenge && this.challenge.expiresAt > Date.now())
      return { challengeId: this.challenge.id, expiresAt: this.challenge.expiresAt };
    const result = await this.portal.startLogin();
    this.challenge = this.portal.challenge;
    this.state = 'OTP_REQUIRED';
    return result;
  }
  async submitOtp(challengeId, code) {
    await this.portal.submitOtp(challengeId, code);
    this.challenge = null;
    await this.check();
    if (this.state !== 'READY') throw new ServiceError(this.state);
    return this.status();
  }
  async availability() {
    await this.requireReady();
    if (![0, 1].includes(this.outlet.delivery_status))
      throw new ServiceError('AVAILABILITY_SCHEMA_CHANGED');
    return {
      status: this.outlet.delivery_status === 1 ? 'ONLINE' : 'OFFLINE',
      observedAt: new Date().toISOString(),
      source: 'zomato_partner_restaurant_status',
      note: 'The same status field used by the partner badge; this does not independently prove customer checkout availability.',
    };
  }
  async listOrders(args = {}) {
    await this.requireReady();
    const nowIndia = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    let range,
      postback = '',
      page = 1,
      status = args.status || '';
    if (args.cursor) {
      const saved = readCursor(args.cursor, this.identityKey);
      if (
        saved.restaurantId !== this.config.restaurantId ||
        saved.expiresAt < Date.now() ||
        saved.page > 100
      )
        throw new ServiceError('INVALID_CURSOR');
      range = dateRange(saved.from, saved.to);
      postback = saved.postback;
      page = saved.page;
      status = saved.status || '';
    } else range = dateRange(args.dateFrom || nowIndia, args.dateTo || nowIndia);
    const body = {
      res_Id: this.config.restaurantId,
      limit: 10,
      order_type: '',
      created_at: range.createdAt,
      postback_params: postback,
      state: status,
      rating: '',
      get_filters: !postback,
    };
    const data = await this.portal.read(`https://api.zomato.com${HISTORY_PATH}`, {
      method: 'POST',
      data: body,
    });
    const result = normalizeHistory(data);
    const discovered = await this.store.read('discovered-orders', {
      restaurantId: this.config.restaurantId,
      ids: {},
    });
    if (discovered.restaurantId !== this.config.restaurantId)
      throw new ServiceError('OUTLET_MISMATCH');
    for (const order of result.orders) discovered.ids[order.orderId] = Date.now();
    if (Object.keys(discovered.ids).length > 2000)
      discovered.ids = Object.fromEntries(
        Object.entries(discovered.ids)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2000),
      );
    await this.store.write('discovered-orders', discovered);
    return {
      orders: result.orders,
      period: {
        dateFrom: range.from,
        dateTo: range.to,
        timezone: 'Asia/Kolkata',
        basis: 'Zomato created_at filter',
      },
      pagination: {
        page,
        nextCursor: result.hasMore
          ? signedCursor(
              {
                restaurantId: this.config.restaurantId,
                from: range.from,
                to: range.to,
                postback: result.postback,
                status,
                page: page + 1,
                expiresAt: Date.now() + 1800000,
              },
              this.identityKey,
            )
          : null,
        complete: !result.hasMore,
      },
    };
  }
  async order(orderId) {
    await this.requireReady();
    const discovered = await this.store.read('discovered-orders', { ids: {} });
    if (discovered.restaurantId !== this.config.restaurantId || !discovered.ids[orderId])
      throw new ServiceError('ORDER_NOT_DISCOVERED', 'Find this order through list_orders first.');
    const url = new URL(DETAIL_PATH, ORIGIN);
    url.searchParams.set('tab_id', orderId);
    url.searchParams.set('view', 'order-history');
    const data = await this.portal.read(url.href);
    return normalizeOrderDetail(data, orderId, this.config.restaurantId);
  }
  async salesReport() {
    await this.requireReady();
    const indiaToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const end = new Date(Date.parse(`${indiaToday}T00:00:00Z`) - 86400000);
    const start = new Date(end.valueOf() - 9 * 86400000);
    const url = new URL(
      'https://api.zomato.com/merchant-gw/web/owner-hub/reporting/get-business-report',
    );
    for (const [key, value] of Object.entries({
      view: 'table',
      selected_res_id: this.config.restaurantId,
      time_filter: 'ist_day',
      page_type: 'owner_hub',
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
    }))
      url.searchParams.set(key, value);
    const data = await this.portal.read(url.href, { method: 'POST', data: { filters: [] } });
    return {
      ...parseBusinessReport(data, this.config.restaurantId),
      observedAt: new Date().toISOString(),
    };
  }
}
