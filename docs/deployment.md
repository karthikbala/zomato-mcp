# Linux deployment

Deploy as a **separate service** from Hyperpure. Both can share a host, but must have separate Unix users, browser profiles, state directories, credentials, ports, TLS names and logs.

The provided templates use `/opt/zomato-mcp`, `/var/lib/zomato-mcp`, `/etc/zomato-mcp`, loopback port `9320` and `zomato.example.com`. Set up Node 22.9+, Playwright Chromium, `xvfb` and `xauth` for the service user, create that user and its private directories, and place the repository code under `/opt/zomato-mcp`. Use `npm ci --omit=dev` and install the chosen browser with Playwright. Update the systemd unit's Node path if your runtime lives elsewhere.

Put the configured environment in `/etc/zomato-mcp/service.env` with mode `0600`. Set `DATA_DIR=/var/lib/zomato-mcp`, `PLAYWRIGHT_BROWSERS_PATH=/var/lib/zomato-mcp/browsers` and a real HTTPS `PUBLIC_ORIGIN`. Keep the owner and MCP keys different. Give `/var/lib/zomato-mcp` to the service user with mode `0700`. Use the [systemd unit](../deploy/zomato-mcp.service) and [Nginx example](../deploy/nginx.conf.example); provision TLS before owner login.

The systemd unit launches full Chromium on an Xvfb virtual display with `BROWSER_HEADLESS=false`. Account login and reads use Chromium’s shared HTTP request context, cookies and the observed Partner API contracts. This configuration worked on the initial deployment host even though the Partner frontend bundles could not reliably load there. Do not disable certificate validation or Chromium’s sandbox to handle access failures. A running process alone is not proof of a working integration.

After deployment, check `/healthz`, then authenticated `session_status`. Complete OTP through the owner page and verify the exact restaurant ID and name. Run `npm run test:live` with private configuration only after `READY`. Compare the returned data with the Partner portal, including outlet identity, order IDs, totals and the report’s actual period labels. Restart the service and repeat the authenticated status check to verify session persistence. Stop deployment on outlet mismatch or missing/changed response fields.

For upgrades, stop the service, back up code, locked dependencies and the private browser profile, then install and restart. Test the account state again. Do not copy profiles or credentials into the public repository.

The private state directory contains the browser profile, a cookies file, an installation identity key, the pinned authenticated account ID, and IDs of recently discovered orders. Protect the entire directory and its backups. OTPs and OAuth authorization codes are not written to the normal application state. Keep the data directory across upgrades; deleting it changes installation references and requires sign-in again.
