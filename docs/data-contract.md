# Data contract and limits

All returned values are scoped to the configured restaurant ID. The service verifies the ID and outlet name in the partner portal before reads. A login failure, website failure or outlet mismatch produces an unverified identity and no sales or order result.

`list_orders` calls the history read endpoint with `created_at` set to the requested start date and the day after the requested end date. It returns the source status, order ID, displayed time label, item summary and displayed bill. The time label is kept as shown because the summary does not include an unambiguous timezone-qualified timestamp. The continuation cursor signs Zomato's opaque postback value with an installation-local key; it is not a historical snapshot. Re-query a period if orders or statuses can still change.

`get_order` checks the order ID and restaurant ID in the detail response and includes item quantities, prices, customisations, charges, discounts, source timestamps and the authoritative total bill. Zomato sends some amounts as floating-point values with small artifacts; amounts are rounded to paise for display. Missing fields remain null. Customer identity, phone and address are not returned. A bill amount is not a bank settlement or net payout.

`get_sales_report` reads the table visible in the business reports view. It uses displayed period labels, because Zomato can keep daily/date URL parameters while the table shows weeks. The report values are the portal's formatted strings, including currency and percentages; they are not inferred from order history. Partial periods must be compared with matching elapsed days before interpreting changes.

`get_availability` reads the current partner portal status badge. This reflects the partner display at observation time. It does not independently prove that the public customer checkout can accept an order or that Petpooja is online. No tool changes availability.
