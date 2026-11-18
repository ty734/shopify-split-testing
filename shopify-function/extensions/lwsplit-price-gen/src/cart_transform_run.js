// @ts-check
// lw-split — wholesale-safe price-test cart-transform (charge side).
//
// SAFETY MODEL (defense in depth; this file is Layer 2):
//   Layer 0 (theme): lw-split.js not loaded for B2B.
//   Layer 1 (runtime): B2B never bucketed / never stamps the cart attribute.
//   Layer 2 (HERE): even if a stray attribute reached a wholesale cart, this function
//     no-ops the instant it sees buyerIdentity.purchasingCompany. So a wholesale
//     customer's native B2B catalog price can NEVER be overwritten.
//
// The client can only pick a *variation* (via the cart attribute); the *price* is read
// from this function-owner's own metafield, so a forged attribute can never set an
// arbitrary charge price.

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/** @type {CartTransformRunResult} */
const NO_CHANGES = { operations: [] };

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const cart = input && input.cart;
  if (!cart) return NO_CHANGES;

  // --- Layer 2 wholesale safety: never touch a B2B / wholesale cart. ---
  if (cart.buyerIdentity && cart.buyerIdentity.purchasingCompany) return NO_CHANGES;

  // --- Which variation is this visitor in? "<testId>:<variationId>", set by the runtime. ---
  const stamp = cart.lwsplit && cart.lwsplit.value;
  if (!stamp) return NO_CHANGES;

  // --- Authoritative price map from OUR metafield (never trust a client price). ---
  const raw = input.cartTransform && input.cartTransform.prices && input.cartTransform.prices.value;
  if (!raw) return NO_CHANGES;
  let prices;
  try { prices = JSON.parse(raw); } catch (e) { return NO_CHANGES; }
  const variantPrices = prices[stamp]; // { "<variantGID>": <price major units> }
  if (!variantPrices) return NO_CHANGES;

  const operations = [];
  for (const line of cart.lines || []) {
    const m = line.merchandise;
    if (!m || m.__typename !== "ProductVariant") continue;

    // Never reprice subscription lines (Recharge / any selling plan). v1 = one-time only.
    if (line.sellingPlanAllocation) continue;

    // US/USD only in v1 — never reprice a non-USD (e.g. Canada/CAD) presentment line.
    const cur = line.cost && line.cost.amountPerQuantity && line.cost.amountPerQuantity.currencyCode;
    if (cur && cur !== "USD") continue;

    const target = variantPrices[m.id];
    if (target == null) continue;

    operations.push({
      lineUpdate: {
        cartLineId: line.id,
        price: { adjustment: { fixedPricePerUnit: { amount: Number(target).toFixed(2) } } },
      },
    });
  }

  return operations.length ? { operations } : NO_CHANGES;
}
