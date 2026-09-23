import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { SerialQueue, ServiceError, signedCursor, readCursor, token } from './security.js';
import { dateRange, normalizeHistory, normalizeOrderDetail, parseSalesTable } from './data.js';

const ORIGIN = 'https://www.zomato.com';
const PARTNER = `${ORIGIN}/partners/onlineordering`;
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
      headless: true,
      chromiumSandbox: true,
      viewport: { width: 1440, height: 1000 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      acceptDownloads: false,
    });
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
        source: 'configured_and_checked_against_partner_portal',
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
      await this.page.goto(`${PARTNER}/outletInfo/`, { waitUntil: 'domcontentloaded' });
      await this.page
        .getByText(/Restaurant ID\s*:/)
        .first()
        .waitFor({ timeout: 15000 });
      const text = await this.page.locator('body').innerText();
      const id = text.match(/Restaurant ID\s*:\s*(\d{6,15})/i)?.[1];
      if (id !== this.config.restaurantId || !text.includes(this.config.outletName)) {
        this.state = 'OUTLET_MISMATCH';
        return this.status();
      }
      this.state = 'READY';
      this.lastVerifiedAt = new Date().toISOString();
    } catch (error) {
      // Login redirects and transport failures are different states for the owner.
      this.state =
        this.page.url().includes('/partners/') &&
        (await this.page
          .getByRole('button', { name: /Send OTP|Continue with Email|Login/i })
          .count())
          ? 'AUTH_REQUIRED'
          : 'SITE_UNAVAILABLE';
    }
    return this.status();
  }
  async requireReady() {
    await this.check();
    if (this.state !== 'READY') throw new ServiceError(this.state);
  }
  async startLogin() {
    await this.page.goto(`${ORIGIN}/partners/`, { waitUntil: 'domcontentloaded' });
    const phone = this.page.getByPlaceholder(/Phone number/i).first();
    if (!(await phone.count())) throw new ServiceError('LOGIN_FORM_CHANGED');
    await phone.fill(this.config.mobile);
    await this.page.getByRole('button', { name: /Send OTP/i }).click();
    this.challenge = { id: token(), expiresAt: Date.now() + 600000 };
    this.state = 'OTP_REQUIRED';
    return { challengeId: this.challenge.id, expiresAt: this.challenge.expiresAt };
  }
  async submitOtp(challengeId, code) {
    if (
      !this.challenge ||
      this.challenge.id !== challengeId ||
      this.challenge.expiresAt < Date.now()
    )
      throw new ServiceError('OTP_CHALLENGE_EXPIRED');
    if (!/^\d{4,8}$/.test(code)) throw new ServiceError('INVALID_OTP');
    const fields = this.page.locator(
      'input[autocomplete="one-time-code"], input[placeholder*="OTP" i], input[maxlength="1"]',
    );
    const count = await fields.count();
    if (count === 1) await fields.first().fill(code);
    else if (count === code.length) {
      for (let i = 0; i < count; i++) await fields.nth(i).fill(code[i]);
    } else throw new ServiceError('LOGIN_FORM_CHANGED');
    const submit = this.page.getByRole('button', { name: /Verify|Continue|Submit/i }).first();
    if (await submit.count()) await submit.click();
    this.challenge = null;
    await this.check();
    if (this.state !== 'READY') throw new ServiceError(this.state);
    return this.status();
  }
  async availability() {
    await this.requireReady();
    await this.page.goto(PARTNER, { waitUntil: 'domcontentloaded' });
    const labels = await this.page.locator('span').allTextContents();
    const states = labels.map((s) => s.trim()).filter((s) => s === 'Online' || s === 'Offline');
    if (states.length !== 1) throw new ServiceError('AVAILABILITY_SCHEMA_CHANGED');
    return {
      status: states[0].toUpperCase(),
      observedAt: new Date().toISOString(),
      source: 'zomato_partner_status_badge',
      note: 'Displayed partner status; this does not independently prove customer checkout availability.',
    };
  }
  async historyHeaders() {
    await this.requireReady();
    const responsePromise = this.page
      .waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return url.origin === 'https://api.zomato.com' && url.pathname === HISTORY_PATH;
        },
        { timeout: 30000 },
      )
      .catch((error) => error);
    await this.page.goto(`${PARTNER}/orderHistory/`, { waitUntil: 'domcontentloaded' });
    const response = await responsePromise;
    if (response instanceof Error) throw new ServiceError('ORDER_SOURCE_UNAVAILABLE');
    if (response.status() !== 200) throw new ServiceError('ORDER_SOURCE_UNAVAILABLE');
    const headers = await response.request().allHeaders();
    this.apiHeaders = Object.fromEntries(
      Object.entries(headers).filter(([key]) =>
        [
          'content-type',
          'accept',
          'origin',
          'referer',
          'x-client-id',
          'x-zomato-app-version',
          'x-zomato-csrft',
        ].includes(key),
      ),
    );
    if (!this.apiHeaders['x-zomato-csrft']) throw new ServiceError('ORDER_SOURCE_CHANGED');
  }
  async listOrders(args = {}) {
    await this.historyHeaders();
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
    const response = await this.context.request.post(`https://api.zomato.com${HISTORY_PATH}`, {
      headers: this.apiHeaders,
      data: body,
      timeout: 30000,
      maxRedirects: 0,
    });
    if (response.status() === 401 || response.status() === 403) {
      this.state = 'AUTH_REQUIRED';
      throw new ServiceError('AUTH_REQUIRED');
    }
    if (response.status() !== 200) throw new ServiceError('ORDER_SOURCE_UNAVAILABLE');
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ServiceError('ORDER_SCHEMA_CHANGED');
    }
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
    if (!this.apiHeaders) await this.historyHeaders();
    const url = new URL(DETAIL_PATH, ORIGIN);
    url.searchParams.set('tab_id', orderId);
    url.searchParams.set('view', 'order-history');
    const response = await this.context.request.get(url.href, {
      headers: this.apiHeaders,
      timeout: 30000,
      maxRedirects: 0,
    });
    if ([401, 403].includes(response.status())) {
      this.state = 'AUTH_REQUIRED';
      throw new ServiceError('AUTH_REQUIRED');
    }
    if (response.status() !== 200) throw new ServiceError('ORDER_SOURCE_UNAVAILABLE');
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ServiceError('ORDER_SCHEMA_CHANGED');
    }
    return normalizeOrderDetail(data, orderId, this.config.restaurantId);
  }
  async salesReport() {
    await this.requireReady();
    await this.page.goto(`${PARTNER}/reporting/?selected_view=view_business_reports`, {
      waitUntil: 'domcontentloaded',
    });
    const table = this.page.frameLocator('iframe[src*="mx-reporting"]').locator('table').first();
    await table.waitFor({ timeout: 30000 });
    if (!(await this.page.getByText(this.config.outletName, { exact: true }).first().isVisible()))
      throw new ServiceError('OUTLET_MISMATCH');
    const rows = await table.evaluate((element) =>
      [...element.querySelectorAll('tr')].map((tr) =>
        [...tr.querySelectorAll('th,td')].map((cell) => cell.innerText.trim().replace(/\s+/g, ' ')),
      ),
    );
    return { ...parseSalesTable(rows), observedAt: new Date().toISOString() };
  }
}
