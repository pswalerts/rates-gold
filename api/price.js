let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 60 minutes
const TROY = 31.1035;
const GRAMS_PER_UNIT = 0.9950;

export default async function handler(req, res) {
  try {
    if (cache && Date.now() - cacheTime < CACHE_DURATION) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).json({ ...cache, cached: true });
    }

    const GOLD_API_KEY        = process.env.GOLD_API_KEY;
    const METAL_PRICE_API_KEY = process.env.METAL_PRICE_API_KEY;

    async function withTimeout(promise, ms = 8000) {
      return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
      ]);
    }

    // ── STEP 1: USD/INR ──
    let usdInr = null;
    const fxSources = [
      async () => { const r = await withTimeout(fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", { headers: { Accept: "application/json" } })); if (!r.ok) return null; const d = await r.json(); return d?.usd?.inr ?? null; },
      async () => { const r = await withTimeout(fetch("https://api.frankfurter.app/latest?from=USD&to=INR")); if (!r.ok) return null; const d = await r.json(); return d?.rates?.INR ?? null; },
      async () => { const r = await withTimeout(fetch("https://open.er-api.com/v6/latest/USD")); if (!r.ok) return null; const d = await r.json(); return d?.rates?.INR ?? null; },
    ];
    for (const src of fxSources) {
      try { const rate = await src(); if (rate && rate > 75 && rate < 120) { usdInr = rate; break; } } catch(e) {}
    }
    if (!usdInr) { usdInr = 84.5; console.log("USD/INR: using fallback 84.5"); }
    const aedInr = usdInr / 3.6725;

    // ── STEP 2: Gold spot XAU/USD ──
    let goldPriceUSD = null, goldSource = "unknown";
    try { const r = await withTimeout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } })); if (r.ok) { const d = await r.json(); const xau = d?.items?.[0]?.xauPrice; if (xau > 1000) { goldPriceUSD = xau; goldSource = "goldprice.org"; } } } catch(e) {}
    if (!goldPriceUSD) { try { const r = await withTimeout(fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } })); if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const xau = item?.gold ?? item?.XAU; if (xau > 1000) { goldPriceUSD = xau; goldSource = "metals.live"; } } } catch(e) {} }
    if (!goldPriceUSD) { try { const r = await withTimeout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { Accept: "application/json" } })); if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 1000) { goldPriceUSD = p; goldSource = "yahoo-gc"; } } } catch(e) {} }
    if (!goldPriceUSD && GOLD_API_KEY) { try { const r = await withTimeout(fetch("https://www.goldapi.io/api/XAU/USD", { headers: { "x-access-token": GOLD_API_KEY } })); if (r.ok) { const d = await r.json(); if (d?.price > 1000) { goldPriceUSD = d.price; goldSource = "goldapi.io"; } } } catch(e) {} }
    if (!goldPriceUSD && METAL_PRICE_API_KEY) { try { const r = await withTimeout(fetch(`https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`)); if (r.ok) { const d = await r.json(); if (d?.rates?.USD > 0) { goldPriceUSD = d.rates.USD; goldSource = "metalpriceapi.com"; } } } catch(e) {} }
    if (!goldPriceUSD) throw new Error("All gold price sources failed");

    const calc24k = (goldPriceUSD / TROY) * usdInr;
    console.log(`Gold: $${goldPriceUSD.toFixed(2)} from ${goldSource}, calc24k: Rs.${calc24k.toFixed(2)}/g`);

    // ── STEP 3: Silver XAG/USD ──
    let silverUSD = null;
    try { const r = await withTimeout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } })); if (r.ok) { const d = await r.json(); const xag = d?.items?.[0]?.xagPrice; if (xag > 0) silverUSD = xag; } } catch(e) {}
    if (!silverUSD) { try { const r = await withTimeout(fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } })); if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const xag = item?.silver ?? item?.XAG; if (xag > 0) silverUSD = xag; } } catch(e) {} }
    if (!silverUSD) { try { const r = await withTimeout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=1d", { headers: { Accept: "application/json" } })); if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 0) silverUSD = p; } } catch(e) {} }
    if (!silverUSD) silverUSD = goldPriceUSD / 85;

    // ══════════════════════════════════════════════════════════════
    // STEP 4: IBJA India gold rate — 7-source chain
    //
    // IBJA rate = Rs. per gram, 999 purity, 24K
    // Published daily ~10:00 AM IST by India Bullion & Jewellers Association
    // Tracks MCX Gold (per 10g INR) closely
    //
    // Sanity check: must be within +/-15% of calc24k (intl spot in INR)
    // In practice IBJA is typically 5-10% above calc24k (customs duty + local premium)
    // ══════════════════════════════════════════════════════════════
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSource = "none";

    const ibjaCheck = (val) => val > 0 && val > calc24k * 0.85 && val < calc24k * 1.20;

    // Helper: MCX gold price is per 10g INR. Values above 10000 are per-10g, divide by 10.
    const per10gTo1g = (v) => {
      const n = parseFloat(v);
      if (!n || n <= 0) return null;
      return n > 10000 ? n / 10 : n;
    };

    // ── Source 1: ibjarates.com ──
    // Logs full raw response to Vercel logs so you can see the exact JSON keys
    if (!ibja24k) {
      try {
        const r = await withTimeout(fetch("https://ibjarates.com/api/goldrates", {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)",
          }
        }), 6000);
        if (r.ok) {
          const d = await r.json();
          console.log("ibjarates.com RAW:", JSON.stringify(d).slice(0, 500));
          // Try every plausible key shape (flat object, nested under data, array of rate objects)
          const raw999 =
            d?.Gold999 ?? d?.gold999 ?? d?.GOLD999 ??
            d?.["999"] ?? d?.rate999 ?? d?.Rate999 ??
            d?.price999 ?? d?.Price999 ??
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
            const per1g = per10gTo1g(raw999);
            if (per1g && ibjaCheck(per1g)) {
              ibja24k = per1g;
              ibja22k = raw916 ? per10gTo1g(raw916) ?? ibja24k * 0.916 : ibja24k * 0.916;
              ibja995 = raw995 ? per10gTo1g(raw995) ?? ibja24k * 0.995 : ibja24k * 0.995;
              ibjaSource = "ibjarates.com";
              console.log("IBJA from ibjarates.com: Rs." + ibja24k.toFixed(2));
            }
          }
        } else {
          console.log("ibjarates.com HTTP", r.status);
        }
      } catch(e) { console.log("ibjarates.com error:", e.message); }
    }

    // ── Source 2: Yahoo Finance MCX Gold — query1 ──
    // MCX gold price is Rs. per 10g. Divide by 10 to get Rs./gram.
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
            console.log(`Yahoo q1 MCX ${sym}:`, price);
            if (price > 0) {
              const per1g = per10gTo1g(price);
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

    // ── Source 3: Yahoo Finance MCX Gold — query2 ──
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
            console.log(`Yahoo q2 MCX ${sym}:`, price);
            if (price > 0) {
              const per1g = per10gTo1g(price);
              if (per1g && ibjaCheck(per1g)) {
                ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
                ibjaSource = `yahoo-q2-${sym}`;
              }
            }
          }
        } catch(e) { console.log(`Yahoo q2 ${sym}:`, e.message); }
      }
    }

    // ── Source 4: Moneycontrol MCX Gold commodity feed ──
    if (!ibja24k) {
      try {
        const r = await withTimeout(fetch(
          "https://priceapi.moneycontrol.com/pricefeed/commodity/getdata?exchange=MCX&type=C&sc_id=MCX_GOLD",
          { headers: { Accept: "application/json", Referer: "https://www.moneycontrol.com/", "User-Agent": "Mozilla/5.0" } }
        ), 7000);
        if (r.ok) {
          const d = await r.json();
          const raw = parseFloat(d?.data?.pricecurrent ?? d?.data?.price ?? 0);
          console.log("Moneycontrol MCX Gold raw:", raw);
          if (raw > 0) {
            const per1g = per10gTo1g(raw);
            if (per1g && ibjaCheck(per1g)) {
              ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
              ibjaSource = "moneycontrol-mcx";
              console.log("IBJA from moneycontrol: Rs." + ibja24k.toFixed(2));
            }
          }
        }
      } catch(e) { console.log("moneycontrol error:", e.message); }
    }

    // ── Source 5: Stooq XAU/INR (free CSV, no auth, rarely blocked) ──
    // Stooq returns XAU price in INR per troy oz. Divide by TROY to get per gram.
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
            const closeINR = parseFloat(cols[6]); // Close column = price of 1 troy oz in INR
            console.log("Stooq XAU/INR close (per troy oz):", closeINR);
            if (closeINR > 1000) {
              const per1g = closeINR / TROY;
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

    // ── Source 6: GoodReturns HTML scrape ──
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
          const patterns = [
            /(?:24\s*[Kk]|999)[^\d]{0,40}([\d,]{5,7})/,
            /gold_rate_24k['":\s]+([\d,]{5,7})/i,
            /"price"\s*:\s*"([\d.]{4,8})"/,
            /per\s*gram[^\d]{0,20}([\d,]{5,7})/i,
          ];
          for (const pat of patterns) {
            const m = html.match(pat);
            if (m) {
              const val = parseFloat(m[1].replace(/,/g, ""));
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

    // ── Source 7: Calculated fallback — international spot + India import duty ──
    // India reduced customs duty on gold from 15% to 6% in July 2024 Union Budget.
    // Total landed cost = spot * (1 + 0.06 customs) * (1 + 0.025 IGST) = spot * 1.0865
    // This is a reliable formula fallback — badge shown as "CALCULATED" on the UI.
    if (!ibja24k) {
      const DUTY_MULTIPLIER = 1.0865; // 6% customs + 2.5% IGST (post July 2024 budget)
      ibja24k = calc24k * DUTY_MULTIPLIER;
      ibja22k = ibja24k * 0.916;
      ibja995 = ibja24k * 0.995;
      ibjaSource = "calculated";
      console.log("IBJA: using duty-based calculation (spot * 1.0865): Rs." + ibja24k.toFixed(2));
    }

    console.log(`IBJA final: Rs.${ibja24k.toFixed(2)}/g from [${ibjaSource}]`);

    // ── STEP 5: ETF NAV → Rs. per gram ──
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

    // Rs./unit → Rs./gram
    const etfNavs = {}, etfPrevClose = {};
    ALL_ETF_SYMBOLS.forEach(sym => {
      const liveUnit = etfNavsRaw[sym];
      if (liveUnit > 0) {
        etfNavs[sym] = liveUnit / GRAMS_PER_UNIT;
        if (etfPrevCloseRaw[sym]) etfPrevClose[sym] = etfPrevCloseRaw[sym] / GRAMS_PER_UNIT;
      }
    });
    console.log("ETF navs (Rs./g):", Object.entries(etfNavs).map(([k,v]) => `${k}:${v.toFixed(0)}`).join(", ") || "none");

    // ── STEP 6: Historical sparklines ──
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
      price:        goldPriceUSD,
      usdInr,
      aedInr,
      silverPrice:  silverUSD,
      ibja24k,      // Rs./gram 999 purity
      ibja22k,      // Rs./gram 916 purity
      ibja995,      // Rs./gram 995 purity
      etfNavs,      // { SYM: Rs./gram }
      etfPrevClose, // { SYM: Rs./gram prev close }
      etfSparklines,
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
