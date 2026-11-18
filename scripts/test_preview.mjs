/*
 * Runtime tests for public/lw-split.js — specifically the ?lwsplit_preview force-arm
 * feature and the guarantee that a normal (no-param) load is unchanged.
 *
 *   node scripts/test_preview.mjs
 *
 * No browser, no jsdom: the runtime is executed in node:vm against a DOM stub that
 * records every side effect we care about (DOM writes, /api/split/collect beacons,
 * /cart/update.js stamps). The fixture mirrors two real-world tests: a content test on one product page and a multi-SKU price test on the
 * second product page — because the price test is what makes "no cart stamp in preview"
 * worth asserting.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "public", "lw-split.js"), "utf8");

const CONTENT = {
  id: "00000001-1111-4111-8111-000000000001",
  name: "HERO-COMPARE-01",
  exclusion_group: null,
  rules: [{ scope: "page", rule_group: 0, key: "urlPath", op: "equals", value: "/products/example-product" }],
  variations: [
    { id: "00000003-1111-4111-8111-000000000003", is_control: true, percentage: 50, changes: [] },
    {
      id: "00000006-1111-4111-8111-000000000006", is_control: false, percentage: 50,
      changes: [{ mode: "edit", selectors: ['[id$="section_abc123"]'], op: "insert", insert_type: "beforebegin", html: "<div id='cmp-block'></div>" }],
    },
  ],
};
const PRICE = {
  id: "00000002-1111-4111-8111-000000000002",
  name: "PRICE-TEST-01",
  exclusion_group: null,
  rules: [{ scope: "page", rule_group: 0, key: "urlPath", op: "equals", value: "/products/example-product-2" }],
  variations: [
    { id: "00000005-1111-4111-8111-000000000005", is_control: true, percentage: 50, changes: [] },
    {
      id: "00000004-1111-4111-8111-000000000004", is_control: false, percentage: 50,
      changes: [{ mode: "price", selectors: ["product-price .price"], test_price: 25.47, url_path: "/products/example-product-2", variant_id: "gid://shopify/ProductVariant/1001" }],
    },
  ],
};
const CONFIG = { tests: [CONTENT, PRICE], selectors: [] };

const PDP_A = "/products/example-product";
const PDP_B = "/products/example-product-2";

// Same FNV-1a bucket the runtime uses — lets a case assert "regardless of bucket"
// by picking an id that genuinely buckets the other way.
function bucketOf(id, salt) {
  const s = id + ":" + salt;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 10000;
}
const naturalArm = (id, test) =>
  bucketOf(id, test.exclusion_group || test.id) / 100 < test.variations[0].percentage ? "control" : "variant";
function idBucketingTo(arm, test) {
  for (let i = 0; i < 5000; i++) {
    const id = "vid-" + i;
    if (naturalArm(id, test) === arm) return id;
  }
  throw new Error("no id found bucketing to " + arm);
}

function makeEl(tag) {
  const el = {
    tagName: tag, id: "", title: "", textContent: "", style: { cssText: "" },
    children: [], attrs: {}, inserted: [], removed: false, listeners: {},
    classList: { contains: () => false },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    insertAdjacentHTML(pos, html) { this.inserted.push({ pos, html }); },
    remove() { this.removed = true; },
    querySelectorAll: () => [],
  };
  return el;
}

// Runs the runtime once against a fresh stub world and returns what it did.
// A thenable that settles synchronously, so the runtime's fetch→json→start chain has
// finished by the time load() returns and the assertions can stay synchronous.
const settled = (val) => ({
  then(fn) { return settled(fn ? fn(val) : val); },
  catch() { return this; },
});

function load({ path = PDP_A, search = "", vid = "vid-1", b2b = false, config = CONFIG, inlineConfig = true } = {}) {
  const log = { posts: [], beacons: [], warns: [], inserted: [], priceWrites: [], styles: [], revealed: 0, configFetch: null };

  const anchor = makeEl("section");     // the [id$="section_abc123"] insert anchor
  const price = makeEl("span");         // the product-price .price node
  Object.defineProperty(price, "textContent", {
    get() { return this._t || "$29.97"; },
    set(v) { this._t = v; log.priceWrites.push(v); },
  });
  const body = makeEl("body");

  const document = {
    cookie: vid ? "_lwvid=" + vid : "",
    documentElement: makeEl("html"),
    head: makeEl("head"),
    body,
    createElement: makeEl,
    getElementById: (id) => body.children.find((c) => c.id === id) || null,
    addEventListener() {},
    querySelectorAll(sel) {
      if (sel === '[id$="section_abc123"]') return [anchor];
      if (sel === "product-price .price") return [price];
      return [];
    },
  };
  document.head.appendChild = (el) => { log.styles.push(el.textContent); return el; };

  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };

  const sandbox = {
    console: { warn: (m) => log.warns.push(String(m)), log() {}, error() {} },
    document,
    location: { pathname: path, search, href: "https://x" + path + search },
    localStorage: storage,
    sessionStorage: storage,
    matchMedia: () => ({ matches: false }),
    navigator: { sendBeacon: (url, blob) => { log.beacons.push({ url, body: blob.body }); return true; } },
    Blob: class { constructor(parts) { this.body = parts.join(""); } },
    fetch: (url, opts) => {
      log.posts.push({ url, opts });
      if (/\/api\/split\/config/.test(url)) {
        log.configFetch = url;
        return settled({ json: () => config });
      }
      return settled({ json: () => ({}) });
    },
    setTimeout, clearTimeout, URLSearchParams, Intl, Math, Number, String, Object, Array, JSON, Function, RegExp, Date,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (inlineConfig) sandbox.__LWSPLIT_CONFIG__ = config;
  sandbox.__LWSPLIT_REVEAL__ = () => { log.revealed++; };
  if (b2b) sandbox.IS_B2B_CUSTOMER = true;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  log.inserted = anchor.inserted;
  log.badge = body.children.find((c) => c.id === "__lwsplit_preview_badge__") || null;
  log.collects = log.beacons.filter((b) => /\/api\/split\/collect/.test(b.url))
    .concat(log.posts.filter((p) => /\/api\/split\/collect/.test(p.url)));
  log.cartStamps = log.posts.filter((p) => /\/cart\/update\.js/.test(p.url));
  return log;
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n       " + e.message); }
}

const CONTROL_ID = idBucketingTo("control", CONTENT);
const VARIANT_ID = idBucketingTo("variant", CONTENT);
const VARIANT_UUID = CONTENT.variations[1].id;
const CONTROL_UUID = CONTENT.variations[0].id;

console.log("\nno-param behaviour must be untouched (req 5)");
test("normal load buckets, applies, and records an exposure", () => {
  const r = load({ vid: VARIANT_ID });
  assert.equal(r.inserted.length, 1, "variant change should be applied");
  assert.equal(r.collects.length, 1, "exactly one exposure beacon");
  assert.match(r.collects[0].body, /"name":"exposure"/);
  assert.match(r.collects[0].body, new RegExp(VARIANT_UUID));
  assert.equal(r.badge, null, "no badge without the param");
  assert.equal(r.revealed, 1);
});
test("normal load in the control bucket records an exposure and changes nothing", () => {
  const r = load({ vid: CONTROL_ID });
  assert.equal(r.inserted.length, 0);
  assert.equal(r.collects.length, 1);
  assert.match(r.collects[0].body, new RegExp(CONTROL_UUID));
});
test("normal load on a price-test page still stamps the cart", () => {
  const r = load({ path: PDP_B, vid: idBucketingTo("variant", PRICE) });
  assert.equal(r.cartStamps.length, 1, "cart stamp expected on real traffic");
  assert.equal(r.priceWrites.length, 1);
  assert.equal(r.collects.length, 1);
});
test("normal load on an untargeted page does nothing", () => {
  const r = load({ path: "/collections/all" });
  assert.equal(r.collects.length, 0);
  assert.equal(r.inserted.length, 0);
});

console.log("\n?lwsplit_preview forces an arm (req 1, 2)");
test("=control renders no injected changes even for a variant-bucketed visitor", () => {
  const r = load({ search: "?lwsplit_preview=control", vid: VARIANT_ID });
  assert.equal(r.inserted.length, 0, "control must not inject");
  assert.equal(r.revealed, 1, "page must still be revealed");
});
test("=variant renders the injected changes even for a control-bucketed visitor", () => {
  const r = load({ search: "?lwsplit_preview=variant", vid: CONTROL_ID });
  assert.equal(r.inserted.length, 1);
  assert.equal(r.inserted[0].pos, "beforebegin");
});
test("=<variationId> forces that variation regardless of bucket", () => {
  const r = load({ search: "?lwsplit_preview=" + VARIANT_UUID, vid: CONTROL_ID });
  assert.equal(r.inserted.length, 1);
  const c = load({ search: "?lwsplit_preview=" + CONTROL_UUID, vid: VARIANT_ID });
  assert.equal(c.inserted.length, 0);
});
test("=<variationId> is case-insensitive and bypasses page targeting", () => {
  const r = load({ path: "/collections/all", search: "?lwsplit_preview=" + VARIANT_UUID.toUpperCase(), vid: CONTROL_ID });
  assert.equal(r.inserted.length, 1, "UUID form should apply off-target for QA");
});
test("aliases apply to every test matching the page, with a warning", () => {
  // Both tests made to match the mint PDP (the price change is scoped to that path).
  const r = load({
    path: PDP_B,
    search: "?lwsplit_preview=variant",
    config: { tests: [{ ...CONTENT, rules: [] }, { ...PRICE, rules: [] }] },
  });
  assert.equal(r.inserted.length, 1, "content test forced to variant");
  assert.equal(r.priceWrites.length, 1, "price test forced to variant too");
  assert.equal(r.cartStamps.length, 0);
  assert.ok(r.warns.some((w) => /applied to 2 tests/.test(w)), "expected multi-test warning");
});
test("preview works with no _lwvid cookie (fresh/incognito QA window)", () => {
  const r = load({ search: "?lwsplit_preview=variant", vid: null });
  assert.equal(r.inserted.length, 1);
  assert.equal(r.collects.length, 0);
});

console.log("\npreview pageviews record nothing (req 3, 4)");
for (const q of ["control", "variant", VARIANT_UUID, CONTROL_UUID, "bogus", "", "00000000-0000-4000-8000-000000000000"]) {
  test(`no /api/split/collect for ?lwsplit_preview=${q || "(empty)"}`, () => {
    const r = load({ search: "?lwsplit_preview=" + q, vid: VARIANT_ID });
    assert.equal(r.collects.length, 0, "preview must never POST an exposure");
  });
}
test("no funnel beacon either — __lwTrack is left alone during preview", () => {
  const r = load({ search: "?lwsplit_preview=variant", vid: VARIANT_ID });
  assert.equal(typeof r.hookedTrack, "undefined");
  assert.equal(r.collects.length, 0);
});
test("previewing a price variant rewrites the display but never stamps the cart", () => {
  const r = load({ path: PDP_B, search: "?lwsplit_preview=variant", vid: CONTROL_ID });
  assert.equal(r.priceWrites.length, 1, "display price should be rewritten");
  assert.equal(r.cartStamps.length, 0, "cart must not be touched in preview");
  assert.equal(r.collects.length, 0);
});
test("unresolvable tokens force nothing and fall back to the real bucket, silently", () => {
  // Deliberate contract: an unresolvable token forces no arm, so every test keeps its
  // normal cookie bucket and the page looks exactly like this visitor's real view —
  // it just isn't recorded. The badge reads "nothing forced" so the QA reader can't
  // mistake a typo'd param for a successful force.
  const r = load({ search: "?lwsplit_preview=nope", vid: VARIANT_ID });
  const natural = load({ vid: VARIANT_ID });
  assert.equal(r.collects.length, 0, "still no analytics");
  assert.equal(r.inserted.length, natural.inserted.length, "renders the natural bucket");
  assert.equal(r.badge.textContent, "PREVIEW: nothing forced");
  assert.ok(r.warns.some((w) => /unrecognized value/.test(w)));
});
test("an unknown variation id warns and forces nothing", () => {
  const r = load({ search: "?lwsplit_preview=00000000-0000-4000-8000-000000000000", vid: CONTROL_ID });
  assert.equal(r.inserted.length, 0);
  assert.ok(r.warns.some((w) => /no running test has a variation/.test(w)));
});
test("wholesale sessions stay excluded, preview included", () => {
  const r = load({ search: "?lwsplit_preview=variant", b2b: true });
  assert.equal(r.inserted.length, 0);
  assert.equal(r.collects.length, 0);
  assert.ok(r.warns.some((w) => /wholesale/i.test(w)));
});

console.log("\ndraft previews");
// A keyed draft preview is the ONLY way a non-running test reaches the config. The
// runtime must render it when forced and ignore it in every other situation.
const DRAFT = { ...CONTENT, status: "draft" };
test("a draft test renders when explicitly forced", () => {
  const r = load({ search: "?lwsplit_preview=" + VARIANT_UUID, config: { tests: [DRAFT] } });
  assert.equal(r.inserted.length, 1);
  assert.equal(r.collects.length, 0);
  assert.equal(r.badge.textContent, "PREVIEW: variant — HERO-COMPARE-01 [draft]", "badge should flag the status");
});
test("a draft test is ignored on a normal pageview even if it leaks into the config", () => {
  const r = load({ config: { tests: [DRAFT] }, vid: VARIANT_ID });
  assert.equal(r.inserted.length, 0, "never bucket a non-running test");
  assert.equal(r.collects.length, 0, "and never record one");
});
test("a draft test is ignored when a DIFFERENT test is being previewed", () => {
  const r = load({
    search: "?lwsplit_preview=" + PRICE.variations[1].id,
    path: PDP_B,
    config: { tests: [DRAFT, PRICE] },
    vid: VARIANT_ID,
  });
  assert.equal(r.inserted.length, 0, "draft must not ride along");
  assert.equal(r.priceWrites.length, 1);
});
test("a bare alias never sweeps in a non-running test", () => {
  const r = load({ search: "?lwsplit_preview=variant", config: { tests: [DRAFT] }, vid: VARIANT_ID });
  assert.equal(r.inserted.length, 0, "draft must not ride along on a generic alias");
  assert.equal(r.badge.textContent, "PREVIEW: nothing forced");
});
test("but an alias DOES work on the keyed draft link the dashboard hands you", () => {
  const r = load({
    search: "?lwsplit_preview=variant&lwsplit_test=" + CONTENT.id + "&lwsplit_key=abc123",
    config: { tests: [DRAFT] },
    inlineConfig: false,
  });
  assert.equal(r.inserted.length, 1);
  assert.equal(r.badge.textContent, "PREVIEW: variant — HERO-COMPARE-01 [draft]");
  assert.equal(r.collects.length, 0);
});
test("config is re-fetched with the key params when previewing a draft", () => {
  const r = load({ search: "?lwsplit_preview=" + VARIANT_UUID + "&lwsplit_test=" + CONTENT.id + "&lwsplit_key=abc123", inlineConfig: false });
  assert.ok(r.configFetch, "should hit /api/split/config");
  assert.match(r.configFetch, /\?test=00000001-1111-4111-8111-000000000001&key=abc123/);
});
test("a rejected key warns instead of silently showing the wrong thing", () => {
  const r = load({ search: "?lwsplit_preview=" + VARIANT_UUID, config: { tests: [], preview_rejected: true } });
  assert.ok(r.warns.some((w) => /preview key rejected/.test(w)));
});

console.log("\npreview badge (req 6)");
test("badge names the arm and the test", () => {
  const r = load({ search: "?lwsplit_preview=variant", vid: CONTROL_ID });
  assert.ok(r.badge, "badge should be mounted");
  assert.equal(r.badge.textContent, "PREVIEW: variant — HERO-COMPARE-01");
});
test("badge reads control for the control arm", () => {
  const r = load({ search: "?lwsplit_preview=control", vid: VARIANT_ID });
  assert.equal(r.badge.textContent, "PREVIEW: control — HERO-COMPARE-01");
});
test("badge trims the long live test name down to its code", () => {
  const live = { ...CONTENT, name: "HERO-COMPARE-01 — Product page — New comparison section" };
  const r = load({ search: "?lwsplit_preview=variant", config: { tests: [live] } });
  assert.equal(r.badge.textContent, "PREVIEW: variant — HERO-COMPARE-01");
  assert.match(r.badge.title, /New comparison section/, "full name kept in the tooltip");
});
test("badge falls back to a short id when the config predates test names", () => {
  const anon = { ...CONTENT };
  delete anon.name;
  const r = load({ search: "?lwsplit_preview=variant", config: { tests: [anon] } });
  assert.equal(r.badge.textContent, "PREVIEW: variant — 00000001");
});
test("badge says so when nothing matched", () => {
  const r = load({ path: "/collections/all", search: "?lwsplit_preview=variant" });
  assert.equal(r.badge.textContent, "PREVIEW: nothing forced");
});

console.log(failures ? `\n${failures} FAILED\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
