/*
 * lw-split — storefront split-test runtime (v0). Served first-party from the
 * lw-split app. Reuses the attribution pixel's identity (_lwvid) and event hook
 * (__lwTrack); it does NOT mint its own id.
 *
 * Storefront load order:
 *   1. anti-flicker head snippet (synchronous — see README §Anti-flicker)
 *   2. lw-pixel.js   (mints _lwvid)
 *   3. lw-split.js   (this file)
 *
 * Config is inlined server-side by the theme embed as window.__LWSPLIT_CONFIG__
 * for zero-flicker; falls back to GET <APP>/api/split/config.
 *
 * QA: ?lwsplit_preview=<variationId|variant|control> forces an arm for the current
 * pageview and records NOTHING (see §Preview below and README §Preview URLs).
 */
(function () {
  "use strict";
  // API origin: set window.__LWSPLIT_API__ in the theme, or it defaults to the origin
  // this script was served from (the split app itself).
  var API = (window.__LWSPLIT_API__ || (function () {
    try { return new URL(document.currentScript.src).origin; } catch (e) { return ""; }
  })());
  var COLLECT = API + "/api/split/collect";
  // Visitor id. Ours is minted by a separate first-party pixel; override the key with
  // window.__LWSPLIT_VID_KEY__. If nothing mints one, start() mints it (see below).
  var VID_KEY = (window.__LWSPLIT_VID_KEY__ || "_lwvid");
  var PREVIEW_PARAM = "lwsplit_preview";
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function getCookie(k) {
    var m = document.cookie.match("(^|;)\\s*" + k + "\\s*=\\s*([^;]+)");
    return m ? m.pop() : null;
  }
  function anonId() {
    try { return localStorage.getItem(VID_KEY) || getCookie(VID_KEY); }
    catch (e) { return getCookie(VID_KEY); }
  }

  // WHOLESALE SAFETY (Layer 1). B2B/wholesale visitors are excluded from ALL tests
  // — never bucketed, never shown a test price, never stamped onto the cart — so
  // their native B2B catalog price is untouched. All four signals are
  // server-rendered by the theme (window.IS_B2B_CUSTOMER, html.b2b-customer class,
  // and the user_type=wholesale / wholesale_user cookies), so this is synchronous
  // and race-free. Layer 2 (the cart-transform Function skipping on purchasingCompany)
  // is the independent backstop on the CHARGE side.
  function isB2B() {
    try {
      if (window.IS_B2B_CUSTOMER === true) return true;
      var el = document.documentElement;
      if (el && el.classList && el.classList.contains("b2b-customer")) return true;
      if (/(?:^|;\s*)user_type=wholesale/.test(document.cookie)) return true;
      if (/(?:^|;\s*)wholesale_user=true/.test(document.cookie)) return true;
    } catch (e) {}
    return false;
  }

  function formatMoney(amt) {
    try {
      var cur = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || "USD";
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(amt);
    } catch (e) { return "$" + Number(amt).toFixed(2); }
  }

  // Stamp ONLY the bucket decision ("<testId>:<variationId>") onto the cart, never a
  // price. The Function looks up the authoritative charge price from its own metafield,
  // so a forged attribute can at most pick a variation (which is a no-op / opt-in to the
  // higher test price), never set an arbitrary price. Guarded so we don't re-POST every
  // pageview once the cart already carries the value.
  function stampCart(value) {
    try {
      if (sessionStorage.getItem("_lwsplit_stamp") === value) return;
      fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: { _lwsplit_price: value } }),
        keepalive: true,
      }).then(function () { try { sessionStorage.setItem("_lwsplit_stamp", value); } catch (e) {} });
    } catch (e) {}
  }

  // Deterministic sticky bucket: FNV-1a(anonId + ':' + salt) -> 0..9999.
  function bucketOf(id, salt) {
    var s = id + ":" + salt, h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % 10000;
  }
  function pick(id, test) {
    var salt = test.exclusion_group || test.id;
    var b = bucketOf(id, salt) / 100;
    var cum = 0;
    for (var i = 0; i < test.variations.length; i++) {
      cum += test.variations[i].percentage;
      if (b < cum) return test.variations[i];
    }
    return test.variations[test.variations.length - 1];
  }

  // Traffic source for audience targeting, e.g. "run this test on Facebook ad
  // traffic only".
  //
  // Derived from the landing URL and then PERSISTED for the session: utm_source
  // and fbclid exist only on the click that lands, so a visitor who browses to a
  // second page would otherwise stop matching mid-session — they would be in the
  // test on one pageview and out of it on the next.
  //
  // fbclid is checked before utm_source because Meta appends it to every ad click
  // automatically, whereas utm tags depend on the URL being built correctly. Real
  // example: an ad shipped `{{ad.name}}` unrendered, so its utm
  // values were garbage while fbclid was still perfectly good.
  var SRC_KEY = "_lwsplit_src";
  function trafficSource() {
    try {
      var q = new URLSearchParams(location.search);
      var utmSource = (q.get("utm_source") || "").toLowerCase();
      var utmMedium = (q.get("utm_medium") || "").toLowerCase();
      var paid = /(^|[^a-z])(paid|cpc|ppc)/.test(utmMedium);
      var src = null;

      if (q.get("fbclid")) src = "meta_paid";
      else if (paid && /facebook|instagram|meta|^fb$|^ig$|^an$/.test(utmSource)) src = "meta_paid";
      else if (q.get("gclid") || q.get("wbraid") || q.get("gbraid")) src = "google_paid";
      else if (paid && /google/.test(utmSource)) src = "google_paid";
      else if (q.get("ttclid")) src = "tiktok_paid";
      else if (/klaviyo|email/.test(utmSource) || /email|flow|campaign/.test(utmMedium)) src = "email";
      else if (utmSource) src = "other_tagged";

      if (src) { try { sessionStorage.setItem(SRC_KEY, src); } catch (e) {} return src; }
      // No markers on THIS url — fall back to what this session landed as.
      try { return sessionStorage.getItem(SRC_KEY) || "direct_or_organic"; }
      catch (e) { return "direct_or_organic"; }
    } catch (e) { return "direct_or_organic"; }
  }

  function ctx() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { q = new URLSearchParams(""); }
    return {
      urlPath: location.pathname,
      device: matchMedia("(max-width: 749px)").matches ? "mobile" : "desktop",
      visitor: sessionStorage.getItem("_lwsid") ? "returning" : "new",
      trafficSource: trafficSource(),
      utm_source: q.get("utm_source"),
      utm_medium: q.get("utm_medium"),
      utm_campaign: q.get("utm_campaign"),
      country: null,
    };
  }
  function opMatch(op, actual, value) {
    if (actual == null) return op === "isNull" || op === "notEquals";
    switch (op) {
      case "equals": return actual === value;
      case "notEquals": return actual !== value;
      case "contains": return actual.indexOf(value) !== -1;
      case "startsWith": return actual.indexOf(value) === 0;
      case "endsWith": return value ? actual.slice(-value.length) === value : true;
      case "regex": try { return new RegExp(value).test(actual); } catch (e) { return false; }
      default: return false;
    }
  }
  function targeted(rules, c) {
    if (!rules || !rules.length) return true;
    var groups = {};
    rules.forEach(function (r) { (groups[r.rule_group] = groups[r.rule_group] || []).push(r); });
    return Object.keys(groups).some(function (g) {
      return groups[g].every(function (r) { return opMatch(r.op, c[r.key], r.value); });
    });
  }

  // ─── Preview (QA) ────────────────────────────────────────────────────────────
  // Intelligems parity: open a live page and force a specific arm without touching
  // the sticky bucket. A preview pageview is INERT — no exposure/analytics beacon,
  // no cart stamp, no __lwTrack hook, no write to _lwvid — so QA traffic can never
  // pollute a running test's results.
  //
  // The param is read as PRESENCE, not value: `?lwsplit_preview` with a missing,
  // empty or unrecognized value still suppresses analytics (it just forces nothing).
  // A fumbled QA URL must never silently record a real exposure.
  function previewToken() {
    try {
      var p = new URLSearchParams(location.search);
      if (!p.has(PREVIEW_PARAM)) return null;        // absent → normal operation
      return (p.get(PREVIEW_PARAM) || "").trim();    // present → preview mode ("" = unresolved)
    } catch (e) { return null; }
  }
  function warn(msg) { try { console.warn("[lw-split preview] " + msg); } catch (e) {} }

  // Draft preview: the dashboard's "copy preview link" for a non-running test appends
  // ?lwsplit_test=<id>&lwsplit_key=<key>. Those are forwarded to /api/split/config,
  // which then compiles that one extra test (key-verified server-side). Absent these,
  // the config only ever contains running tests, exactly as before.
  function previewTestParam() {
    try {
      var p = new URLSearchParams(location.search);
      return p.has(PREVIEW_PARAM) ? p.get("lwsplit_test") : null;
    } catch (e) { return null; }
  }
  function previewConfigQuery() {
    try {
      var p = new URLSearchParams(location.search);
      if (!p.has(PREVIEW_PARAM)) return "";
      var t = p.get("lwsplit_test"), k = p.get("lwsplit_key");
      if (!t || !k) return "";
      return "?test=" + encodeURIComponent(t) + "&key=" + encodeURIComponent(k);
    } catch (e) { return ""; }
  }
  // Badge label. Test names are long ("HERO-COMPARE-01 — Product page — New
  // comparison section"); the leading code is the useful part, and the full name still
  // goes in the badge's title tooltip. Falls back to a short id on older configs.
  function testLabel(t) {
    var n = t.name;
    if (!n) return String(t.id).slice(0, 8);
    n = String(n).split(/\s+[—–-]\s+/)[0].trim() || String(n).trim();
    return n.length > 42 ? n.slice(0, 41) + "…" : n;
  }

  function armOf(test, alias) {
    var vs = test.variations || [], hits = [], i;
    for (i = 0; i < vs.length; i++) {
      if (alias === "control" ? !!vs[i].is_control : !vs[i].is_control) hits.push(vs[i]);
    }
    if (hits.length > 1) {
      warn('"' + testLabel(test) + '" has ' + hits.length + " " + alias +
           " variations; previewing the first. Pass its variation id to pick another.");
    }
    return hits[0] || null;
  }

  // token → { map: {testId: variation}, tests: [{test, variation}], alias }
  //  - <variationId> (UUID): forces exactly that variation and BYPASSES its test's
  //    targeting rules, so a test can be eyeballed on a page/device it doesn't
  //    target yet. Its selectors still have to exist on the page to render.
  //  - "control" / "variant": applies to EVERY running test whose PAGE rules match
  //    this URL (audience rules are ignored so a mobile-only test previews on
  //    desktop). On a page with several matching tests all of them are forced and a
  //    console warning names them — use the UUID form to force exactly one.
  // Tests not named by the token keep their normal cookie bucket, so the rest of the
  // page looks like real traffic.
  function resolvePreview(config, token, c) {
    var pv = { token: token, map: {}, tests: [], alias: null };
    var tests = config.tests || [];
    var i, j, t, v;

    if (UUID_RE.test(token)) {
      for (i = 0; i < tests.length; i++) {
        t = tests[i];
        for (j = 0; j < (t.variations || []).length; j++) {
          v = t.variations[j];
          if (String(v.id).toLowerCase() === token.toLowerCase()) {
            pv.map[t.id] = v;
            pv.tests.push({ test: t, variation: v });
            return pv;
          }
        }
      }
      warn('no running test has a variation "' + token + '" — nothing forced. ' +
           "(Only tests with status=running are in the config.)");
      return pv;
    }

    var alias = token.toLowerCase();
    if (alias !== "control" && alias !== "variant") {
      warn((token ? 'unrecognized value "' + token + '"' : "no value given") +
           " — use control, variant, or a variation id. Nothing forced; " +
           "this pageview is still excluded from analytics.");
      return pv;
    }
    pv.alias = alias;
    // A bare alias only ever sweeps in RUNNING tests. A non-running one has to be the
    // test explicitly named by ?lwsplit_test= (i.e. you opened a keyed draft link on
    // purpose) — so a draft can never ride along on a generic ?lwsplit_preview=variant.
    var named = previewTestParam();

    for (i = 0; i < tests.length; i++) {
      t = tests[i];
      if (t.status && t.status !== "running" && t.id !== named) continue;
      var pageRules = (t.rules || []).filter(function (r) { return r.scope === "page"; });
      if (!targeted(pageRules, c)) continue;
      v = armOf(t, alias);
      if (!v) { warn('"' + testLabel(t) + '" has no ' + alias + " variation — skipped."); continue; }
      pv.map[t.id] = v;
      pv.tests.push({ test: t, variation: v });
    }

    if (!pv.tests.length) {
      warn("no running test targets " + location.pathname + " — nothing forced.");
    } else if (pv.tests.length > 1) {
      warn('"' + alias + '" applied to ' + pv.tests.length + " tests on this page (" +
           pv.tests.map(function (x) { return testLabel(x.test); }).join(", ") +
           "). Pass a variation id to force exactly one.");
    }
    return pv;
  }

  // Fixed top-right marker so a forced view is never mistaken for real traffic.
  // Click to dismiss. Inline styles only — nothing added to the page's stylesheet.
  function renderBadge(pv) {
    var text, title;
    if (!pv.tests.length) {
      text = "PREVIEW: nothing forced";
      title = 'lw-split: "' + (pv.token || "(no value)") + '" matched no running test. Analytics are still off for this pageview.';
    } else if (pv.tests.length === 1) {
      var one = pv.tests[0];
      var st = one.test.status && one.test.status !== "running" ? " [" + one.test.status + "]" : "";
      text = "PREVIEW: " + (one.variation.is_control ? "control" : "variant") + " — " + testLabel(one.test) + st;
      title = "lw-split forced view — " + (one.test.name || one.test.id) +
              " / variation " + one.variation.id + ". No exposure recorded.";
    } else {
      text = "PREVIEW: " + pv.alias + " — " + pv.tests.length + " tests";
      title = "lw-split forced view: " +
              pv.tests.map(function (x) { return testLabel(x.test) + " → " + x.variation.id; }).join(" | ") +
              ". No exposures recorded.";
    }
    function mount() {
      try {
        if (document.getElementById("__lwsplit_preview_badge__")) return;
        var b = document.createElement("div");
        b.id = "__lwsplit_preview_badge__";
        b.textContent = text;
        b.title = title + " Click to dismiss.";
        b.setAttribute("data-lwsplit-preview", pv.token || "");
        b.style.cssText = [
          "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
          "background:#111", "color:#fff", "padding:6px 10px",
          "font:600 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace",
          "letter-spacing:.02em", "border-radius:0", "box-shadow:0 2px 8px rgba(0,0,0,.35)",
          "cursor:pointer", "pointer-events:auto", "max-width:60vw",
        ].join(";");
        b.addEventListener("click", function () { b.remove(); });
        document.body.appendChild(b);
      } catch (e) {}
    }
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── redirect mode ────────────────────────────────────────────────────────────
  // Split-URL testing: send an arm to a different page instead of mutating this
  // one. Used to test a whole alternate page (e.g. a discount landing page against
  // the product page) WITHOUT touching the ads, which would reset Meta's learning phase.
  //
  // Destination lives in url_path (reused: in price mode that column scopes a
  // rewrite; here it is the target). Which pages a redirect fires on is decided by
  // the test's page-scope rules, not by this column.
  //
  // Caveat worth remembering when reading results: the redirected arm pays an
  // extra page load the control does not, so a split-URL test is inherently
  // biased AGAINST the redirect arm. Firing from the synchronous head snippet
  // keeps that cost to a redirect round-trip rather than a wasted full render.
  function redirectFor(v) {
    var list = v.changes || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].mode === "redirect" && list[i].url_path) return list[i];
    }
    return null;
  }

  // Same-origin only, query preserved, no self-redirect. Returns null if the hop
  // should not happen.
  function redirectUrl(change, preview) {
    var dest;
    try {
      dest = new URL(change.url_path, location.origin);
    } catch (e) { return null; }
    // Never send storefront traffic off-site from a test config.
    if (dest.origin !== location.origin) return null;
    // Loop guard: already there (or the config points at this very page).
    if (dest.pathname.replace(/\/+$/, "") === location.pathname.replace(/\/+$/, "")) return null;
    // Carry the inbound query through — fbclid / utm_* are what attribution and
    // the funnel map key on, so dropping them would orphan every redirected click.
    var cur = new URLSearchParams(location.search);
    cur.forEach(function (val, key) {
      if (!dest.searchParams.has(key)) dest.searchParams.set(key, val);
    });
    // Keep a QA session in preview across the hop.
    if (preview !== null && preview !== undefined) dest.searchParams.set(PREVIEW_PARAM, preview);
    return dest.toString();
  }

  // Crawlers must never be bucketed into a redirect: it would make the PDP look
  // like it 302s to a discount page. Cheap insurance on top of page rules.
  function isBot() {
    return /bot|crawl|spider|slurp|bingpreview|headlesschrome|lighthouse|gtmetrix|pingdom/i
      .test(navigator.userAgent || "");
  }

  function apply(change) {
    if (change.mode === "redirect") return; // handled in run(), before side effects
    if (change.mode === "inject") {
      if (change.custom_css) {
        var st = document.createElement("style");
        st.textContent = change.custom_css;
        document.head.appendChild(st);
      }
      if (change.custom_js) { try { new Function(change.custom_js)(); } catch (e) {} }
      return;
    }
    if (change.mode === "price") {
      // Display side only: rewrite the visible price text to the test price. The
      // matching CHARGE happens in the cart-transform Function via the stamped
      // attribute (see run()). Control variations carry no test_price → skipped.
      if (change.test_price == null) return;
      // Multi-SKU price test: a variation can hold one price change per product, all
      // using the same price selector — only rewrite on the PDP this change targets.
      if (change.url_path && location.pathname !== change.url_path) return;
      var txt = formatMoney(change.test_price);
      (change.selectors || []).forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) { el.textContent = txt; });
      });
      return;
    }
    (change.selectors || []).forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (change.op === "remove") el.remove();
        else if (change.op === "replace") el.outerHTML = change.html;
        else if (change.op === "insert") el.insertAdjacentHTML(change.insert_type || "beforeend", change.html);
      });
    });
  }

  function reveal() { if (window.__LWSPLIT_REVEAL__) try { window.__LWSPLIT_REVEAL__(); } catch (e) {} }

  function beacon(payload) {
    try {
      var blob = new Blob([JSON.stringify(payload)], { type: "text/plain" });
      if (!navigator.sendBeacon || !navigator.sendBeacon(COLLECT, blob)) {
        fetch(COLLECT, { method: "POST", body: JSON.stringify(payload), keepalive: true });
      }
    } catch (e) {}
  }

  // The pixel (lw-pixel.js) mints _lwvid; both scripts load async, so on a brand-
  // new visitor ours can run first. Wait briefly for the id rather than bail.
  // Fallback id for stores without a pixel that mints one. Stored in localStorage and
  // a 1-year first-party cookie. NOTE: orders only attribute if this id also reaches
  // the order (e.g. as a cart attribute). See DATA-CONTRACT.md.
  function mintId() {
    try {
      var v = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      try { localStorage.setItem(VID_KEY, v); } catch (e) {}
      document.cookie = VID_KEY + "=" + v + ";path=/;max-age=31536000;SameSite=Lax";
      return v;
    } catch (e) { return null; }
  }
  function start(config) {
    var preview = previewToken();
    if (preview !== null) {
      if (config && config.preview_rejected) {
        warn("preview key rejected — showing running tests only. Re-copy the link from the dashboard (keys change if the app secret rotates).");
      }
      // QA is usually done in a fresh/incognito window where the pixel hasn't minted
      // an id yet. A forced arm doesn't need one, and nothing is recorded either way,
      // so don't sit through the id wait — run immediately.
      return run(config, anonId() || "__lwsplit_preview__", preview);
    }
    var tries = 12;
    (function attempt() {
      var id = anonId();
      if (id) return run(config, id, null);
      if (--tries <= 0) {                    // ~1.8s and nobody minted an id:
        if (window.__LWSPLIT_MINT_ID__ === false) return reveal();
        id = mintId();                       // mint our own so the kit works standalone
        return id ? run(config, id, null) : reveal();
      }
      setTimeout(attempt, 150);
    })();
  }

  function run(config, id, preview) {
    // WHOLESALE SAFETY (Layer 1): wholesale is excluded from every test. Reveal the
    // page untouched and stop — no bucketing, no price rewrite, no cart stamp.
    // Preview is no exception: a B2B session must never render test content.
    if (isB2B()) {
      if (preview !== null) warn("wholesale/B2B session — excluded from all tests, preview included. Nothing forced.");
      reveal(); return;
    }

    var c = ctx();
    var pv = preview === null ? null : resolvePreview(config, preview, c);
    var exposures = [];
    var priceStamp = null;          // value to write onto the cart
    var priceTestMatched = false;   // did a PRICE test apply to this page at all?
    var pendingRedirect = null;     // split-URL arm: where we're sending this visitor
    // PASS 1 — resolve every test's arm WITHOUT applying anything or recording it.
    //
    // A redirect has to be discovered before any other test renders or is counted.
    // Otherwise a visitor who is about to leave the page still gets an exposure
    // recorded for the tests that live on it, and then vanishes — feeding those
    // tests visitors who could never convert. We hit this: a content test ran on
    // the same product page a redirect test targeted, so every redirected visitor
    // would have diluted both of its arms.
    var resolved = [];
    (config.tests || []).forEach(function (test) {
      var forced = pv ? pv.map[test.id] : null;
      var v;
      // A keyed draft preview puts ONE non-running test in the config. It may only ever
      // render as the explicitly forced arm — never bucketed, never alongside real
      // traffic. Belt and braces: the config wouldn't contain it without a valid key.
      if (test.status && test.status !== "running" && !forced) return;
      if (forced) {
        v = forced;                 // targeting deliberately bypassed for the forced arm
      } else {
        var pageRules = (test.rules || []).filter(function (r) { return r.scope === "page"; });
        var audRules = (test.rules || []).filter(function (r) { return r.scope === "audience"; });
        if (!targeted(pageRules, c) || !targeted(audRules, c)) return;
        v = pick(id, test);         // untouched sticky bucket, even during a preview
      }
      resolved.push({ test: test, v: v });
    });

    // PASS 2 — does any resolved arm redirect? First one wins if a visitor somehow
    // buckets into two. An arm whose target is invalid (self-redirect, off-origin,
    // malformed) is treated as control rather than stranding the visitor.
    var hit = null;
    for (var ri = 0; ri < resolved.length && !hit; ri++) {
      var rdr = redirectFor(resolved[ri].v);
      if (!rdr || isBot()) continue;
      var target = redirectUrl(rdr, preview);
      if (target) hit = { entry: resolved[ri], target: target };
    }

    if (hit) {
      // Leaving: record ONLY the redirect test, render nothing.
      pendingRedirect = hit.target;
      exposures.push({ test_id: hit.entry.test.id, variation_id: hit.entry.v.id });
    } else {
      resolved.forEach(function (r) {
        (r.v.changes || []).forEach(apply);
        exposures.push({ test_id: r.test.id, variation_id: r.v.id });
        // If THIS test is a price test (any variation carries a price change), record the
        // stamp to write: variant-with-price → "testId:variationId"; control (or a variant
        // with no price) → "" which OVERWRITES any stale stamp so the Function no-ops.
        // Only written when a price test actually matched this page (§below), so the stamp
        // still persists to checkout on non-test pages.
        var isPriceTest = (r.test.variations || []).some(function (vv) {
          return (vv.changes || []).some(function (ch) { return ch.mode === "price"; });
        });
        if (isPriceTest) {
          priceTestMatched = true;
          var hasPrice = (r.v.changes || []).some(function (ch) { return ch.mode === "price" && ch.test_price != null; });
          priceStamp = hasPrice ? (r.test.id + ":" + r.v.id) : "";
        }
      });
    }
    // PREVIEW STOPS HERE. Everything below this line is a side effect that would
    // either pollute results (exposure/funnel beacons) or outlive the pageview (the
    // cart stamp), which is exactly what a forced view must not do. The DOM changes
    // above have already been applied; reveal the page and mark it as a preview.
    // NOTE for price tests: the DISPLAY price is rewritten but the cart is NOT
    // stamped, so a previewed price variant still CHARGES the control price. That is
    // intentional — verify the charge by bucketing into the arm for real.
    // REDIRECT ARMS LEAVE HERE. The exposure must go out BEFORE navigating or it is
    // lost — beacon() uses sendBeacon/keepalive precisely so it survives unload.
    // location.replace, not href, so Back doesn't bounce the visitor into a loop.
    // A preview redirects too (so QA can see the hop) but records nothing.
    if (pendingRedirect) {
      if (!pv && exposures.length) {
        beacon({ anon_id: id, name: "exposure", ctx: c, exposures: exposures });
      }
      // If navigation is blocked for any reason, don't leave the page hidden behind
      // the anti-flicker gate.
      setTimeout(reveal, 1500);
      location.replace(pendingRedirect);
      return;
    }

    if (pv) { reveal(); renderBadge(pv); return; }

    if (priceTestMatched) stampCart(priceStamp);
    reveal();
    if (exposures.length) beacon({ anon_id: id, name: "exposure", ctx: c, exposures: exposures });

    // Piggyback the pixel's funnel signals so we don't re-instrument ATC/checkout.
    var orig = window.__lwTrack;
    window.__lwTrack = function (type) {
      if (exposures.length) beacon({ anon_id: id, name: type, ctx: c, exposures: exposures });
      if (typeof orig === "function") return orig(type);
    };
  }

  // A keyed draft preview must always go to the API: the inlined/edge-cached config
  // only ever holds running tests.
  var pvq = previewConfigQuery();
  var cfg = window.__LWSPLIT_CONFIG__;
  if (cfg && !pvq) start(cfg);
  else fetch(API + "/api/split/config" + pvq, { credentials: "omit" })
        .then(function (r) { return r.json(); }).then(start).catch(reveal);
})();
