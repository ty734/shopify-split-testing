# Price-test Function (optional, Shopify Plus)

The storefront runtime only changes the **displayed** price. This Cart Transform
Function changes the **charged** price for visitors bucketed into a price-test arm.

How it stays safe:

- The runtime stamps the cart with `_lwsplit_price = "<testId>:<variationId>"`. That
  only picks an arm. The **price** comes from the Function owner's own metafield
  (`$app:lwsplit / prices`), so a forged cart attribute can't set an arbitrary price.
- No-ops on B2B carts (`buyerIdentity.purchasingCompany`), subscription lines
  (`sellingPlanAllocation`), and non-USD lines.

Keeping the metafield in sync: `GET /api/split/pricemap` (bearer `SPLIT_API_TOKEN`)
returns the JSON to write; push it with `metafieldsSet` on the cart transform owner
whenever a price test starts or stops.

Setup:

1. `cp shopify.app.toml.example shopify.app.toml` and fill in your app's client id.
2. `npm install`, then `shopify app deploy`.
3. Create the cart transform (`cartTransformCreate`) pointing at this function.

**Always verify the charge on real orders.** We once had a slide-cart offer advertise a
discount the checkout didn't apply, and every dashboard looked correct. Check the
price on actual orders after any price test starts.
