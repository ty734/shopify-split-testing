// Unit test for the redirect-mode helpers in public/lw-split.js.
//
// Extracts the REAL function source out of the runtime file (rather than a copy)
// and exercises it against stubbed location/navigator. Run before deploying:
// lw-split.js is live on the storefront, so a syntax-clean but logically wrong
// redirect would send real traffic to the wrong place.
//
//   node scripts/test_redirect.mjs

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/lw-split.js", import.meta.url), "utf8");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in lw-split.js`);
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const PREVIEW_PARAM = "lwsplit_preview";
let location, navigator;
const sandbox = { URL, URLSearchParams, PREVIEW_PARAM, get location() { return location; }, get navigator() { return navigator; } };
let store = {};
const sessionStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
const make = new Function(
  "URL", "URLSearchParams", "PREVIEW_PARAM", "locationRef", "navigatorRef", "sessionStorage",
  `const location = locationRef(), navigator = navigatorRef();
   var SRC_KEY = "_lwsplit_src";
   ${extract("redirectFor")}
   ${extract("redirectUrl")}
   ${extract("isBot")}
   ${extract("trafficSource")}
   return { redirectFor, redirectUrl, isBot, trafficSource };`
);
const api = () => make(URL, URLSearchParams, PREVIEW_PARAM, () => location, () => navigator, sessionStorage);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected: ${expected}\n        actual:   ${actual}`);
}

const ORIGIN = "https://example-store.com";
function at(pathname, search = "") {
  location = { origin: ORIGIN, pathname, search };
  navigator = { userAgent: "Mozilla/5.0 (iPhone)" };
}

console.log("redirect target resolution");
at("/products/example-product", "?fbclid=ABC123&utm_source=facebook&utm_content=podcast");
let { redirectUrl, redirectFor, isBot } = api();
check(
  "carries fbclid + utm through to the destination",
  redirectUrl({ url_path: "/pages/alternate-landing-page" }, null),
  `${ORIGIN}/pages/alternate-landing-page?fbclid=ABC123&utm_source=facebook&utm_content=podcast`
);

at("/products/example-product", "");
({ redirectUrl } = api());
check("bare path, no query", redirectUrl({ url_path: "/pages/x" }, null), `${ORIGIN}/pages/x`);

console.log("\nloop + safety guards");
at("/pages/alternate-landing-page", "?fbclid=1");
({ redirectUrl } = api());
check("self-redirect returns null", redirectUrl({ url_path: "/pages/alternate-landing-page" }, null), null);
check("self-redirect ignores trailing slash", redirectUrl({ url_path: "/pages/alternate-landing-page/" }, null), null);

at("/products/x");
({ redirectUrl } = api());
check("off-origin blocked", redirectUrl({ url_path: "https://evil.example.com/steal" }, null), null);
check("protocol-relative off-origin blocked", redirectUrl({ url_path: "//evil.example.com/x" }, null), null);
check("same-origin absolute allowed", redirectUrl({ url_path: `${ORIGIN}/pages/ok` }, null), `${ORIGIN}/pages/ok`);

console.log("\npreview");
at("/products/x", "?lwsplit_preview=tok123");
({ redirectUrl } = api());
check(
  "preview token carried across the hop",
  redirectUrl({ url_path: "/pages/y" }, "tok123"),
  `${ORIGIN}/pages/y?lwsplit_preview=tok123`
);

console.log("\ndestination query wins over inbound on collision");
at("/products/x", "?discount=INBOUND");
({ redirectUrl } = api());
check(
  "existing dest param not overwritten",
  redirectUrl({ url_path: "/pages/y?discount=PAGEWINS" }, null),
  `${ORIGIN}/pages/y?discount=PAGEWINS`
);

console.log("\nredirectFor picks the right change");
({ redirectFor } = api());
check("finds redirect change", redirectFor({ changes: [{ mode: "inject" }, { mode: "redirect", url_path: "/a" }] })?.url_path, "/a");
check("ignores redirect with no target", redirectFor({ changes: [{ mode: "redirect", url_path: "" }] }), null);
check("no redirect present", redirectFor({ changes: [{ mode: "price" }] }), null);
check("empty variation", redirectFor({}), null);

console.log("\nbot guard");
location = { origin: ORIGIN, pathname: "/x", search: "" };
navigator = { userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" };
check("Googlebot detected", api().isBot(), true);
navigator = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" };
check("real iPhone not flagged", api().isBot(), false);
navigator = { userAgent: "HeadlessChrome/120" };
check("HeadlessChrome (Lighthouse) flagged", api().isBot(), true);

console.log("\ntraffic source (Facebook-only targeting)");
const srcOf = (search) => { store = {}; at("/products/x", search); return api().trafficSource(); };
check("fbclid alone -> meta_paid", srcOf("?fbclid=ABC"), "meta_paid");
check("utm facebook + paid -> meta_paid", srcOf("?utm_source=facebook&utm_medium=paid"), "meta_paid");
check("utm instagram + cpc -> meta_paid", srcOf("?utm_source=instagram&utm_medium=cpc"), "meta_paid");
check("utm ig + paid -> meta_paid", srcOf("?utm_source=ig&utm_medium=paid"), "meta_paid");
// The unpaid_social trap: a naive /paid/ test matches "unpaid_social" and would
// pull ORGANIC social into a paid-only test. Same bug that was fixed in
// lib/classify.ts on the attribution side.
check("unpaid_social is NOT meta_paid", srcOf("?utm_source=facebook&utm_medium=unpaid_social"), "other_tagged");
check("organic social is NOT meta_paid", srcOf("?utm_source=facebook&utm_medium=social"), "other_tagged");
check("gclid -> google_paid", srcOf("?gclid=XYZ"), "google_paid");
check("google + paid -> google_paid", srcOf("?utm_source=google&utm_medium=paid"), "google_paid");
check("klaviyo -> email", srcOf("?utm_source=klaviyo"), "email");
check("no markers -> direct_or_organic", srcOf(""), "direct_or_organic");

// Why this is persisted at all: fbclid/utm exist ONLY on the landing hit, so a
// visitor browsing to a second page would drop out of a paid-only test midway.
store = {};
at("/products/example-product", "?fbclid=ABC123");
check("landing hit records meta_paid", api().trafficSource(), "meta_paid");
at("/products/example-product", "");
check("second pageview with NO params still meta_paid", api().trafficSource(), "meta_paid");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
