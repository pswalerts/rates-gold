// ─────────────────────────────────────────────────────────────────
//  rateof.gold — /api/price
//
//  IBJA rate strategy (simple & reliable):
//  1. indiagoldratesapi.com  — dedicated IBJA rates API (free, no key)
//  2. Yahoo Finance GOLD.MCX — MCX futures ÷ 10 = ₹/gram (most reliable)
//  3. Stooq XAU/INR          — troy oz in INR ÷ 31.1035 = ₹/gram
//  4. Calculated fallback     — spot × 1.0865 (6% customs + 2.5% IGST)
//
//  ibjarates.com REMOVED — their API returns encrypted data (paid only)
// ─────────────────────────────────────────────────────────────────

let cache = null;
let cacheTime = 0;

// ── CACHE: set to 0 to force fresh fetch every request ──────────
// Change back to 60 * 60 * 1000 once prices are confirmed correct
const CACHE_DURATION = 0;

const TROY           = 31.1035;
const GRAMS_PER_UNIT = 0.9950; // each Indian gold ETF unit ≈ 0.995g

export default async function handler(req, res) {
  try {
    if (cache && Date.now() - cacheTime < CACHE_DURATION) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).json({ ...cache, cached: true });
    }

    const GOLD_API_KEY        = process.env.GOLD_API_KEY;
    const METAL_PRICE_API_KEY = process.env.METAL_PRICE_API_KEY;
    const GOLDPRICEZ_KEY      = process.env.GOLDPRICEZ_API_KEY;

    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

    function tout(p, ms = 7000) {
      return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 1: USD / INR
    // Fallback = 95.0 (May 2026 actual rate)
    // ═══════════════════════════════════════════════════════════
    let usdInr = null;

    const fxSources = [
      () => tout(fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"))
              .then(r => r.ok ? r.json() : null).then(d => d?.usd?.inr),
      () => tout(fetch("https://latest.currency-api.pages.dev/v1/currencies/usd.json"))
              .then(r => r.ok ? r.json() : null).then(d => d?.usd?.inr),
      () => tout(fetch("https://api.frankfurter.app/latest?from=USD&to=INR"))
              .then(r => r.ok ? r.json() : null).then(d => d?.rates?.INR),
      () => tout(fetch("https://open.er-api.com/v6/latest/USD"))
              .then(r => r.ok ? r.json() : null).then(d => d?.rates?.INR),
      () => tout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d", { headers: { "User-Agent": UA } }))
              .then(r => r.ok ? r.json() : null).then(d => d?.chart?.result?.[0]?.meta?.regularMarketPrice),
      () => tout(fetch("https://query2.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d", { headers: { "User-Agent": UA } }))
              .then(r => r.ok ? r.json() : null).then(d => d?.chart?.result?.[0]?.meta?.regularMarketPrice),
    ];

    for (const fn of fxSources) {
      try { const v = await fn(); if (v && v > 75 && v < 120) { usdInr = v; break; } } catch (_) {}
    }

    if (!usdInr) { usdInr = 95.0; console.log("USD/INR: fallback 95.0"); }
    else          { console.log(`USD/INR: ${usdInr.toFixed(4)} (live)`); }

    const aedInr = usdInr / 3.6725;

    // ═══════════════════════════════════════════════════════════
    // STEP 2: XAU / USD — international gold spot
    // ═══════════════════════════════════════════════════════════
    let goldUSD = null, goldSrc = "?";

    const goldSources = [
      ["goldprice.org", async () => {
        const r = await tout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } }));
        const d = await r.json(); return d?.items?.[0]?.xauPrice;
      }],
      ["gold-api.com", async () => {
        const r = await tout(fetch("https://gold-api.com/price/XAU"));
        const d = await r.json(); return d?.price;
      }],
      ["metals.live", async () => {
        const r = await tout(fetch("https://metals.live/api/spot"));
        const d = await r.json(); const i = Array.isArray(d) ? d[0] : d; return i?.gold ?? i?.XAU;
      }],
      ["yahoo-gc-q1", async () => {
        const r = await tout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { "User-Agent": UA } }));
        const d = await r.json(); return d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      }],
      ["yahoo-gc-q2", async () => {
        const r = await tout(fetch("https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { "User-Agent": UA } }));
        const d = await r.json(); return d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      }],
      ["goldapi.io", async () => {
        if (!GOLD_API_KEY) return null;
        const r = await tout(fetch("https://www.goldapi.io/api/XAU/USD", { headers: { "x-access-token": GOLD_API_KEY } }));
        const d = await r.json(); return d?.price;
      }],
      ["metalpriceapi", async () => {
        if (!METAL_PRICE_API_KEY) return null;
        const r = await tout(fetch(`https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`));
        const d = await r.json(); return d?.rates?.USD;
      }],
    ];

    for (const [name, fn] of goldSources) {
      try { const v = await fn(); if (v && v > 1000) { goldUSD = v; goldSrc = name; break; } } catch (_) {}
    }

    if (!goldUSD) throw new Error("All XAU/USD sources failed");

    const calc24k = (goldUSD / TROY) * usdInr;
    console.log(`XAU/USD $${goldUSD.toFixed(2)} [${goldSrc}] | USD/INR ${usdInr.toFixed(2)} | calc24k ₹${calc24k.toFixed(2)}/g`);

    // ═══════════════════════════════════════════════════════════
    // STEP 3: XAG / USD — silver spot
    // ═══════════════════════════════════════════════════════════
    let silverUSD = null;
    try { const r = await tout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } })); if (r.ok) { const d = await r.json(); const v = d?.items?.[0]?.xagPrice; if (v > 0) silverUSD = v; } } catch (_) {}
    try { if (!silverUSD) { const r = await tout(fetch("https://gold-api.com/price/XAG")); if (r.ok) { const d = await r.json(); if (d?.price > 0) silverUSD = d.price; } } } catch (_) {}
    try { if (!silverUSD) { const r = await tout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=1d", { headers: { "User-Agent": UA } })); if (r.ok) { const d = await r.json(); const v = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (v > 0) silverUSD = v; } } } catch (_) {}
    if (!silverUSD) silverUSD = goldUSD / 85;

    // ═══════════════════════════════════════════════════════════
    // STEP 4: IBJA India gold rate (₹/gram, 999 purity)
    //
    //  ibjaCheck: ₹5,000–₹30,000/gram absolute range
    //  Covers gold at any realistic price level
    //
    //  toPerGram: MCX publishes per 10g → divide by 10
    //
    //  Sources (ibjarates.com REMOVED — encrypted API, paid only):
    //  S1: indiagoldratesapi.com  — dedicated free IBJA API
    //  S2: Yahoo MCX GOLD.MCX     — MCX futures ÷ 10
    //  S3: Stooq XAU/INR          — troy oz in INR ÷ TROY
    //  S4: Calculated fallback    — spot × 1.0865
    // ═══════════════════════════════════════════════════════════
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSrc = "?";

    const ibjaOk = v => { const n = parseFloat(v); return n > 5000 && n < 30000; };

    const toPerGram = v => {
      const n = parseFloat(v);
      if (!n || n <= 0) return null;
      if (n > 50000) return n / 100; // per 100g
      if (n > 10000) return n / 10;  // per 10g  ← MCX standard
      return n;                       // per gram
    };

    const setIBJA = (v, src, raw22, raw995) => {
      ibja24k = v;
      ibja22k = raw22  ? (toPerGram(raw22)  ?? v * 0.916) : v * 0.916;
      ibja995 = raw995 ? (toPerGram(raw995) ?? v * 0.995) : v * 0.995;
      ibjaSrc = src;
      console.log(`IBJA ₹${v.toFixed(2)}/g [${src}]`);
    };

    // ── S1: indiagoldratesapi.com ─────────────────────────────
    // Dedicated India gold rates API — built specifically for IBJA data
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://indiagoldratesapi.com/api/rates", {
          headers: { Accept: "application/json", "User-Agent": "rateof.gold/1.0" }
        }), 6000);
        if (r.ok) {
          const d = await r.json();
          console.log("indiagoldratesapi RAW:", JSON.stringify(d).slice(0, 400));
          // Try all plausible key names
          const raw =
            d?.gold24k ?? d?.gold_24k ?? d?.Gold24K ?? d?.Gold24k ??
            d?.["24k"]  ?? d?.["24K"]  ?? d?.rate24k  ?? d?.Rate24K ??
            d?.data?.gold24k ?? d?.data?.["24k"] ?? d?.data?.Gold24K ??
            d?.rates?.gold24k ?? d?.rates?.["24k"] ??
            d?.gold?.["999"] ?? d?.gold?.["24K"] ??
            // some APIs return array of purities
            (Array.isArray(d) ? d.find(x => x?.purity === "999" || x?.karat === "24" || x?.type === "24K")?.rate : null) ??
            (Array.isArray(d?.data) ? d.data.find(x => x?.purity === "999" || x?.karat === "24")?.rate : null);
          const raw22 =
            d?.gold22k ?? d?.gold_22k ?? d?.Gold22K ?? d?.["22k"] ?? d?.["22K"] ??
            d?.data?.gold22k ?? d?.data?.["22k"] ??
            (Array.isArray(d) ? d.find(x => x?.purity === "916" || x?.karat === "22")?.rate : null);
          if (raw) {
            const v = toPerGram(raw);
            console.log("indiagoldratesapi raw:", raw, "-> per gram:", v);
            if (v && ibjaOk(v)) setIBJA(v, "indiagoldratesapi.com", raw22, null);
          }
        } else {
          console.log("indiagoldratesapi HTTP", r.status);
        }
      } catch (e) { console.log("indiagoldratesapi error:", e.message); }
    }

    // ── S2: Yahoo Finance MCX Gold (query1 + query2) ──────────
    // GOLD.MCX = standard contract, price in ₹ per 10 grams
    // divide by 10 to get ₹ per gram
    if (!ibja24k) {
      for (const host of ["query1", "query2"]) {
        if (ibja24k) break;
        for (const sym of ["GOLD.MCX", "GOLDM.MCX"]) {
          if (ibja24k) break;
          try {
            const r = await tout(fetch(
              `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
              { headers: { "User-Agent": UA } }
            ), 7000);
            if (r.ok) {
              const d = await r.json();
              const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
              console.log(`Yahoo ${host} ${sym}: raw=${price}`);
              const v = toPerGram(price);
              console.log(`Yahoo ${host} ${sym}: per gram=${v}`);
              if (v && ibjaOk(v)) setIBJA(v, `yahoo-${host}-${sym}`);
            } else {
              console.log(`Yahoo ${host} ${sym} HTTP`, r.status);
            }
          } catch (e) { console.log(`Yahoo ${host} ${sym}:`, e.message); }
        }
      }
    }

    // ── S3: Stooq XAU/INR ────────────────────────────────────
    // Returns price of 1 troy oz in INR
    // Divide by TROY (31.1035) to get ₹ per gram
    // Note: this is international spot in INR, not IBJA (no customs duty)
    // Still better than pure calculation as it uses live FX
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://stooq.com/q/l/?s=xauinr&f=sd2t2ohlcv&h&e=csv", { headers: { "User-Agent": UA } }), 7000);
        if (r.ok) {
          const csv = await r.text();
          const cols = csv.trim().split("\n")[1]?.split(",") ?? [];
          const closeINR = parseFloat(cols[6]);
          console.log("Stooq XAU/INR per troy oz:", closeINR);
          if (closeINR > 1000) {
            const v = closeINR / TROY;
            console.log("Stooq per gram:", v);
            if (ibjaOk(v)) setIBJA(v, "stooq-xauinr");
          }
        }
      } catch (e) { console.log("Stooq error:", e.message); }
    }

    // ── S4: Calculated fallback ───────────────────────────────
    // India gold price = international spot + customs duty + IGST
    // Post July 2024 Union Budget: 6% customs + 2.5% IGST = ×1.0865
    // This is shown as "CALC" badge on frontend so users know it's estimated
    if (!ibja24k) {
      const v = calc24k * 1.0865;
      setIBJA(v, "calculated");
      console.log(`IBJA fallback: ₹${calc24k.toFixed(2)} × 1.0865 = ₹${v.toFixed(2)}/g`);
    }

    console.log(`=== IBJA FINAL: ₹${ibja24k.toFixed(2)}/g [${ibjaSrc}] ===`);

    // ═══════════════════════════════════════════════════════════
    // STEP 5: ETF NAV → ₹ per gram
    // Unit price (₹/unit) ÷ 0.9950 = ₹/gram
    // ═══════════════════════════════════════════════════════════
    const ETF_SYMS = ["GOLDBEES", "SBIGETS", "HDFCMFGETF", "AXISGOLD", "KOTAKGOLD", "ICICIGOLD"];
    const BSE_CODES = {
      GOLDBEES: "590096", SBIGETS: "590091", HDFCMFGETF: "590094",
      AXISGOLD: "590102", KOTAKGOLD: "590103", ICICIGOLD: "590100",
    };

    async function fetchETF(sym) {
      // Yahoo Finance NSE (primary)
      for (const host of ["query1", "query2"]) {
        try {
          const r = await tout(fetch(
            `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=1d`,
            { headers: { "User-Agent": UA } }
          ));
          if (r.ok) {
            const d = await r.json(), m = d?.chart?.result?.[0]?.meta;
            if (m?.regularMarketPrice > 0)
              return { nav: m.regularMarketPrice, prevClose: m.chartPreviousClose || m.previousClose || null };
          }
        } catch (_) {}
      }
      // BSE fallback
      try {
        const r = await tout(fetch(
          `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${BSE_CODES[sym]}&seriesid=`,
          { headers: { Referer: "https://www.bseindia.com/", "User-Agent": UA } }
        ));
        if (r.ok) {
          const d = await r.json();
          const ltp  = parseFloat(d?.CurrRate || d?.Ltp || d?.LastRate || 0);
          const prev = parseFloat(d?.PrevClose || d?.PrevRate || 0);
          if (ltp > 0) return { nav: ltp, prevClose: prev || null };
        }
      } catch (_) {}
      return { nav: null, prevClose: null };
    }

    const etfResults = await Promise.allSettled(ETF_SYMS.map(s => tout(fetchETF(s))));
    const etfRaw = {}, etfPrevRaw = {};
    etfResults.forEach((res, i) => {
      if (res.status === "fulfilled" && res.value?.nav > 0) {
        etfRaw[ETF_SYMS[i]] = res.value.nav;
        if (res.value.prevClose) etfPrevRaw[ETF_SYMS[i]] = res.value.prevClose;
      }
    });

    const etfNavs = {}, etfPrevClose = {};
    ETF_SYMS.forEach(s => {
      if (etfRaw[s] > 0) {
        etfNavs[s]    = etfRaw[s]     / GRAMS_PER_UNIT;
        if (etfPrevRaw[s]) etfPrevClose[s] = etfPrevRaw[s] / GRAMS_PER_UNIT;
      }
    });
    console.log("ETF ₹/g:", Object.entries(etfNavs).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(", ") || "none");

    // ═══════════════════════════════════════════════════════════
    // STEP 6: Sparklines (ETF price history → ₹/gram)
    // ═══════════════════════════════════════════════════════════
    const RANGES = [
      { key: "1d",  range: "5d",  iv: "5m"  },
      { key: "1w",  range: "5d",  iv: "1h"  },
      { key: "1m",  range: "1mo", iv: "1d"  },
      { key: "3m",  range: "3mo", iv: "1d"  },
      { key: "6m",  range: "6mo", iv: "1wk" },
      { key: "1y",  range: "1y",  iv: "1wk" },
      { key: "3y",  range: "3y",  iv: "1mo" },
      { key: "5y",  range: "5y",  iv: "1mo" },
      { key: "ytd", range: "ytd", iv: "1d"  },
    ];

    async function fetchSpark(sym, range, iv) {
      const scale = 1 / GRAMS_PER_UNIT;
      for (const host of ["query1", "query2"]) {
        try {
          const r = await tout(fetch(
            `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=${iv}&range=${range}`,
            { headers: { "User-Agent": UA } }
          ), 9000);
          if (!r.ok) continue;
          const d = await r.json(), res = d?.chart?.result?.[0];
          const ts = res?.timestamp, cls = res?.indicators?.quote?.[0]?.close;
          if (!cls || cls.length < 2) continue;
          const pts = cls
            .map((c, i) => c != null ? { t: ts?.[i] ?? null, v: Math.round(c * scale * 100) / 100 } : null)
            .filter(Boolean);
          if (pts.length >= 2) return pts;
        } catch (_) {}
      }
      return null;
    }

    const spJobs = [], spIdx = [];
    for (const s of ETF_SYMS) {
      for (const { key, range, iv } of RANGES) {
        spJobs.push(fetchSpark(s, range, iv));
        spIdx.push({ s, key });
      }
    }
    const spResults = await Promise.allSettled(spJobs);
    const etfSparklines = {};
    spResults.forEach((r, i) => {
      const { s, key } = spIdx[i];
      if (r.status === "fulfilled" && r.value?.length >= 2) {
        if (!etfSparklines[s]) etfSparklines[s] = {};
        etfSparklines[s][key] = r.value;
      }
    });

    // ═══════════════════════════════════════════════════════════
    // Build response
    // ═══════════════════════════════════════════════════════════
    cache = {
      price:        goldUSD,      // XAU/USD spot
      usdInr,                     // live rate (fallback 95.0)
      aedInr,                     // usdInr / 3.6725
      silverPrice:  silverUSD,    // XAG/USD spot
      ibja24k,                    // ₹/gram 999 purity — always a number
      ibja22k,                    // ₹/gram 916 purity
      ibja995,                    // ₹/gram 995 purity
      etfNavs,                    // { SYM: ₹/gram }
      etfPrevClose,               // { SYM: ₹/gram prev close }
      etfSparklines,
      timestamp: new Date().toISOString(),
      sources: {
        fx:   usdInr === 95.0 ? "fallback-95" : "live",
        gold: goldSrc,
        ibja: ibjaSrc,
        etf:  Object.keys(etfNavs).length > 0 ? "live" : "none",
      },
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
