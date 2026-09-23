# Zomato Restaurant Partner MCP

A self-hosted, single-outlet [Model Context Protocol](https://modelcontextprotocol.io/) service for reading an authorized Zomato Restaurant Partner account. It uses a persistent browser session and keeps login, outlet checks and private credentials separate from other services such as Hyperpure.

**Status: early release.** Remote OTP sign-in and all five read-only tools have been validated on a Linux server. This is an unofficial integration with the Partner website’s internal interfaces; changes at Zomato may require updates.

Independent community project; not affiliated with or endorsed by Zomato. Use only an account you own or are authorized to operate. The service does not bypass OTP, CAPTCHA or access controls.

## Tools

| Tool               | What it reads                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `session_status`   | Current login and configured restaurant identity.                                         |
| `get_availability` | The restaurant status used by the Partner Online/Offline badge.                           |
| `list_orders`      | Order history over an inclusive India date range, with a signed continuation cursor.      |
| `get_order`        | Items, quantities, discounts, charges and total for an order first discovered in history. |
| `get_sales_report` | The business report API, preserving its actual period labels.                             |

Every tool result includes a stable account and outlet reference, masked login number, restaurant ID, expected outlet name and verification state. Customer names and addresses are excluded from results. The service has no order acceptance, rejection, menu, availability, offer or advertisement write tool.

Order history and business reports use the read endpoints observed in the Partner website. Both use POST even though they only retrieve data. The portal's internal request and response shapes may change. The server stops with a clear error when required fields are missing.

`list_orders` accepts `dateFrom`, `dateTo` in `YYYY-MM-DD` and optional `status` (`DELIVERED` or `REJECTED`). Both dates are inclusive in Asia/Kolkata. Follow `pagination.nextCursor` until it is null; the cursor expires after 30 minutes. A request covers at most 31 days. `get_order` requires an ID returned by `list_orders` for the configured restaurant. The displayed sales table may be weekly even when its URL contains daily parameters, so the response uses the table's actual labels.

## Local setup

Use Node.js 22.9 or later and install Playwright’s full Chromium build. Linux also needs browser system dependencies and, for the recommended virtual display deployment, `xvfb` and `xauth`:

```sh
npm ci
npx playwright install chromium
npm run configure
npm start
```

`npm run configure` asks for the HTTPS origin, login mobile number, Zomato restaurant ID and exact outlet name. It writes `.env`, `.secrets/connection.json` and `.secrets/owner-access.txt` with owner-only permissions. It refuses to overwrite existing files. Import the connection JSON into an MCP client that supports Streamable HTTP and a bearer header. The service binds to loopback port 9320 and needs an HTTPS reverse proxy before the owner login page works.

Open `https://YOUR_DOMAIN/owner`, unlock it with the owner key, request the OTP and enter it there. OTPs are neither saved nor logged. The separate Zomato browser profile stays in the configured data directory, and a relogin is needed only when Zomato expires that session. A background check runs every 15 minutes when no OTP challenge is active; each read also verifies the authenticated account and restaurant. The service tries the portal’s session-refresh endpoint once when authentication expires. If refresh fails, tools return `AUTH_REQUIRED` and the owner page can request a new OTP. It never sends repeated OTPs automatically.

## How remote access works

The service keeps a dedicated Chromium profile, then uses its shared cookie jar to call the same account and data interfaces as the Partner website. Login uses Zomato Accounts with OTP, PKCE and state validation. This avoids requiring every frontend JavaScript bundle to render successfully before reading data. Account access and restaurant permission are still checked by Zomato.

The initial host could not reliably render the Partner app, but its normal account and data requests work with full Chromium running on an Xvfb virtual display. The supplied systemd unit uses this configuration (`BROWSER_HEADLESS=false`). It runs unattended on the remote server and requires no local café computer, desktop connection or public browser debugging port. Browser or HTTP access failures remain errors; the service does not invent empty results or try rotating proxies.

## Deployment and verification

See [deployment](docs/deployment.md) and [data contract](docs/data-contract.md). The chosen host must reach Zomato’s account service and the Partner read APIs. A successful `/healthz` means the process is running; `session_status` must say `READY` before account data is trusted. The optional `npm run test:live` reads availability, recent orders, one detail and the sales report without making account changes.

Run offline checks with:

```sh
npm ci
npm run check
npm run format:check
npm test
npm run check:public
```

The test fixtures are synthetic. CI runs on Node 22 and 24 and never accesses a Zomato account. Run live checks for each new deployment; offline tests cannot establish account permissions or upstream availability.

## License

MIT. Third-party names and marks belong to their owners; this license does not grant rights to account data.
