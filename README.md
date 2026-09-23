# Zomato Restaurant Partner MCP

A self-hosted, single-outlet [Model Context Protocol](https://modelcontextprotocol.io/) service for reading an authorized Zomato Restaurant Partner account. It uses a persistent browser session and keeps login, outlet checks and private credentials separate from other services such as Hyperpure.

**Development status:** the first read-only implementation and offline tests are complete. Live remote login and data checks are pending. The initial deployment server currently receives an access error from the partner website; no production readiness or live data correctness is claimed.

Independent community project; not affiliated with or endorsed by Zomato. Use only an account you own or are authorized to operate. The service does not bypass OTP, CAPTCHA or access controls.

## Tools

| Tool               | What it reads                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `session_status`   | Current login and configured restaurant identity.                                         |
| `get_availability` | The partner portal's current Online/Offline badge.                                        |
| `list_orders`      | Order history over an inclusive India date range, with a signed continuation cursor.      |
| `get_order`        | Items, quantities, discounts, charges and total for an order first discovered in history. |
| `get_sales_report` | The visible business report with the period labels actually displayed by Zomato.          |

Every tool result includes a stable account and outlet reference, masked login number, restaurant ID, expected outlet name and verification state. Customer names and addresses are excluded from results. The service has no order acceptance, rejection, menu, availability, offer or advertisement write tool.

The order-history request uses Zomato's currently observed partner-portal read endpoint. Its HTTP method is POST even though it only retrieves history. The portal's internal request and response shapes may change. The server stops with a clear error when required fields are missing.

`list_orders` accepts `dateFrom`, `dateTo` in `YYYY-MM-DD` and optional `status` (`DELIVERED` or `REJECTED`). Both dates are inclusive in Asia/Kolkata. Follow `pagination.nextCursor` until it is null; the cursor expires after 30 minutes. A request covers at most 31 days. `get_order` requires an ID returned by `list_orders` for the configured restaurant. The displayed sales table may be weekly even when its URL contains daily parameters, so the response uses the table's actual labels.

## Local setup

Use Node.js 22.9 or later. Install Chrome or the Playwright Chromium browser with Linux system dependencies, then:

```sh
npm ci
npx playwright install chromium
npm run configure
npm start
```

`npm run configure` asks for the HTTPS origin, login mobile number, Zomato restaurant ID and exact outlet name. It writes `.env`, `.secrets/connection.json` and `.secrets/owner-access.txt` with owner-only permissions. It refuses to overwrite existing files. Import the connection JSON into an MCP client that supports Streamable HTTP and a bearer header. The service binds to loopback port 9320 and needs an HTTPS reverse proxy before the owner login page works.

Open `https://YOUR_DOMAIN/owner`, unlock it with the owner key, request the OTP and enter it there. OTPs are neither saved nor logged. The separate Zomato browser profile stays in the configured data directory, and a relogin is needed only when Zomato expires that session. A background check runs every 15 minutes when no OTP challenge is active; each read also verifies the restaurant identity.

## Deployment and verification

See [deployment](docs/deployment.md) and [data contract](docs/data-contract.md). The chosen host must first be able to load the partner portal with its browser. A successful `/healthz` means the process is running; `session_status` must say `READY` before account data is trusted. The optional `npm run test:live` reads availability, recent orders, one detail and the sales report without making account changes.

Run offline checks with:

```sh
npm ci
npm run check
npm run format:check
npm test
npm run check:public
```

The test fixtures are synthetic. CI runs on Node 22 and 24 and never accesses a Zomato account. Browser selectors, login steps and internal read endpoints need live validation after the server's access problem is resolved.

## License

MIT. Third-party names and marks belong to their owners; this license does not grant rights to account data.
