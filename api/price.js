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

    // â”€â”€ STEP 1: USD/INR â”€â”€
    let usdInr = null;
    const fxSources = [
      async () => {
        const r = await fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", { headers: { Accept: "application/json" } });
        if (!r.ok) return null;
        const d = await r.json();
        return d?.usd?.inr ?? null;
      },
      async () => {
        const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=INR");
        if (!r.ok) return null;
        const d = await r.json();
        return d?.rates?.INR ?? null;
      },
      async () => {
        const r = await fetch("https://open.er-api.com/v6/latest/USD");
        if (!r.ok) return null;
        const d = await r.json();
        return d?.rates?.INR ?? null;
      },
    ];
    for (const src of fxSources) {
      try { const rate = await src(); if (rate && rate > 75 && rate < 120) { usdInr = rate; break; } } catch(e) {}
    }
    if (!usdInr) { usdInr = 84.5; console.log("USD/INR: fallback"); }

    const usdAed = 3.6725;
    const aedInr = usdInr / usdAed;

    // â”€â”€ STEP 2: Gold spot â”€â”€
    let goldPriceUSD = null, goldSource = "unknown";
    try {
      const r = await fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } });
      if (r.ok) { const d = await r.json(); const xau = d?.items?.[0]?.xauPrice; if (xau > 1000) { goldPriceUSD = xau; goldSource = "goldprice.org"; } }
    } catch(e) {}
    if (!goldPriceUSD) {
      try {
        const r = await fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } });
        if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const xau = item?.gold ?? item?.XAU; if (xau > 1000) { goldPriceUSD = xau; goldSource = "metals.live"; } }
      } catch(e) {}
    }
    if (!goldPriceUSD) {
      try {
        const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { Accept: "application/json" } });
        if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 1000) { goldPriceUSD = p; goldSource = "yahoo-finance"; } }
      } catch(e) {}
    }
    if (!goldPriceUSD && GOLD_API_KEY) {
      try { const r = await fetch("https://www.goldapi.io/api/XAU/USD", { headers: { "x-access-token": GOLD_API_KEY } }); if (r.ok) { const d = await r.json(); if (d?.price > 1000) { goldPriceUSD = d.price; goldSource = "goldapi.io"; } } } catch(e) {}
    }
    if (!goldPriceUSD && METAL_PRICE_API_KEY) {
      try { const r = await fetch(`https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`); if (r.ok) { const d = await r.json(); if (d?.rates?.USD > 0) { goldPriceUSD = d.rates.USD; goldSource = "metalpriceapi.com"; } } } catch(e) {}
    }
    if (!goldPriceUSD) throw new Error("All gold price sources failed");

    // â”€â”€ STEP 3: Silver â”€â”€
    let silverUSD = null;
    try {
      const r = await fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } });
      if (r.ok) { const d = await r.json(); const xag = d?.items?.[0]?.xagPrice; if (xag > 0) silverUSD = xag; }
    } catch(e) {}
    if (!silverUSD) {
      try { const r = await fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } }); if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const xag = item?.silver ?? item?.XAG; if (xag > 0) silverUSD = xag; } } catch(e) {}
    }
    if (!silverUSD) {
      try { const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=1d", { headers: { Accept: "application/json" } }); if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 0) silverUSD = p; } } catch(e) {}
    }
    if (!silverUSD) silverUSD = goldPriceUSD / 85;

    // â”€â”€ STEP 4: IBJA â”€â”€
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSource = "none";
    try {
      const r = await fetch("https://ibjarates.com/api/goldrates", { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)" } });
      if (r.ok) {
        const d = await r.json();
        const g999 = d?.Gold999 ?? d?.gold999 ?? d?.["999"];
        const g916 = d?.Gold916 ?? d?.gold916 ?? d?.["916"];
        const g995 = d?.Gold995 ?? d?.gold995 ?? d?.["995"];
        if (g999 > 1000) { ibja24k = g999/10; ibja22k = g916 ? g916/10 : ibja24k*0.916; ibja995 = g995 ? g995/10 : ibja24k*0.995; ibjaSource = "ibjarates.com"; }
      }
    } catch(e) {}
    if (!ibja24k) {
      try {
        const r = await fetch("https://priceapi.moneycontrol.com/pricefeed/commodity/getdata?exchange=MCX&type=C&sc_id=MCX_GOLD", { headers: { Accept: "application/json", Referer: "https://www.moneycontrol.com/", "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)" } });
        if (r.ok) { const d = await r.json(); const p = d?.data?.pricecurrent ?? d?.data?.price; if (p && p > 10000) { ibja24k = p/10; ibja22k = ibja24k*0.916; ibja995 = ibja24k*0.995; ibjaSource = "moneycontrol-mcx"; } }
      } catch(e) {}
    }

    // â”€â”€ STEP 5: ETFs â€” all 6 fetched server-side in parallel â”€â”€
    const ALL_ETF_SYMBOLS = ["GOLDBEES", "SBIGETS", "HDFCMFGETF", "AXISGOLD", "KOTAKGOLD", "ICICIGOLD"];

    async function fetchETFQuote(sym) {
      // Attempt 1: Yahoo Finance
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=1d`, { headers: { Accept: "application/json" } });
        if (r.ok) {
          const d = await r.json();
          const meta = d?.chart?.result?.[0]?.meta;
          if (meta?.regularMarketPrice > 0) return { nav: meta.regularMarketPrice, prevClose: meta.chartPreviousClose || meta.previousClose || null, live: true };
        }
      } catch(e) {}
      // Attempt 2: NSE India
      try {
        const r = await fetch(`https://www.nseindia.com/api/quote-equity?symbol=${sym}`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Referer: "https://www.nseindia.com/" } });
        if (r.ok) {
          const d = await r.json();
          const ltp  = d?.priceInfo?.lastPrice ?? d?.priceInfo?.close;
          const prev = d?.priceInfo?.previousClose;
          if (ltp > 0) return { nav: ltp, prevClose: prev || null, live: true };
        }
      } catch(e) {}
      return { nav: null, prevClose: null, live: false };
    }

    async function withTimeout(promise, ms = 6000) {
      return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
    }

    const etfResults = await Promise.allSettled(
      ALL_ETF_SYMBOLS.map(sym => withTimeout(fetchETFQuote(sym)))
    );

    const etfNavs = {}, etfPrevClose = {};
    etfResults.forEach((result, i) => {
      const sym = ALL_ETF_SYMBOLS[i];
      if (result.status === "fulfilled" && result.value?.nav > 0) {
        etfNavs[sym] = result.value.nav;
        if (result.value.prevClose) etfPrevClose[sym] = result.value.prevClose;
      }
    });

    // â”€â”€ STEP 6: Historical sparklines (1 year, weekly) â”€â”€
    async function fetchSparkline(sym) {
      try {
        const r = await withTimeout(
          fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1wk&range=1y`, { headers: { Accept: "application/json" } }),
          8000
        );
        if (!r.ok) return null;
        const d = await r.json();
        const result     = d?.chart?.result?.[0];
        const closes     = result?.indicators?.quote?.[0]?.close;
        if (!closes) return null;
        const filtered = closes.map(c => c != null ? Math.round(c * 100) / 100 : null).filter(Boolean);
        return filtered.slice(-52);
      } catch(e) { return null; }
    }

    const sparklineResults = await Promise.allSettled(
      ALL_ETF_SYMBOLS.map(sym => fetchSparkline(sym))
    );
    const etfSparklines = {};
    sparklineResults.forEach((result, i) => {
      const sym = ALL_ETF_SYMBOLS[i];
      if (result.status === "fulfilled" && result.value?.length > 4) {
        etfSparklines[sym] = result.value;
      }
    });

    // Build and cache response
    cache = {
      price:         goldPriceUSD,
      usdInr,
      aedInr,
      silverPrice:   silverUSD,
      ibja24k,
      ibja22k,
      ibja995,
      etfNavs,
      etfPrevClose,
      etfSparklines,
      timestamp:     new Date().toISOString(),
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
