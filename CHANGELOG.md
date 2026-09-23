# Changelog

## 0.1.1

- Make remote login independent of rendering the Partner frontend: use the same Zomato Accounts OTP, PKCE and consent flow with a persistent Chromium cookie jar.
- Read verified account identity, outlet availability, orders and business reports through the observed Partner interfaces. Preserve actual report periods when upstream ignores requested dates.
- Add session refresh, account pinning, guarded authentication redirects, and a Linux virtual display configuration.
- Validate remote login, paginated history, order details and sales; keep OTPs out of persisted state and public artifacts.

## 0.1.0 — development

- Separate, single-outlet Zomato MCP with persistent browser, owner OTP page, outlet verification and five read-only tools.
- Structured order history/detail reads, signed pagination cursors, availability badge and sales table with actual period labels.
- Synthetic tests and Linux deployment templates. Live remote login/data validation remains pending because the initial server's browser cannot load the partner portal.
