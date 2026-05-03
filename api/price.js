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

    // ══════════════════════════════════════════════════════════════
    // STEP 1: USD/INR
    // Current rate as of May 2026 is ~95.00.
    // Hardcoded fallback updated to 95.0 — critical for correct gold prices.
    // Multiple sources tried in order; first valid response wins.
    // Valid range: 75–120 (covers any realistic INR move over next few years)
    // ══════════════════════════════════════════════════════════════
    let usdInr = null;
    const fxSources = [
      // Source 1: fawazahmed0 currency API (free, no key, updates daily)
      async () => {
        const r = await withTimeout(fetch(
          "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
          { headers: { Accept: "application/json" } }
        ), 5000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.usd?.inr ?? null;
      },
      // Source 2: fawazahmed0 fallback URL (same data, different CDN)
      async () => {
        const r = await withTimeout(fetch(
          "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
          { headers: { Accept: "application/json" } }
        ), 5000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.usd?.inr ?? null;
      },
      // Source 3: Frankfurter (ECB data, free, reliable)
      async () => {
        const r = await withTimeout(fetch("https://api.frankfurter.app/latest?from=USD&to=INR"), 5000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.rates?.INR ?? null;
      },
      // Source 4: Open Exchange Rates (free tier, no key needed for latest)
      async () => {
        const r = await withTimeout(fetch("https://open.er-api.com/v6/latest/USD"), 5000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.rates?.INR ?? null;
      },
      // Source 5: Yahoo Finance USD/INR
      async () => {
        const r = await withTimeout(fetch(
          "https://query1.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d",
          { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }
        ), 6000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
      },
      // Source 6: Yahoo Finance query2
      async () => {
        const r = await withTimeout(fetch(
          "https://query2.finance.yahoo.com/v8/finance/chart/USDINR%3DX?interval=1d&range=1d",
          { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }
        ), 6000);
        if (!r.ok) return null;
        const d = await r.json();
        return d?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
      },
    ];

    for (const src of fxSources) {
      try {
        const rate = await src();
        if (rate && rate > 75 && rate < 120) {
          usdInr = rate;
          console.log(`USD/INR: ${usdInr.toFixed(4)} (live)`);
          break;
        }
      } catch(e) {}
    }

    // IMPORTANT: fallback updated to 95.0 (actual May 2026 rate, was wrongly 84.5)
    if (!usdInr) {
      usdInr = 95.0;
      console.log("USD/INR: using hardcoded fallback 95.0");
    }

    const aedInr = usdInr / 3.6725;
    console.log(`USD/INR: ${usdInr.toFixed(4)} | AED/INR: ${aedInr.toFixed(4)}`);

    // ══════════════════════════════════════════════════════════════
    // STEP 2: Gold spot XAU/USD
    // ══════════════════════════════════════════════════════════════
    let goldPriceUSD = null, goldSource = "unknown";
    try { const r = await withTimeout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } })); if (r.ok) { const d = await r.json(); const xau = d?.items?.[0]?.xauPrice; if (xau > 1000) { goldPriceUSD = xau; goldSource = "goldprice.org"; } } } catch(e) {}
    if (!goldPriceUSD) { try { const r = await withTimeout(fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } })); if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const xau = item?.gold ?? item?.XAU; if (xau > 1000) { goldPriceUSD = xau; goldSource = "metals.live"; } } } catch(e) {} }
    if (!goldPriceUSD) { try { const r = await withTimeout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } })); if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 1000) { goldPriceUSD = p; goldSource = "yahoo-gc"; } } } catch(e) {} }
    if (!goldPriceUSD) { try { const r = await withTimeout(fetch("https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } })); if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 1000) { goldPriceUSD = p; goldSource = "yahoo-gc-q2"; } } } catch(e) {} }
    if (!goldPriceUSD && GOLD_API_KEY) { try { const r = await withTimeout(fetch("https://www.goldapi.io/api/XAU/USD", { headers: { "x-access-token": GOLD_API_KEY } })); if (r.ok) { const d = await r.json(); if (d?.price > 1000) { goldPriceUSD = d.price; goldSource = "goldapi.io"; } } } catch(e) {} }
    if (!goldPriceUSD && METAL_PRICE_API_KEY) { try { const r = await withTimeout(fetch(`https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`)); if (r.ok) { const d = await r.json(); if (d?.rates?.USD > 0) { goldPriceUSD = d.rates.USD; goldSource = "metalpriceapi.com"; } } } catch(e) {} }
    if (!goldPriceUSD) throw new Error("All gold price sources failed");

    const calc24k = (goldPriceUSD / TROY) * usdInr;
    console.log(`XAU/USD: $${goldPriceUSD.toFixed(2)} [${goldSource}] | calc24k: Rs.${calc24k.toFixed(2)}/g`);

    // ══════════════════════════════════════════════════════════════
    // STEP 3: Silver XAG/USD
    // ══════════════════════════════════════════════════════════════
    let silverUSD = null;
    try { const r = await withTimeout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Accept: "application/json", Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } })); if (r.ok) { const d = await r.json(); const xag = d?.items?.[0]?.xagPrice; if (xag > 0) silverUSD = xag; } } catch(e) {}
    if (!silverUSD) { try { const r = await withTimeout(fetch("https://metals.live/api/spot", { headers: { Accept: "application/json" } })); if (r.ok) { const d = await r.json(); const item = Array.isArray(d) ? d[0] : d; const xag = item?.silver ?? item?.XAG; if (xag > 0) silverUSD = xag; } } catch(e) {} }
    if (!silverUSD) { try { const r = await withTimeout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=1d", { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } })); if (r.ok) { const d = await r.json(); const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (p > 0) silverUSD = p; } } catch(e) {} }
    if (!silverUSD) silverUSD = goldPriceUSD / 85;

    // ══════════════════════════════════════════════════════════════
    // STEP 4: IBJA India gold rate — 8-source chain
    //
    // ibjaCheck: wide absolute range Rs.5,000–30,000/gram
    // Avoids false rejections when gold surges (old % range was wrong)
    //
    // toPerGram: handles per-100g, per-10g, and per-gram values
    // ══════════════════════════════════════════════════════════════
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSource = "none";

    const ibjaCheck = (val) => {
      const n = parseFloat(val);
      return n > 5000 && n < 30000;
    };

    const toPerGram = (v) => {
      const n = parseFloat(v);
      if (!n || n <= 0) return null;
      if (n > 50000) return n / 100; // per 100g
      if (n > 10000) return n / 10;  // per 10g
      return n;                       // already per gram
    };

    // ── Source 1: ibjarates.com API ──
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
            console.log("ibjarates.com raw999:", raw999, "-> per1g:", per1g);
            if (per1g && ibjaCheck(per1g)) {
              ibja24k = per1g;
              ibja22k = raw916 ? (toPerGram(raw916) ?? ibja24k * 0.916) : ibja24k * 0.916;
              ibja995 = raw995 ? (toPerGram(raw995) ?? ibja24k * 0.995) : ibja24k * 0.995;
              ibjaSource = "ibjarates.com";
              console.log("IBJA from ibjarates.com: Rs." + ibja24k.toFixed(2) + "/g");
            }
          }
        } else { console.log("ibjarates.com HTTP", r.status); }
      } catch(e) { console.log("ibjarates.com error:", e.message); }
    }

    // ── Source 2: Yahoo Finance MCX Gold — query1 ──
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
            console.log(`Yahoo q1 MCX ${sym}: raw =`, price);
            if (price > 0) {
              const per1g = toPerGram(price);
              console.log(`Yahoo q1 MCX ${sym}: per1g =`, per1g);
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
            console.log(`Yahoo q2 MCX ${sym}: raw =`, price);
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

    // ── Source 4: Moneycontrol MCX Gold ──
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

    // ── Source 5: Stooq XAU/INR ──
    // Returns 1 troy oz price in INR — divide by TROY for per gram
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
            /(?:24\s*[Kk]|999)[^\d]{0,60}?(1[0-9],\d{3}|\d{4,6})/,
            /gold_rate_24k['":\s]+(1[0-9],\d{3}|\d{5,6})/i,
            /(?:per gram|1 gram)[^\d]{0,30}?(1[0-9],\d{3}|\d{5,6})/i,
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

    // ── Source 7: indiagoldratesapi.com ──
    if (!ibja24k) {
      try {
        const r = await withTimeout(fetch("https://indiagoldratesapi.com/api/rates", {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)" }
        }), 6000);
        if (r.ok) {
          const d = await r.json();
          console.log("indiagoldratesapi RAW:", JSON.stringify(d).slice(0, 400));
          const raw =
            d?.gold24k ?? d?.gold_24k ?? d?.Gold24K ?? d?.["24k"] ?? d?.["24K"] ??
            d?.data?.gold24k ?? d?.data?.["24k"] ?? d?.data?.["24K"] ??
            d?.rates?.gold24k ?? d?.rates?.["24k"];
          if (raw) {
            const per1g = toPerGram(raw);
            if (per1g && ibjaCheck(per1g)) {
              ibja24k = per1g; ibja22k = ibja24k * 0.916; ibja995 = ibja24k * 0.995;
              ibjaSource = "indiagoldratesapi.com";
              console.log("IBJA from indiagoldratesapi: Rs." + ibja24k.toFixed(2));
            }
          }
        }
      } catch(e) { console.log("indiagoldratesapi error:", e.message); }
    }

    // ── Source 8: Calculated fallback ──
    // India price = spot × (1 + 6% customs) × (1 + 2.5% IGST) = spot × 1.0865
    // Only reached if ALL live sources fail. Badge shown as "CALC" on frontend.
    if (!ibja24k) {
      const DUTY_MULTIPLIER = 1.0865; // post July 2024 Union Budget: 6% customs + 2.5% IGST
      ibja24k = calc24k * DUTY_MULTIPLIER;
      ibja22k = ibja24k * 0.916;
      ibja995 = ibja24k * 0.995;
      ibjaSource = "calculated";
      console.log(`IBJA: all sources failed. calc24k=Rs.${calc24k.toFixed(2)} x ${DUTY_MULTIPLIER} = Rs.${ibja24k.toFixed(2)}/g`);
    }

    console.log(`=== IBJA FINAL: Rs.${ibja24k.toFixed(2)}/g [${ibjaSource}] ===`);

    // ══════════════════════════════════════════════════════════════
    // STEP 5: ETF NAV → Rs. per gram
    // Each Indian gold ETF unit ≈ 0.9950g of 999.9 gold
    // Unit price on NSE ÷ 0.995 = Rs./gram
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
      const liveUnit = etfNavsRaw[sym];
      if (liveUnit > 0) {
        etfNavs[sym] = liveUnit / GRAMS_PER_UNIT;
        if (etfPrevCloseRaw[sym]) etfPrevClose[sym] = etfPrevCloseRaw[sym] / GRAMS_PER_UNIT;
      }
    });
    console.log("ETF navs (Rs./g):", Object.entries(etfNavs).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(", ") || "none");

    // ══════════════════════════════════════════════════════════════
    // STEP 6: Historical sparklines (ETF price history)
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
      usdInr,                       // live USD/INR (fallback 95.0)
      aedInr,                       // usdInr / 3.6725
      silverPrice:  silverUSD,      // XAG/USD spot
      ibja24k,      // Rs./gram 999 purity — always a number, never null
      ibja22k,      // Rs./gram 916 purity
      ibja995,      // Rs./gram 995 purity
      etfNavs,      // { SYM: Rs./gram }
      etfPrevClose, // { SYM: Rs./gram prev close }
      etfSparklines,
      timestamp: new Date().toISOString(),
      sources: {
        fx:   usdInr === 95.0 ? "fallback-95" : "live",
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
