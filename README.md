# lw-split: in-house split testing for Shopify

The A/B testing tool we built at Living Well to replace Intelligems (~$800/mo). It has run
on our live store since July 2026. Shared as a reference: it's a working codebase from a
real store, not a polished product, and it assumes a few things about your setup (below).

Stack: Next.js 15 on Vercel, Postgres (we use Neon), a ~600-line vanilla JS storefront
runtime, and an optional Shopify Function for price tests.

## What it does

**Test types**
- **Content / DOM tests**: replace, remove, or insert HTML at a CSS selector.
- **Inject tests**: custom CSS and JS per arm.
- **Redirect (split-URL) tests**: send an arm to a different page, keeping UTMs and
  click ids, without touching the ads (so Meta's learning phase isn't reset).
- **Price tests**: rewrite the displayed price, and (with the Shopify Function) charge it.

**Targeting**: page rules (URL path) and audience rules (device, new vs returning,
traffic source, UTM source / medium / campaign), AND within a group, OR across groups. Exclusion groups so a visitor
lands in only one of several overlapping tests.

**Results** (per arm, with confidence intervals)
- Profit per visitor (primary), net revenue per visitor, conversion rate, AOV,
  add-to-cart rate, subscription enrollment per visitor.
- Probability to beat control and probability to be best (Bayesian), uplift CI,
  projected monthly impact.
- A verdict that reads `not_ready` until 7 days live and 300 orders per arm.
- **Segments**: device, new vs returning, channel, landing page.
- Time series, daily or cumulative.
- COGS coverage %, so you know when profit numbers can't be trusted.

**QA**: preview links per arm and page (`?lwsplit_preview=control|variant|<variationId>`).
Preview pageviews record nothing. Draft tests get signed per-test links you can send to
someone for sign-off without dashboard access.

**Safety**: anti-flicker gate, bot filtering, B2B/wholesale visitors excluded from all
tests (runtime and Function), subscription lines and non-USD lines never repriced.

## How it fits together

```
Storefront theme
  anti-flicker <head> snippet ─────────► hides only selectors running tests touch
  lw-split.js (public/)  ──── GET  /api/split/config   (public, edge-cached)
     buckets by visitor id ── POST /api/split/collect  (exposures, public)
     stamps _lwsplit_price on cart (price tests) ──► Shopify Function charges it

lw-split app (this repo)
  dashboard: build / start / pause / end tests, read results   (password-gated)
  Postgres: split.*  (owned)  +  attribution.*  (read: orders, items, costs, pixel)
```

Bucketing is deterministic (FNV hash of visitor id + test salt), so it's sticky with no
server round trip.

## The one thing you have to supply: orders tied to a visitor id

Revenue and profit come from joining exposures to orders by visitor id. In our store a
separate attribution app fills those tables. **Read [DATA-CONTRACT.md](DATA-CONTRACT.md)
first.** It lists exactly which tables and columns are read and how the id gets onto the
order. A starter schema is in `schema/attribution-contract.sql`.

## Setup

```bash
cp .env.example .env.local          # DATABASE_URL, DASHBOARD_PASSWORD, SPLIT_API_TOKEN, STOREFRONT_ORIGIN
npm install
psql "$DATABASE_URL" -f schema/attribution-contract.sql   # only if you don't have these tables
npm run schema                      # creates split.* (idempotent, additive)
npm run smoke                       # seed a throwaway test, compute results, clean up
npm run dev
```

Theme, in `<head>` before other scripts:

```html
<!-- anti-flicker gate: generate with `npm run gate:sync`, or paste the snippet it renders -->
{% render 'lwsplit-gate' %}
<script>window.__LWSPLIT_API__ = "https://split.your-store.example.com";</script>
<script src="https://split.your-store.example.com/lw-split.js" async></script>
```

The script is inert until a test is running. Exclude B2B in the theme too if you can
(the runtime checks `window.IS_B2B_CUSTOMER`, an `html.b2b-customer` class, and two
wholesale cookies; adjust `isB2B()` in `public/lw-split.js` to your theme's signals).

Tests (no browser or DB needed):

```bash
npm run test:preview     # preview / force-arm behaviour
npm run test:redirect    # redirect URL building, traffic-source detection
```

## Lessons that cost us something

- **Always read the device segment.** On our first test the blended number said +17.7%
  revenue per visitor; mobile was −22%. The "win" was 6 vs 1 desktop orders.
- **Respect `not_ready`.** Low-traffic pages need weeks. Ship at ≥80% probability to
  beat control on the metric you declared up front.
- **Add-to-cart rate is the early warning.** It shows direction days before orders do.
- **Below ~85% COGS coverage, ignore profit per visitor.**
- **Guard against a selector matching multiple elements** (duplicate inserts). On Shopify,
  anchor on `[id$="section_handle"]`; section ids embed a template id that changes.
- **Discover redirects before counting anything.** Otherwise a visitor who's about to be
  redirected still gets an exposure on the page's other tests and dilutes them.
- **Smoke tests against a live DB must clean up in `finally`** and use a page rule that
  can't match a real URL. A failed run once left a running test that bucketed 90 real
  visitors before anyone noticed.
- **A previewed price variant still charges the control price** (preview never stamps
  the cart). Verify charges by bucketing in for real, and check real orders.
- **Count `checkout_start` as an add to cart.** Landing pages with cart-permalink buttons
  skip the cart, so the pixel never sees an add.
- **Cart permalinks wipe cart attributes**, including your visitor id. See DATA-CONTRACT.md.

## Not built (yet)

- True multi-arm probability for 3+ variants (prob-to-beat-control equals
  prob-to-be-best only for 2-arm tests; `probBest` is there as a cross-check).
- A visual editor. Tests are built from selectors + HTML in the dashboard form.
- Shipping or offer tests (Intelligems has these).
- Non-USD price tests.

## Layout

```
app/                 dashboard pages + API routes (split/config, collect, results, tests, pricemap)
lib/                 db + schema, config compiler, results engine, stats, preview keys, auth
public/lw-split.js   storefront runtime
scripts/             schema, smoke, status, gate sync, runtime tests
schema/              DDL for the attribution tables this reads
shopify-function/    price-test Cart Transform Function
```
