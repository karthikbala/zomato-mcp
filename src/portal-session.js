import { createHash, randomBytes } from 'node:crypto';
import { ServiceError, token } from './security.js';

const ACCOUNTS = 'https://accounts.zomato.com';
const SITE = 'https://www.zomato.com';
const GATEWAY = 'https://api.zomato.com';
// Public OAuth client used by the Restaurant Partner website; this is not a secret.
const CLIENT = '2c4e3ed9-0308-4d16-a237-3a5c99f7e944';
const loginHeaders = { origin: SITE, referer: `${SITE}/partners/login` };

async function followAccount(request, start, allowLogin = false) {
  let url = new URL(start, ACCOUNTS);
  for (let step = 0; step < 8; step++) {
    if (
      allowLogin &&
      url.origin === ACCOUNTS &&
      url.pathname === '/zoauth/login' &&
      !url.username &&
      !url.password
    ) {
      // Login is only a valid destination during initial authorization.
    } else {
      accountRedirect(url.href);
    }
    const response = await request.get(url.href, { timeout: 25000, maxRedirects: 0 });
    if (![301, 302, 303, 307, 308].includes(response.status())) return response;
    const location = response.headers().location;
    if (!location) throw new ServiceError('AUTH_REDIRECT_INVALID');
    url = new URL(location, url);
  }
  throw new ServiceError('AUTH_REDIRECT_INVALID');
}

export function accountRedirect(value) {
  let url;
  try {
    url = new URL(value, ACCOUNTS);
  } catch {
    throw new ServiceError('AUTH_REDIRECT_INVALID');
  }
  if (
    url.origin !== ACCOUNTS ||
    url.username ||
    url.password ||
    !['/oauth2/auth', '/zoauth/consent', '/zoauth/callback'].includes(url.pathname)
  )
    throw new ServiceError('AUTH_REDIRECT_INVALID');
  return url;
}

async function json(response) {
  if (response.status() === 401) throw new ServiceError('AUTH_REQUIRED');
  if (response.status() === 403) throw new ServiceError('PORTAL_ACCESS_DENIED');
  if (response.status() === 429) throw new ServiceError('RATE_LIMITED');
  if (!response.ok()) throw new ServiceError('SITE_UNAVAILABLE');
  try {
    return await response.json();
  } catch {
    throw new ServiceError('PORTAL_SCHEMA_CHANGED');
  }
}

export class PortalSession {
  constructor(context, config, store) {
    this.context = context;
    this.config = config;
    this.store = store;
  }
  async save() {
    await this.store.write('session-cookies', await this.context.cookies());
  }
  async prepare() {
    if (this.headers) return;
    const csrfResponse = await this.context.request.get(`${SITE}/webroutes/auth/csrf`, {
      timeout: 20000,
      maxRedirects: 0,
    });
    const csrf = await json(csrfResponse);
    if (typeof csrf.csrf !== 'string' || !csrf.csrf)
      throw new ServiceError('PORTAL_SCHEMA_CHANGED');
    const headers = {
      ...loginHeaders,
      'x-client-id': 'zomato_web_merchant',
      'x-zomato-app-version': '2',
      'x-zomato-csrft': csrf.csrf,
    };
    const gateway = await json(
      await this.context.request.post(`${GATEWAY}/merchant-gw/set-csrf`, {
        headers,
        timeout: 20000,
        maxRedirects: 0,
      }),
    );
    if (typeof gateway.csrf !== 'string' || !gateway.csrf)
      throw new ServiceError('PORTAL_SCHEMA_CHANGED');
    this.headers = {
      ...headers,
      'x-zomato-mx-csrf-token': gateway.csrf,
      'x-zomato-source-identifier': 'merchant-dashboard',
    };
    await this.save();
  }
  async read(url, options = {}) {
    await this.prepare();
    let response = await this.context.request.fetch(url, {
      ...options,
      headers: this.headers,
      timeout: 30000,
      maxRedirects: 0,
    });
    // A CSRF renewal repeats only the original read, once. No generic write tools exist.
    if (response.status() === 419) {
      this.headers = null;
      await this.prepare();
      response = await this.context.request.fetch(url, {
        ...options,
        headers: this.headers,
        timeout: 30000,
        maxRedirects: 0,
      });
    }
    const value = await json(response);
    await this.save();
    return value;
  }
  async refresh() {
    const response = await this.context.request.post(`${ACCOUNTS}/token/refresh`, {
      multipart: { cid: CLIENT, callback: '' },
      headers: loginHeaders,
      timeout: 20000,
      maxRedirects: 0,
    });
    const data = await json(response);
    if (!data.status) throw new ServiceError('AUTH_REQUIRED');
    this.headers = null;
    await this.save();
  }
  async startLogin() {
    const verifier = randomBytes(28).toString('hex');
    const state = token();
    const url = new URL('/oauth2/auth', ACCOUNTS);
    for (const [key, value] of Object.entries({
      client_id: CLIENT,
      redirect_uri: `${ACCOUNTS}/zoauth/callback`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'offline openid',
      response_type: 'code',
      state,
    }))
      url.searchParams.set(key, value);
    const expires = Math.floor(Date.now() / 1000) + 900;
    await this.context.addCookies([
      {
        name: 'cid',
        value: CLIENT,
        domain: '.zomato.com',
        path: '/',
        secure: true,
        sameSite: 'None',
        expires,
      },
    ]);
    const response = await followAccount(this.context.request, url.href, true);
    const landing = new URL(response.url());
    const loginChallenge = landing.searchParams.get('login_challenge');
    if (
      !response.ok() ||
      landing.origin !== ACCOUNTS ||
      landing.pathname !== '/zoauth/login' ||
      !loginChallenge
    )
      throw new ServiceError('AUTH_BOOTSTRAP_FAILED');
    // These are the PKCE and client cookies set by Zomato's own account widget.
    await this.context.addCookies(
      Object.entries({
        zxcv: verifier,
        cid: CLIENT,
        purl: SITE,
        callback: '',
      }).map(([name, value]) => ({
        name,
        value,
        domain: 'accounts.zomato.com',
        path: '/',
        secure: true,
        sameSite: 'None',
        expires,
      })),
    );
    const data = await json(
      await this.context.request.post(`${ACCOUNTS}/login/phone`, {
        headers: loginHeaders,
        timeout: 25000,
        maxRedirects: 0,
        multipart: {
          country_id: '1',
          number: this.config.mobile,
          lc: loginChallenge,
          type: 'initiate',
          verification_type: 'sms',
          message_uuid: '',
        },
      }),
    );
    if (data.status !== true) throw new ServiceError('OTP_REQUEST_FAILED');
    this.challenge = { id: token(), state, loginChallenge, expiresAt: Date.now() + 600000 };
    return { challengeId: this.challenge.id, expiresAt: this.challenge.expiresAt };
  }
  async submitOtp(challengeId, otp) {
    const challenge = this.challenge;
    if (!challenge || challenge.id !== challengeId || challenge.expiresAt < Date.now())
      throw new ServiceError('OTP_CHALLENGE_EXPIRED');
    if (!challenge.redirect) {
      if (typeof otp !== 'string' || !/^\d{4,8}$/.test(otp)) throw new ServiceError('INVALID_OTP');
      const data = await json(
        await this.context.request.post(`${ACCOUNTS}/login/phone`, {
          multipart: {
            country_id: '1',
            number: this.config.mobile,
            lc: challenge.loginChallenge,
            type: 'verify',
            otp,
          },
          headers: loginHeaders,
          timeout: 25000,
          maxRedirects: 0,
        }),
      );
      if (data.status !== true) throw new ServiceError('OTP_NOT_ACCEPTED');
      if (!data.redirect_to) throw new ServiceError('AUTH_ACCOUNT_ACTION_REQUIRED');
      challenge.redirect = accountRedirect(data.redirect_to).href;
    }
    for (let step = 0; step < 4; step++) {
      const response = await followAccount(
        this.context.request,
        accountRedirect(challenge.redirect).href,
      );
      if (!response.ok()) throw new ServiceError('AUTH_BOOTSTRAP_FAILED');
      const current = accountRedirect(response.url());
      if (current.pathname === '/zoauth/consent') {
        const cc = current.searchParams.get('consent_challenge');
        if (!cc) throw new ServiceError('AUTH_BOOTSTRAP_FAILED');
        const consent = await json(
          await this.context.request.post(`${ACCOUNTS}/consent`, {
            multipart: { cc },
            headers: loginHeaders,
            timeout: 25000,
            maxRedirects: 0,
          }),
        );
        if (!consent.status || !consent.redirect_to)
          throw new ServiceError('AUTH_BOOTSTRAP_FAILED');
        challenge.redirect = accountRedirect(consent.redirect_to).href;
        continue;
      }
      if (
        current.pathname !== '/zoauth/callback' ||
        current.searchParams.get('state') !== challenge.state
      )
        throw new ServiceError('AUTH_STATE_MISMATCH');
      const code = current.searchParams.get('code');
      if (!code) throw new ServiceError('AUTH_BOOTSTRAP_FAILED');
      const callback = await json(
        await this.context.request.post(`${ACCOUNTS}/callback`, {
          multipart: {
            code,
            state: challenge.state,
            scope: current.searchParams.get('scope') || 'offline openid',
          },
          headers: loginHeaders,
          timeout: 25000,
          maxRedirects: 0,
        }),
      );
      if (!callback.status) throw new ServiceError('AUTH_BOOTSTRAP_FAILED');
      this.challenge = null;
      this.headers = null;
      await this.save();
      return;
    }
    throw new ServiceError('AUTH_BOOTSTRAP_FAILED');
  }
}
