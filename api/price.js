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

    // ── STEP 2: Gold spot ──
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

    // ── STEP 3: Silver ──
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

    // ── STEP 4: IBJA ──
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

    // ── STEP 5: ETF config ──
    const ETF_UNIT_GRAMS = {
      GOLDBEES:   0.9950,
      SBIGETS:    0.9950,
      HDFCMFGETF: 0.9950,
      AXISGOLD:   0.9950,
      KOTAKGOLD:  0.9950,
      ICICIGOLD:  0.9950,
    };

    const ETF_EXPENSE = {
      GOLDBEES:   0.0051,
      SBIGETS:    0.0065,
      HDFCMFGETF: 0.0059,
      AXISGOLD:   0.0060,
      KOTAKGOLD:  0.0055,
      ICICIGOLD:  0.0050,
    };

    const ALL_ETF_SYMBOLS = ["GOLDBEES", "SBIGETS", "HDFCMFGETF", "AXISGOLD", "KOTAKGOLD", "ICICIGOLD"];

    const BSE_CODES = {
      GOLDBEES:   "590096",
      SBIGETS:    "590091",
      HDFCMFGETF: "590094",
      AXISGOLD:   "590102",
      KOTAKGOLD:  "590103",
      ICICIGOLD:  "590100",
    };

    async function withTimeout(promise, ms = 7000) {
      return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
    }

    async function fetchETFQuote(sym) {
      const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=1d`, { headers: { Accept: "application/json", "User-Agent": ua } });
        if (r.ok) { const d = await r.json(); const meta = d?.chart?.result?.[0]?.meta; if (meta?.regularMarketPrice > 0) return { nav: meta.regularMarketPrice, prevClose: meta.chartPreviousClose || meta.previousClose || null, live: true }; }
      } catch(e) {}

      try {
        const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=1d`, { headers: { Accept: "application/json", "User-Agent": ua } });
        if (r.ok) { const d = await r.json(); const meta = d?.chart?.result?.[0]?.meta; if (meta?.regularMarketPrice > 0) return { nav: meta.regularMarketPrice, prevClose: meta.chartPreviousClose || meta.previousClose || null, live: true }; }
      } catch(e) {}

      const bseCode = BSE_CODES[sym];
      if (bseCode) {
        try {
          const r = await fetch(`https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${bseCode}&seriesid=`, { headers: { Accept: "application/json", Referer: "https://www.bseindia.com/", "User-Agent": ua } });
          if (r.ok) { const d = await r.json(); const ltp = parseFloat(d?.CurrRate || d?.Ltp || d?.LastRate || 0); const prev = parseFloat(d?.PrevClose || d?.PrevRate || 0); if (ltp > 0) return { nav: ltp, prevClose: prev || null, live: true }; }
        } catch(e) {}
      }

      try {
        const r = await fetch(`https://www.nseindia.com/api/quote-equity?symbol=${sym}`, { headers: { Accept: "application/json", "User-Agent": ua, Referer: "https://www.nseindia.com/", Cookie: "nsit=; nseappid=" } });
        if (r.ok) { const d = await r.json(); const ltp = d?.priceInfo?.lastPrice ?? d?.priceInfo?.close; const prev = d?.priceInfo?.previousClose; if (ltp > 0) return { nav: ltp, prevClose: prev || null, live: true }; }
      } catch(e) {}

      try {
        const r = await fetch(`https://groww.in/v1/api/stocks_data/v1/tr_live_data/segment/NSECM/exchange_token/${sym}/`, { headers: { Accept: "application/json", "User-Agent": ua, Referer: "https://groww.in/" } });
        if (r.ok) { const d = await r.json(); const ltp = d?.ltp || d?.price; const prev = d?.close || d?.previousClose; if (ltp > 0) return { nav: ltp, prevClose: prev || null, live: true }; }
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

    const etfNavs = {}, etfPrevClose = {};
    ALL_ETF_SYMBOLS.forEach(sym => {
      const unitGrams = ETF_UNIT_GRAMS[sym] || 0.9950;
      if (etfNavsRaw[sym])      etfNavs[sym]      = etfNavsRaw[sym]      / unitGrams;
      if (etfPrevCloseRaw[sym]) etfPrevClose[sym] = etfPrevCloseRaw[sym] / unitGrams;
    });

    // ── STEP 6: Historical sparklines (multi-range) ──
    //
    // Shape returned: etfSparklines[sym][rangeKey] = [{t: unixSeconds, v: ₹/gram}, ...]
    //
    // Range keys: "1d" "1w" "1m" "3m" "6m" "1y" "3y" "5y" "ytd"
    //
    // "1d" uses range=5d interval=5m — filter to today on the frontend via point.t timestamp.
    // "3y" and "5y" use monthly candles (Yahoo does not provide daily for those ranges).

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
      const unitGrams = ETF_UNIT_GRAMS[sym] || 0.9950;
      for (const host of ["query1", "query2"]) {
        try {
          const r = await withTimeout(
            fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=${interval}&range=${range}`,
              { headers: { Accept: "application/json", "User-Agent": ua } }),
            9000
          );
          if (!r.ok) continue;
          const d = await r.json();
          const result     = d?.chart?.result?.[0];
          const timestamps = result?.timestamp;
          const closes     = result?.indicators?.quote?.[0]?.close;
          if (!closes || closes.length < 2) continue;
          const points = closes
            .map((c, i) => c != null ? { t: timestamps?.[i] ?? null, v: Math.round((c / unitGrams) * 100) / 100 } : null)
            .filter(Boolean);
          if (points.length >= 2) return points;
        } catch(e) {}
      }
      return null;
    }

    // Fetch all ranges × all ETFs in parallel
    const sparklineJobs  = [];
    const sparklineIndex = [];
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

    // Build and cache response
    cache = {
      price:        goldPriceUSD,
      usdInr,
      aedInr,
      silverPrice:  silverUSD,
      ibja24k,
      ibja22k,
      ibja995,
      etfNavs,        // ₹ per gram
      etfPrevClose,   // ₹ per gram
      etfSparklines,  // { SYM: { "1d": [{t,v},...], "1w": [...], ..., "5y": [...] } }
      timestamp:    new Date().toISOString(),
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
