# Linux deployment

Deploy as a **separate service** from Hyperpure. Both can share a host, but must have separate Unix users, browser profiles, state directories, credentials, ports, TLS names and logs.

The provided templates use `/opt/zomato-mcp`, `/var/lib/zomato-mcp`, `/etc/zomato-mcp`, loopback port `9320` and `zomato.example.com`. Set up Node 22.9+ and Chrome/Playwright Chromium for the service user, create that user and its private directories, and place the repository code under `/opt/zomato-mcp`. Use `npm ci --omit=dev` and install the chosen browser with Playwright. Update the systemd unit's Node path if your runtime lives elsewhere.

Put the configured environment in `/etc/zomato-mcp/service.env` with mode `0600`. Set `DATA_DIR=/var/lib/zomato-mcp`, `PLAYWRIGHT_BROWSERS_PATH=/var/lib/zomato-mcp/browsers` and a real HTTPS `PUBLIC_ORIGIN`. Keep the owner and MCP keys different. Give `/var/lib/zomato-mcp` to the service user with mode `0700`. Use the [systemd unit](../deploy/zomato-mcp.service) and [Nginx example](../deploy/nginx.conf.example); provision TLS before owner login.

Before starting the service, verify that the **same server and browser configuration** can load `https://www.zomato.com/partners/` and the report pages. On the initial Hyperpure host, a headless Chrome navigation failed before login, while the signed-in local browser worked. This is unresolved; do not treat a running process as a working integration.

After deployment, check `/healthz`, then authenticated `session_status`. Complete OTP through the owner page and verify the exact restaurant ID and name. Run `npm run test:live` with private configuration only after `READY`. Review both public portal status and the data returned by each tool. Stop deployment on outlet mismatch or missing/changed response fields.

For upgrades, stop the service, back up code, locked dependencies and the private browser profile, then install and restart. Test the account state again. Do not copy profiles or credentials into the public repository.
