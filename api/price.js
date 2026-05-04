let cache = null;
let cacheTime = 0;

// ── CACHE DURATION ──
// Set to 0 to force a fresh fetch on every request (use temporarily to bust stale cache).
// Change back to 60 * 60 * 1000 (60 min) once prices are confirmed correct.
const CACHE_DURATION = 0; // TODO: change back to 60 * 60 * 1000 after confirming prices are correct

const TROY = 31.1035;
const GRAMS_PER_UNIT = 0.9950;

export default async function handler(req, res) {
  try {
    if (cache && Date.now() - cacheTime < CACHE_DURATION) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).json({ ...cache, cached: true });
    }

    const GOLD_API_KEY        = process.env.GOLD_API_KEY;        // goldapi.io key (optional)
    const METAL_PRICE_API_KEY = process.env.METAL_PRICE_API_KEY; // metalpriceapi.com key (optional)
    const GOLDPRICEZ_API_KEY  = process.env.GOLDPRICEZ_API_KEY;  // goldpricez.com key (optional, free tier)

    async function withTimeout(promise, ms = 8000) {
      return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
      ]);
    }

    // ══════════════════════════════════════════════════════════════
    // STEP 1: USD/INR
    // Current rate May 2026 ≈ 94.90–95.10
    // Hardcoded fallback = 95.0 (was wrongly 84.5 — caused all prices to be ~10% low)
    // ══════════════════════════════════════════════════════════════
    let usdInr = null;

    const fxAttempts = [
      // 1a. fawazahmed0 primary CDN
      async () => {
        const r = await withTimeout(fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", { headers: { Accept: "application/json" } }), 5000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.usd?.inr ?? null;
      },
      // 1b. fawazahmed0 pages.dev fallback
      async () => {
        const r = await withTimeout(fetch("https://latest.currency-api.pages.dev/v1/currencies/usd.json", { headers: { Accept: "application/json" } }), 5000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.usd?.inr ?? null;
      },
      // 1c. Frankfurter (ECB data, very reliable)
      async () => {
        const r = await withTimeout(fetch("https://api.frankfurter.app/latest?from=USD&to=INR"), 5000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.rates?.INR ?? null;
      },
      // 1d. Open Exchange Rates
      async () => {
        const r = await withTimeout(fetch("https://open.er-api.com/v6/latest/USD"), 5000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.rates?.INR ?? null;
      },
      // 1e. Yahoo Finance USDINR=X (query1)
      async () => {
        const r = await withTimeout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d", { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }), 6000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
      },
      // 1f. Yahoo Finance USDINR=X (query2)
      async () => {
        const r = await withTimeout(fetch("https://query2.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d", { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }), 6000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
      },
    ];

    for (const attempt of fxAttempts) {
      try {
        const rate = await attempt();
        if (rate && rate > 75 && rate < 120) {
          usdInr = rate;
          console.log(`USD/INR live: ${usdInr.toFixed(4)}`);
          break;
        }
      } catch(e) {}
    }

    if (!usdInr) {
      usdInr = 95.0; // Updated May 2026 — was incorrectly 84.5
      console.log("USD/INR: all sources failed, using fallback 95.0");
    }

    const aedInr = usdInr / 3.6725;
    console.log(`USD/INR: ${usdInr.toFixed(4)} | AED/INR: ${aedInr.toFixed(4)}`);

    // ══════════════════════════════════════════════════════════════
    // STEP 2: XAU/USD — international gold spot price
    // ══════════════════════════════════════════════════════════════
    let goldPriceUSD = null, goldSource = "unknown";

    // 2a. goldprice.org (very reliable, no key)
    try {
      const r = await withTimeout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } }));
      if (r.ok) { const d = await r.json(); const x = d?.items?.[0]?.xauPrice; if (x > 1000) { goldPriceUSD = x; goldSource = "goldprice.org"; } }
    } catch(e) {}

    // 2b. gold-api.com (free, no key, no rate limit)
    if (!goldPriceUSD) {
      try {
        const r = await withTimeout(fetch("https://gold-api.com/price/XAU", { headers: { Accept: "application/json" } }));
        if (r.ok) { const d = await r.json(); if (d?.price > 1000) { goldPriceUSD = d.price; goldSource = "gold-api.com"; } }
      } catch(e) {}
    }

    // 2c. metals.live
    if (!goldPriceUSD) {
      try {
        const r = await withTimeout(fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } }));
        if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const x = item?.gold ?? item?.XAU; if (x > 1000) { goldPriceUSD = x; goldSource = "metals.live"; } }
      } catch(e) {}
    }

    // 2d. Yahoo Finance GC=F (query1)
    if (!goldPriceUSD) {
      try {
        const r = await withTimeout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }));
        if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 1000) { goldPriceUSD = p; goldSource = "yahoo-gc-q1"; } }
      } catch(e) {}
    }

    // 2e. Yahoo Finance GC=F (query2)
    if (!goldPriceUSD) {
      try {
        const r = await withTimeout(fetch("https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }));
        if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 1000) { goldPriceUSD = p; goldSource = "yahoo-gc-q2"; } }
      } catch(e) {}
    }

    // 2f. goldapi.io (requires key)
    if (!goldPriceUSD && GOLD_API_KEY) {
      try {
        const r = await withTimeout(fetch("https://www.goldapi.io/api/XAU/USD", { headers: { "x-access-token": GOLD_API_KEY } }));
        if (r.ok) { const d = await r.json(); if (d?.price > 1000) { goldPriceUSD = d.price; goldSource = "goldapi.io"; } }
      } catch(e) {}
    }

    // 2g. metalpriceapi.com (requires key)
    if (!goldPriceUSD && METAL_PRICE_API_KEY) {
      try {
        const r = await withTimeout(fetch(`https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`));
        if (r.ok) { const d = await r.json(); if (d?.rates?.USD > 0) { goldPriceUSD = d.rates.USD; goldSource = "metalpriceapi.com"; } }
      } catch(e) {}
    }

    if (!goldPriceUSD) throw new Error("All gold spot price sources failed");

    const calc24k = (goldPriceUSD / TROY) * usdInr;
    console.log(`XAU/USD: $${goldPriceUSD.toFixed(2)} [${goldSource}] | calc24k: Rs.${calc24k.toFixed(2)}/g`);

    // ══════════════════════════════════════════════════════════════
    // STEP 3: XAG/USD — silver spot price
    // ══════════════════════════════════════════════════════════════
    let silverUSD = null;
    try { const r = await withTimeout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } })); if (r.ok) { const d = await r.json(); const x = d?.items?.[0]?.xagPrice; if (x > 0) silverUSD = x; } } catch(e) {}
    if (!silverUSD) { try { const r = await withTimeout(fetch("https://gold-api.com/price/XAG", { headers: { Accept: "application/json" } })); if (r.ok) { const d = await r.json(); if (d?.price > 0) silverUSD = d.price; } } catch(e) {} }
    if (!silverUSD) { try { const r = await withTimeout(fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } })); if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const x = item?.silver ?? item?.XAG; if (x > 0) silverUSD = x; } } catch(e) {} }
    if (!silverUSD) { try { const r = await withTimeout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=1d", { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } })); if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 0) silverUSD = p; } } catch(e) {} }
    if (!silverUSD) silverUSD = goldPriceUSD / 85;

    // ══════════════════════════════════════════════════════════════
    // STEP 4: IBJA India gold rate — 9-source chain
    //
    // Target: Rs./gram for 999 purity (24K) as published by IBJA daily ~10am IST
    //
    // ibjaCheck: absolute range Rs.5,000–30,000/gram
    // Covers gold from $1,500/oz to $5,000/oz at any USD/INR between 75–120
    // Old percentage-based check was rejecting valid values when gold surged
    //
    // toPerGram: handles per-100g (>50000), per-10g (>10000), per-gram as-is
    // ══════════════════════════════════════════════════════════════
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSource = "none";

    const ibjaCheck = (val) => {
      const n = parseFloat(val);
      return n > 5000 && n < 30000;
    };

    const toPerGram = (v) => {
      const n = parseFloat(v);
      if (!n || n <= 0) return null;
      if (n > 50000) return n / 100; // per 100g (e.g. Rs.1500000)
      if (n > 10000) return n / 10;  // per 10g  (e.g. Rs.150000)
      return n;                       // per gram (e.g. Rs.15000)
    };

    // ── IBJA Source 1: goldpricez.com INR/gram API (direct India rate, most reliable) ──
    // Returns India gold price per gram in INR directly — no conversion needed
    // Free tier available at goldpricez.com/key/registration
    // Add GOLDPRICEZ_API_KEY to your Vercel environment variables
    if (!ibja24k && GOLDPRICEZ_API_KEY) {
      try {
        const r = await withTimeout(fetch(
          "https://goldpricez.com/api/rates/currency/inr/measure/gram",
          { headers: { Accept: "application/json", "X-API-KEY": GOLDPRICEZ_API_KEY } }
        ), 7000);
        if (r.ok) {
          const d = await r.json();
          console.log("goldpricez.com INR/gram RAW:", JSON.stringify(d).slice(0, 300));
          // Response shape: { "gold_price_per_gram_24k": 15093.xx, ... }
          const raw =
            d?.gold_price_per_gram_24k ?? d?.price_gram_24k ??
            d?.gram_24k ?? d?.["24k"] ??
            d?.rates?.gram_24k ?? d?.data?.gram_24k;
          if (raw) {
            const per1g = parseFloat(raw);
            console.log("goldpricez INR/gram 24k:", per1g);
            if (ibjaCheck(per1g)) {
              ibja24k = per1g;
              ibja22k = ibja24k * 0.916;
              ibja995 = ibja24k * 0.995;
              ibjaSource = "goldpricez.com";
              console.log("IBJA from goldpricez: Rs." + ibja24k.toFixed(2) + "/g");
            }
          }
        } else { console.log("goldpricez.com HTTP", r.status); }
      } catch(e) { console.log("goldpricez.com error:", e.message); }
    }

    // ── IBJA Source 2: ibjarates.com official API ──
    // Logs full raw response — check Vercel logs to see exact JSON keys
    if (!ibja24k) {
      try {
        const r = await withTimeout(fetch("https://ibjarates.com/api/goldrates", {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)" }
        }), 6000);
        if (r.ok) {
          const d = await r.json();
          console.log("ibjarates.com RAW:", JSON.stringify(d).slice(0, 600));
          const raw999 =
            d?.Gold999 ?? d?.gold999 ?? d?.GOLD999 ??
            d?.["999"] ?? d?.rate999 ?? d?.Rate999 ?? d?.price999 ??
            d?.data?.Gold999 ?? d?.data?.gold999 ?? d?.data?.["999"] ??
            d?.rates?.["999"] ?? d?.rates?.Gold999 ??
            (Array.isArray(d) ? d.find(x => x?.purity === "999" || x?.karat === "24")?.rate : null) ??
            (Array.isArray(d?.data) ? d.data.find(x => x?.purity === "999" || x?.karat === "24")?.rate : null);
          const raw916 =
            d?.Gold916 ?? d?.gold916 ?? d?.["916"] ?? d?.rate916 ?? d?.Rate916 ??
            d?.data?.Gold916 ?? d?.data?.gold916 ?? d?.data?.["916"] ??
            (Array.isArray(d) ? d.find(x => x?.purity === "916" || x?.karat === "22")?.rate : null) ??
            (Array.isArray(d?.data) ? d.data.find(x => x?.purity === "916" || x?.karat === "22")?.rate : null);
          const raw995 =
            d?.Gold995 ?? d?.gold995 ?? d?.["995"] ?? d?.rate995 ?? d?.Rate995 ??
            d?.data?.Gold995 ?? d?.data?.gold995 ?? d?.data?.["995"] ??
            (Array.isArray(d) ? d.find(x => x?.purity === "995")?.rate : null) ??
            (Array.isArray(d?.data) ? d.data.find(x => x?.purity === "995")?.rate : null);
          if (raw999) {
            const per1g = toPerGram(raw999);
            console.log("ibjarates raw999:", raw999, "-> per1g:", per1g);
            if (per1g && ibjaCheck(per1g)) {
              ibja24k = per1g;
              ibja22k = raw916 ? (toPerGram(raw916) ?? ibja24k * 0.916) : ibja24k * 0.916;
              ibja995 = raw995 ? (toPerGram(raw995) ?? ibja24k * 0.995) : ibja24k * 0.995;
              ibjaSource = "ibjarates.com";
              console.log("IBJA from ibjarates.com: Rs." + ibja24k.toFixed(2));
            }
          }
        } else { console.log("ibjarates.com HTTP", r.status); }
      } catch(e) { console.log("ibjarates.com error:", e.message); }
    }

    // ── IBJA Source 3: Yahoo Finance MCX Gold query1 ──
    // GOLD.MCX / GOLDM.MCX price is Rs. per 10g — divide by 10
    if (!ibja24k) {
      for (const sym of ["GOLD.MCX", "GOLDM.MCX"]) {
        if (ibja24k) break;
        try {
          const r = await withTimeout(fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
            { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
          ), 7000);
          if (r.ok) {
            const d = await r.json();
            const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
            console.log(`Yahoo q1 MCX ${sym}: raw=${price}`);
            if (price > 0) {
              const per1g = toPerGram(price);
              console.log(`Yahoo q1 MCX ${sym}: per1g=${per1g}`);
              if (per1g && ibjaCheck(per1g)) {
                ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
                ibjaSource = `yahoo-q1-${sym}`;
                console.log(`IBJA from ${sym}: Rs.${ibja24k.toFixed(2)}/g`);
              }
            }
          } else { console.log(`Yahoo q1 ${sym} HTTP`, r.status); }
        } catch(e) { console.log(`Yahoo q1 ${sym}:`, e.message); }
      }
    }

    // ── IBJA Source 4: Yahoo Finance MCX Gold query2 ──
    if (!ibja24k) {
      for (const sym of ["GOLD.MCX", "GOLDM.MCX"]) {
        if (ibja24k) break;
        try {
          const r = await withTimeout(fetch(
            `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
            { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
          ), 7000);
          if (r.ok) {
            const d = await r.json();
            const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
            console.log(`Yahoo q2 MCX ${sym}: raw=${price}`);
            if (price > 0) {
              const per1g = toPerGram(price);
              if (per1g && ibjaCheck(per1g)) {
                ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
                ibjaSource = `yahoo-q2-${sym}`;
                console.log(`IBJA from yahoo-q2-${sym}: Rs.${ibja24k.toFixed(2)}/g`);
              }
            }
          }
        } catch(e) { console.log(`Yahoo q2 ${sym}:`, e.message); }
      }
    }

    // ── IBJA Source 5: Moneycontrol MCX Gold feed ──
    if (!ibja24k) {
      try {
        const r = await withTimeout(fetch(
          "https://priceapi.moneycontrol.com/pricefeed/commodity/getdata?exchange=MCX&type=C&sc_id=MCX_GOLD",
          { headers: { Accept: "application/json", Referer: "https://www.moneycontrol.com/", "User-Agent": "Mozilla/5.0" } }
        ), 7000);
        if (r.ok) {
          const d = await r.json();
          const raw = parseFloat(d?.data?.pricecurrent ?? d?.data?.price ?? 0);
          console.log("Moneycontrol MCX raw:", raw);
          if (raw > 0) {
            const per1g = toPerGram(raw);
            if (per1g && ibjaCheck(per1g)) {
              ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
              ibjaSource = "moneycontrol-mcx";
              console.log("IBJA from moneycontrol: Rs." + ibja24k.toFixed(2));
            }
          }
        }
      } catch(e) { console.log("moneycontrol error:", e.message); }
    }

    // ── IBJA Source 6: Stooq XAU/INR — troy oz price in INR ÷ TROY ──
    if (!ibja24k) {
      try {
        const r = await withTimeout(fetch(
          "https://stooq.com/q/l/?s=xauinr&f=sd2t2ohlcv&h&e=csv",
          { headers: { "User-Agent": "Mozilla/5.0" } }
        ), 7000);
        if (r.ok) {
          const csv = await r.text();
          const lines = csv.trim().split("\n");
          if (lines.length >= 2) {
            const cols = lines[1].split(",");
            const closeINR = parseFloat(cols[6]);
            console.log("Stooq XAU/INR per troy oz:", closeINR);
            if (closeINR > 1000) {
              const per1g = closeINR / TROY;
              console.log("Stooq per gram:", per1g);
              if (ibjaCheck(per1g)) {
                ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
                ibjaSource = "stooq-xauinr";
                console.log("IBJA from stooq: Rs." + ibja24k.toFixed(2));
              }
            }
          }
        }
      } catch(e) { console.log("stooq error:", e.message); }
    }

    // ── IBJA Source 7: GoodReturns HTML scrape ──
    if (!ibja24k) {
      try {
        const r = await withTimeout(fetch("https://www.goodreturns.in/gold-rates/", {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-IN,en;q=0.9",
          }
        }), 8000);
        if (r.ok) {
          const html = await r.text();
          // Match 5-6 digit numbers (Rs.10000–29999) near 24K/999/per gram
          const patterns = [
            /(?:24\s*[Kk]|999)[^\d]{0,80}(1[0-9],\d{3}|[1-2]\d{4})/,
            /gold_rate_24k['":\s]+(1[0-9],\d{3}|[1-2]\d{4,5})/i,
            /(?:per\s*gram|1\s*gram)[^\d]{0,50}(1[0-9],\d{3}|[1-2]\d{4})/i,
            /"price"\s*:\s*"(1[0-9]\d{3,4})"/,
          ];
          for (const pat of patterns) {
            const m = html.match(pat);
            if (m) {
              const val = parseFloat(m[1].replace(/,/g, ""));
              console.log("GoodReturns match:", m[1], "->", val);
              if (ibjaCheck(val)) {
                ibja24k = val; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
                ibjaSource = "goodreturns.in";
                console.log("IBJA from goodreturns: Rs." + ibja24k.toFixed(2));
                break;
              }
            }
          }
        }
      } catch(e) { console.log("goodreturns error:", e.message); }
    }

    // ── IBJA Source 8: goldpricez.com public page (no key — scrape) ──
    if (!ibja24k) {
      try {
        const r = await withTimeout(fetch("https://goldpricez.com/in/gram", {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "text/html",
          }
        }), 8000);
        if (r.ok) {
          const html = await r.text();
          // Goldpricez embeds price in JSON-LD or data attributes — look for INR 24K per gram
          const patterns = [
            /"price"\s*:\s*"?(1[0-9]\d{3,4})"?/,
            /24[Kk][^\d]{0,40}(1[0-9],\d{3}|[1-2]\d{4})/,
            /INR[^\d]{0,30}(1[0-9],\d{3}|[1-2]\d{4})/,
          ];
          for (const pat of patterns) {
            const m = html.match(pat);
            if (m) {
              const val = parseFloat(m[1].replace(/,/g, ""));
              console.log("goldpricez.com page match:", m[1], "->", val);
              if (ibjaCheck(val)) {
                ibja24k = val; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
                ibjaSource = "goldpricez-page";
                console.log("IBJA from goldpricez page: Rs." + ibja24k.toFixed(2));
                break;
              }
            }
          }
        }
      } catch(e) { console.log("goldpricez page error:", e.message); }
    }

    // ── IBJA Source 9: Calculated fallback ──
    // India landed cost = international spot × (1 + 6% customs) × (1 + 2.5% IGST)
    //                   = calc24k × 1.0865
    // Post July 2024 Union Budget: customs duty reduced from 15% to 6%
    // Badge shown as "CALC" on frontend — honest labelling
    if (!ibja24k) {
      const DUTY = 1.0865;
      ibja24k = calc24k * DUTY;
      ibja22k = ibja24k * 0.916;
      ibja995 = ibja24k * 0.995;
      ibjaSource = "calculated";
      console.log(`IBJA: all live sources failed. calc24k=Rs.${calc24k.toFixed(2)} x ${DUTY} = Rs.${ibja24k.toFixed(2)}/g`);
    }

    console.log(`=== IBJA FINAL: Rs.${ibja24k.toFixed(2)}/g [${ibjaSource}] ===`);

    // ══════════════════════════════════════════════════════════════
    // STEP 5: ETF NAV → Rs./gram
    // Each Indian gold ETF unit ≈ 0.9950g gold
    // NAV (Rs./unit) ÷ 0.9950 = Rs./gram
    // ══════════════════════════════════════════════════════════════
    const ALL_ETF_SYMBOLS = ["GOLDBEES", "SBIGETS", "HDFCMFGETF", "AXISGOLD", "KOTAKGOLD", "ICICIGOLD"];
    const BSE_CODES = { GOLDBEES: "590096", SBIGETS: "590091", HDFCMFGETF: "590094", AXISGOLD: "590102", KOTAKGOLD: "590103", ICICIGOLD: "590100" };

    async function fetchETFQuote(sym) {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      for (const host of ["query1", "query2"]) {
        try {
          const r = await withTimeout(fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=1d`, { headers: { Accept: "application/json", "User-Agent": ua } }), 7000);
          if (r.ok) {
            const d = await r.json();
            const meta = d?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice > 0) return { nav: meta.regularMarketPrice, prevClose: meta.chartPreviousClose || meta.previousClose || null };
          }
        } catch(e) {}
      }
      const bseCode = BSE_CODES[sym];
      if (bseCode) {
        try {
          const r = await withTimeout(fetch(`https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${bseCode}&seriesid=`, { headers: { Accept: "application/json", Referer: "https://www.bseindia.com/", "User-Agent": ua } }), 7000);
          if (r.ok) {
            const d = await r.json();
            const ltp  = parseFloat(d?.CurrRate || d?.Ltp || d?.LastRate || 0);
            const prev = parseFloat(d?.PrevClose || d?.PrevRate || 0);
            if (ltp > 0) return { nav: ltp, prevClose: prev || null };
          }
        } catch(e) {}
      }
      try {
        const r = await withTimeout(fetch(`https://www.nseindia.com/api/quote-equity?symbol=${sym}`, { headers: { Accept: "application/json", "User-Agent": ua, Referer: "https://www.nseindia.com/", Cookie: "nsit=; nseappid=" } }), 7000);
        if (r.ok) {
          const d = await r.json();
          const ltp  = d?.priceInfo?.lastPrice ?? d?.priceInfo?.close;
          const prev = d?.priceInfo?.previousClose;
          if (ltp > 0) return { nav: ltp, prevClose: prev || null };
        }
      } catch(e) {}
      return { nav: null, prevClose: null };
    }

    const etfResults = await Promise.allSettled(ALL_ETF_SYMBOLS.map(sym => withTimeout(fetchETFQuote(sym))));
    const etfNavsRaw = {}, etfPrevCloseRaw = {};
    etfResults.forEach((result, i) => {
      const sym = ALL_ETF_SYMBOLS[i];
      if (result.status === "fulfilled" && result.value?.nav > 0) {
        etfNavsRaw[sym] = result.value.nav;
        if (result.value.prevClose) etfPrevCloseRaw[sym] = result.value.prevClose;
      }
    });

    const etfNavs = {}, etfPrevClose = {};
    ALL_ETF_SYMBOLS.forEach(sym => {
      const u = etfNavsRaw[sym];
      if (u > 0) {
        etfNavs[sym] = u / GRAMS_PER_UNIT;
        if (etfPrevCloseRaw[sym]) etfPrevClose[sym] = etfPrevCloseRaw[sym] / GRAMS_PER_UNIT;
      }
    });
    console.log("ETF navs (Rs./g):", Object.entries(etfNavs).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(", ") || "none");

    // ══════════════════════════════════════════════════════════════
    // STEP 6: Historical sparklines
    // ══════════════════════════════════════════════════════════════
    const RANGE_CONFIG = [
      { key: "1d",  range: "5d",  interval: "5m"  },
      { key: "1w",  range: "5d",  interval: "1h"  },
      { key: "1m",  range: "1mo", interval: "1d"  },
      { key: "3m",  range: "3mo", interval: "1d"  },
      { key: "6m",  range: "6mo", interval: "1wk" },
      { key: "1y",  range: "1y",  interval: "1wk" },
      { key: "3y",  range: "3y",  interval: "1mo" },
      { key: "5y",  range: "5y",  interval: "1mo" },
      { key: "ytd", range: "ytd", interval: "1d"  },
    ];

    async function fetchSparklineRange(sym, range, interval) {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
      const scale = 1 / GRAMS_PER_UNIT;
      for (const host of ["query1", "query2"]) {
        try {
          const r = await withTimeout(fetch(
            `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=${interval}&range=${range}`,
            { headers: { Accept: "application/json", "User-Agent": ua } }
          ), 9000);
          if (!r.ok) continue;
          const d = await r.json();
          const result     = d?.chart?.result?.[0];
          const timestamps = result?.timestamp;
          const closes     = result?.indicators?.quote?.[0]?.close;
          if (!closes || closes.length < 2) continue;
          const points = closes
            .map((c, i) => c != null ? { t: timestamps?.[i] ?? null, v: Math.round((c * scale) * 100) / 100 } : null)
            .filter(Boolean);
          if (points.length >= 2) return points;
        } catch(e) {}
      }
      return null;
    }

    const sparklineJobs = [], sparklineIndex = [];
    for (const sym of ALL_ETF_SYMBOLS) {
      for (const { key, range, interval } of RANGE_CONFIG) {
        sparklineJobs.push(fetchSparklineRange(sym, range, interval));
        sparklineIndex.push({ sym, key });
      }
    }
    const sparklineResults = await Promise.allSettled(sparklineJobs);
    const etfSparklines = {};
    sparklineResults.forEach((result, i) => {
      const { sym, key } = sparklineIndex[i];
      if (result.status === "fulfilled" && result.value?.length >= 2) {
        if (!etfSparklines[sym]) etfSparklines[sym] = {};
        etfSparklines[sym][key] = result.value;
      }
    });

    cache = {
      price:        goldPriceUSD,   // XAU/USD spot
      usdInr,                       // live rate (fallback 95.0)
      aedInr,                       // usdInr / 3.6725
      silverPrice:  silverUSD,      // XAG/USD spot
      ibja24k,      // Rs./gram 999 purity — always a number
      ibja22k,      // Rs./gram 916 purity
      ibja995,      // Rs./gram 995 purity
      etfNavs,      // { SYM: Rs./gram }
      etfPrevClose, // { SYM: Rs./gram prev close }
      etfSparklines,
      timestamp: new Date().toISOString(),
      sources: {
        fx:   (usdInr === 95.0) ? "fallback-95" : "live",
        gold: goldSource,
        ibja: ibjaSource,
        etf:  Object.keys(etfNavs).length > 0 ? "live" : "none",
      }
    };
    cacheTime = Date.now();

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).json(cache);

  } catch (err) {
    console.error("price API error:", err);
    if (cache) return res.status(200).json({ ...cache, cached: true, stale: true });
    res.status(500).json({ error: err.toString() });
  }
}
