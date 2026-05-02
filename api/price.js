let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 60 minutes

export default async function handler(req, res) {
  try {
    if (cache && Date.now() - cacheTime < CACHE_DURATION) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).json({ ...cache, cached: true });
    }

    const GOLD_API_KEY        = process.env.GOLD_API_KEY;
    const METAL_PRICE_API_KEY = process.env.METAL_PRICE_API_KEY;

    // ── STEP 1: USD/INR ──
    let usdInr = null;
    const fxSources = [
      async () => { const r = await fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", { headers: { Accept: "application/json" } }); if (!r.ok) return null; const d = await r.json(); return d?.usd?.inr ?? null; },
      async () => { const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=INR"); if (!r.ok) return null; const d = await r.json(); return d?.rates?.INR ?? null; },
      async () => { const r = await fetch("https://open.er-api.com/v6/latest/USD"); if (!r.ok) return null; const d = await r.json(); return d?.rates?.INR ?? null; },
    ];
    for (const src of fxSources) {
      try { const rate = await src(); if (rate && rate > 75 && rate < 120) { usdInr = rate; break; } } catch(e) {}
    }
    if (!usdInr) { usdInr = 84.5; console.log("USD/INR: fallback"); }
    const aedInr = usdInr / 3.6725;

    // ── STEP 2: Gold spot XAU/USD ──
    let goldPriceUSD = null, goldSource = "unknown";
    try { const r = await fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } }); if (r.ok) { const d = await r.json(); const xau = d?.items?.[0]?.xauPrice; if (xau > 1000) { goldPriceUSD = xau; goldSource = "goldprice.org"; } } } catch(e) {}
    if (!goldPriceUSD) { try { const r = await fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } }); if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const xau = item?.gold ?? item?.XAU; if (xau > 1000) { goldPriceUSD = xau; goldSource = "metals.live"; } } } catch(e) {} }
    if (!goldPriceUSD) { try { const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { Accept: "application/json" } }); if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 1000) { goldPriceUSD = p; goldSource = "yahoo-finance"; } } } catch(e) {} }
    if (!goldPriceUSD && GOLD_API_KEY) { try { const r = await fetch("https://www.goldapi.io/api/XAU/USD", { headers: { "x-access-token": GOLD_API_KEY } }); if (r.ok) { const d = await r.json(); if (d?.price > 1000) { goldPriceUSD = d.price; goldSource = "goldapi.io"; } } } catch(e) {} }
    if (!goldPriceUSD && METAL_PRICE_API_KEY) { try { const r = await fetch(`https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`); if (r.ok) { const d = await r.json(); if (d?.rates?.USD > 0) { goldPriceUSD = d.rates.USD; goldSource = "metalpriceapi.com"; } } } catch(e) {} }
    if (!goldPriceUSD) throw new Error("All gold price sources failed");

    const TROY = 31.1035;
    const calc24k = (goldPriceUSD / TROY) * usdInr;

    // ── STEP 3: Silver XAG/USD ──
    let silverUSD = null;
    try { const r = await fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } }); if (r.ok) { const d = await r.json(); const xag = d?.items?.[0]?.xagPrice; if (xag > 0) silverUSD = xag; } } catch(e) {}
    if (!silverUSD) { try { const r = await fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } }); if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const xag = item?.silver ?? item?.XAG; if (xag > 0) silverUSD = xag; } } catch(e) {} }
    if (!silverUSD) { try { const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=1d", { headers: { Accept: "application/json" } }); if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 0) silverUSD = p; } } catch(e) {} }
    if (!silverUSD) silverUSD = goldPriceUSD / 85;

    // ── STEP 4: IBJA India gold rate ──
    // IBJA 999 purity rate — we want ₹ per gram (999 purity, 24K).
    // Sanity: must be within ±15% of international spot converted to INR.
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSource = "none";

    const ibjaCheck = (val) => val > 0 && val > calc24k * 0.85 && val < calc24k * 1.20;

    // Source 1: ibjarates.com official API
    if (!ibja24k) {
      try {
        const r = await fetch("https://ibjarates.com/api/goldrates", {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)" }
        });
        if (r.ok) {
          const d = await r.json();
          console.log("ibjarates.com response:", JSON.stringify(d).slice(0, 300));
          const g999 = d?.Gold999 ?? d?.gold999 ?? d?.["999"] ?? d?.rate999 ?? d?.Rate999 ?? d?.price999;
          const g916 = d?.Gold916 ?? d?.gold916 ?? d?.["916"] ?? d?.rate916 ?? d?.Rate916;
          const g995 = d?.Gold995 ?? d?.gold995 ?? d?.["995"] ?? d?.rate995 ?? d?.Rate995;
          if (g999 > 0) {
            // IBJA publishes per 10g — divide if value looks like per-10g
            const per1g = g999 > 10000 ? g999 / 10 : g999;
            if (ibjaCheck(per1g)) {
              ibja24k = per1g;
              ibja22k = g916 ? (g916 > 10000 ? g916 / 10 : g916) : ibja24k * 0.916;
              ibja995 = g995 ? (g995 > 10000 ? g995 / 10 : g995) : ibja24k * 0.995;
              ibjaSource = "ibjarates.com";
            }
          }
        }
      } catch(e) { console.log("ibjarates.com error:", e.message); }
    }

    // Source 2: Yahoo Finance MCX Gold continuous contract (GOLDM.MCX)
    // Price is per 10g in INR on MCX — divide by 10 to get per gram
    if (!ibja24k) {
      const mcxSymbols = ["GOLDM.MCX", "GOLD.MCX"];
      for (const sym of mcxSymbols) {
        if (ibja24k) break;
        try {
          const r = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
            { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)" } }
          );
          if (r.ok) {
            const d = await r.json();
            const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
            if (p > 0) {
              // MCX gold futures price is per 10g in INR
              const per1g = p / 10;
              if (ibjaCheck(per1g)) {
                ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
                ibjaSource = `yahoo-mcx-${sym}`;
                console.log(`IBJA from ${sym}:`, ibja24k.toFixed(2));
              }
            }
          }
        } catch(e) { console.log(`Yahoo MCX ${sym} error:`, e.message); }
      }
    }

    // Source 3: Moneycontrol MCX Gold (per 10g INR)
    if (!ibja24k) {
      try {
        const r = await fetch(
          "https://priceapi.moneycontrol.com/pricefeed/commodity/getdata?exchange=MCX&type=C&sc_id=MCX_GOLD",
          { headers: { Accept: "application/json", Referer: "https://www.moneycontrol.com/", "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)" } }
        );
        if (r.ok) {
          const d = await r.json();
          const p = parseFloat(d?.data?.pricecurrent ?? d?.data?.price ?? 0);
          if (p > 0) {
            const per1g = p / 10;
            if (ibjaCheck(per1g)) { ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995; ibjaSource = "moneycontrol-mcx"; }
          }
        }
      } catch(e) { console.log("MCX moneycontrol error:", e.message); }
    }

    // Source 4: GoodReturns gold rate today
    if (!ibja24k) {
      try {
        const r = await fetch("https://www.goodreturns.in/gold-rates/", {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Accept: "text/html" }
        });
        if (r.ok) {
          const html = await r.text();
          // Look for 24K per gram figure in the page (goodreturns typically shows ₹XXXX per gram)
          const patterns = [
            /24\s*[Kk](?:arat)?\s*(?:gold)?\s*(?:rate|price)?[^₹\d]*₹?\s*([\d,]+)/i,
            /"price"\s*:\s*"?([\d.]+)"?/,
            /per\s*gram[^₹\d]*₹\s*([\d,]+)/i,
          ];
          for (const pat of patterns) {
            const m = html.match(pat);
            if (m) {
              const val = parseFloat(m[1].replace(/,/g, ""));
              if (val > 1000 && ibjaCheck(val)) {
                ibja24k = val; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
                ibjaSource = "goodreturns.in";
                break;
              }
            }
          }
        }
      } catch(e) { console.log("goodreturns error:", e.message); }
    }

    // Source 5: Rupeezy MCX commodity API
    if (!ibja24k) {
      try {
        const r = await fetch(
          "https://api.rupeezy.in/stock/quotev2?symbol=GOLD25JULFUT&exchange=MCX",
          { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }
        );
        if (r.ok) {
          const d = await r.json();
          const p = parseFloat(d?.data?.ltp ?? d?.data?.close ?? d?.ltp ?? 0);
          if (p > 0) {
            const per1g = p / 10;
            if (ibjaCheck(per1g)) { ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995; ibjaSource = "rupeezy-mcx"; }
          }
        }
      } catch(e) {}
    }

    // Source 6: Investing.com India gold
    if (!ibja24k) {
      try {
        const r = await fetch(
          "https://api.investing.com/api/financials/historical/1175953?period=P1W",
          { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest", Referer: "https://in.investing.com/" } }
        );
        if (r.ok) {
          const d = await r.json();
          const p = d?.data?.[0]?.last_close ?? d?.data?.[0]?.close;
          if (p > 0 && ibjaCheck(p)) { ibja24k = p; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995; ibjaSource = "investing.com"; }
        }
      } catch(e) {}
    }

    // NO fake fallback — if all IBJA sources fail, return null.
    // The frontend handles this gracefully: shows "PENDING" and falls back to
    // international spot (calc24k) for retailer/ETF/Dubai analysis.
    if (!ibja24k) {
      console.log("IBJA: all sources failed — returning null (frontend will use calc24k)");
      ibjaSource = "unavailable";
    } else {
      console.log("IBJA source:", ibjaSource, "24K per gram:", ibja24k.toFixed(2));
    }

    // ── STEP 5: ETF NAV → ₹ per gram ──
    // Each Indian gold ETF unit holds approximately 0.9950g of 999.9 gold.
    // The unit trades on NSE/BSE at ~₹70–80/unit (as of 2025).
    // ₹/gram = unitPrice / gramsPerUnit
    const GRAMS_PER_UNIT = 0.9950;
    const ALL_ETF_SYMBOLS = ["GOLDBEES", "SBIGETS", "HDFCMFGETF", "AXISGOLD", "KOTAKGOLD", "ICICIGOLD"];
    const BSE_CODES = { GOLDBEES: "590096", SBIGETS: "590091", HDFCMFGETF: "590094", AXISGOLD: "590102", KOTAKGOLD: "590103", ICICIGOLD: "590100" };

    async function withTimeout(promise, ms = 7000) {
      return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
    }

    async function fetchETFQuote(sym) {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      // Yahoo Finance NSE (primary)
      for (const host of ["query1", "query2"]) {
        try {
          const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=1d`, { headers: { Accept: "application/json", "User-Agent": ua } });
          if (r.ok) {
            const d = await r.json();
            const meta = d?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice > 0) return { nav: meta.regularMarketPrice, prevClose: meta.chartPreviousClose || meta.previousClose || null, live: true };
          }
        } catch(e) {}
      }
      // BSE fallback
      const bseCode = BSE_CODES[sym];
      if (bseCode) {
        try {
          const r = await fetch(`https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${bseCode}&seriesid=`, { headers: { Accept: "application/json", Referer: "https://www.bseindia.com/", "User-Agent": ua } });
          if (r.ok) {
            const d = await r.json();
            const ltp  = parseFloat(d?.CurrRate || d?.Ltp || d?.LastRate || 0);
            const prev = parseFloat(d?.PrevClose || d?.PrevRate || 0);
            if (ltp > 0) return { nav: ltp, prevClose: prev || null, live: true };
          }
        } catch(e) {}
      }
      // NSE fallback
      try {
        const r = await fetch(`https://www.nseindia.com/api/quote-equity?symbol=${sym}`, { headers: { Accept: "application/json", "User-Agent": ua, Referer: "https://www.nseindia.com/", Cookie: "nsit=; nseappid=" } });
        if (r.ok) {
          const d = await r.json();
          const ltp  = d?.priceInfo?.lastPrice ?? d?.priceInfo?.close;
          const prev = d?.priceInfo?.previousClose;
          if (ltp > 0) return { nav: ltp, prevClose: prev || null, live: true };
        }
      } catch(e) {}
      // Groww fallback
      try {
        const r = await fetch(`https://groww.in/v1/api/stocks_data/v1/tr_live_data/segment/NSECM/exchange_token/${sym}/`, { headers: { Accept: "application/json", "User-Agent": ua, Referer: "https://groww.in/" } });
        if (r.ok) {
          const d = await r.json();
          const ltp  = d?.ltp || d?.price;
          const prev = d?.close || d?.previousClose;
          if (ltp > 0) return { nav: ltp, prevClose: prev || null, live: true };
        }
      } catch(e) {}
      return { nav: null, prevClose: null, live: false };
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

    // Convert unit prices (₹/unit) → ₹/gram by dividing by grams per unit
    const etfNavs = {}, etfPrevClose = {};
    ALL_ETF_SYMBOLS.forEach(sym => {
      const liveUnit = etfNavsRaw[sym]; // e.g. GOLDBEES ≈ ₹75 per unit
      if (liveUnit > 0) {
        etfNavs[sym]     = liveUnit / GRAMS_PER_UNIT;           // ₹ per gram
        if (etfPrevCloseRaw[sym]) {
          etfPrevClose[sym] = etfPrevCloseRaw[sym] / GRAMS_PER_UNIT; // prev close ₹/gram
        }
      }
    });

    console.log("ETF navs (₹/gram):", Object.entries(etfNavs).map(([k,v]) => `${k}:${v.toFixed(0)}`).join(", "));

    // ── STEP 6: Historical sparklines (multi-range) ──
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
      // Scale factor: convert unit price → ₹/gram using same GRAMS_PER_UNIT
      const scale = 1 / GRAMS_PER_UNIT;
      for (const host of ["query1", "query2"]) {
        try {
          const r = await withTimeout(fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=${interval}&range=${range}`, { headers: { Accept: "application/json", "User-Agent": ua } }), 9000);
          if (!r.ok) continue;
          const d = await r.json();
          const result = d?.chart?.result?.[0];
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
      price:      goldPriceUSD,
      usdInr,
      aedInr,
      silverPrice: silverUSD,
      ibja24k,   // ₹/gram, 999 purity — null if unavailable
      ibja22k,   // ₹/gram, 916 purity — null if unavailable
      ibja995,   // ₹/gram, 995 purity — null if unavailable
      etfNavs,       // keyed by symbol, value = ₹/gram
      etfPrevClose,  // keyed by symbol, value = prev close ₹/gram
      etfSparklines, // keyed by symbol → rangeKey → [{t,v}]
      timestamp: new Date().toISOString(),
      sources: {
        fx:   usdInr === 84.5 ? "fallback" : "live",
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
