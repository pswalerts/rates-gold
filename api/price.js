let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 60 minutes — keeps all free API quotas safe

export default async function handler(req, res) {
  try {
    if (cache && Date.now() - cacheTime < CACHE_DURATION) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).json({ ...cache, cached: true });
    }

    // Paid API keys — optional, only used as last-resort fallback
    const GOLD_API_KEY        = process.env.GOLD_API_KEY;
    const METAL_PRICE_API_KEY = process.env.METAL_PRICE_API_KEY;

    // ─────────────────────────────────────────────
    // STEP 1: USD/INR — all free, no key needed
    // Priority: fawazahmed0 CDN → frankfurter → open.er-api
    // ─────────────────────────────────────────────
    let usdInr = null;

    const fxSources = [
      // Completely free, high uptime, jsdelivr CDN
      async () => {
        const r = await fetch(
          "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
          { headers: { "Accept": "application/json" } }
        );
        if (!r.ok) return null;
        const d = await r.json();
        return d?.usd?.inr ?? null;
      },
      // Fallback: frankfurter.app — free, ECB data, no key
      async () => {
        const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=INR");
        if (!r.ok) return null;
        const d = await r.json();
        return d?.rates?.INR ?? null;
      },
      // Fallback: open.er-api — 1500 req/month free, no key needed
      async () => {
        const r = await fetch("https://open.er-api.com/v6/latest/USD");
        if (!r.ok) return null;
        const d = await r.json();
        return d?.rates?.INR ?? null;
      },
    ];

    for (const src of fxSources) {
      try {
        const rate = await src();
        if (rate && rate > 75 && rate < 120) { usdInr = rate; break; }
      } catch(e) {}
    }
    if (!usdInr) { usdInr = 84.5; console.log("USD/INR: using hardcoded fallback"); }
    else { console.log("USD/INR:", usdInr); }

    // ─────────────────────────────────────────────
    // STEP 2: AED/INR — derived from USD/INR
    // AED is pegged to USD at exactly 3.6725
    // ─────────────────────────────────────────────
    const usdAed = 3.6725;
    const aedInr = usdInr / usdAed;

    // ─────────────────────────────────────────────
    // STEP 3: XAU/USD gold spot — free sources first
    // Priority: goldprice.org → metals.live → Yahoo Finance
    //           → goldapi.io (paid, fallback) → metalpriceapi (paid, fallback)
    // ─────────────────────────────────────────────
    let goldPriceUSD = null;
    let goldSource   = "unknown";

    // Source 1: goldprice.org public data API — free, no key, powers goldprice.org itself
    try {
      const r = await fetch("https://data-asg.goldprice.org/dbXRates/USD", {
        headers: {
          "Accept": "application/json",
          "Origin": "https://goldprice.org",
          "Referer": "https://goldprice.org/"
        }
      });
      if (r.ok) {
        const d = await r.json();
        const xau = d?.items?.[0]?.xauPrice;
        if (xau > 1000) {
          goldPriceUSD = xau;
          goldSource   = "goldprice.org";
          console.log("Gold goldprice.org:", goldPriceUSD);
        }
      }
    } catch(e) { console.log("goldprice.org error:", e.message); }

    // Source 2: metals.live — free public API, no key
    if (!goldPriceUSD) {
      try {
        const r = await fetch("https://metals.live/api/spot", {
          headers: { "Accept": "application/json" }
        });
        if (r.ok) {
          const d = await r.json();
          // Response is an array: [{gold: 3300.xx, silver: 33.xx, ...}]
          const item = Array.isArray(d) ? d[0] : d;
          const xau  = item?.gold ?? item?.XAU;
          if (xau > 1000) {
            goldPriceUSD = xau;
            goldSource   = "metals.live";
            console.log("Gold metals.live:", goldPriceUSD);
          }
        }
      } catch(e) { console.log("metals.live error:", e.message); }
    }

    // Source 3: Yahoo Finance — free, no key, uses public chart API
    if (!goldPriceUSD) {
      try {
        const r = await fetch(
          "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d",
          { headers: { "Accept": "application/json" } }
        );
        if (r.ok) {
          const d = await r.json();
          const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p > 1000) {
            goldPriceUSD = p;
            goldSource   = "yahoo-finance";
            console.log("Gold Yahoo Finance:", goldPriceUSD);
          }
        }
      } catch(e) { console.log("Yahoo Finance error:", e.message); }
    }

    // Source 4: goldapi.io — paid, ~100 req/month free tier, only if key present
    if (!goldPriceUSD && GOLD_API_KEY) {
      try {
        const r = await fetch("https://www.goldapi.io/api/XAU/USD", {
          headers: { "x-access-token": GOLD_API_KEY }
        });
        if (r.ok) {
          const d = await r.json();
          if (d?.price > 1000) {
            goldPriceUSD = d.price;
            goldSource   = "goldapi.io";
            console.log("Gold goldapi.io:", goldPriceUSD);
          }
        }
      } catch(e) {}
    }

    // Source 5: metalpriceapi.com — paid, 100 req/month free, only if key present
    if (!goldPriceUSD && METAL_PRICE_API_KEY) {
      try {
        const r = await fetch(
          `https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`
        );
        if (r.ok) {
          const d = await r.json();
          if (d?.rates?.USD > 0) {
            goldPriceUSD = d.rates.USD;
            goldSource   = "metalpriceapi.com";
            console.log("Gold metalpriceapi:", goldPriceUSD);
          }
        }
      } catch(e) {}
    }

    if (!goldPriceUSD) throw new Error("All gold price sources failed");

    // ─────────────────────────────────────────────
    // STEP 4: XAG/USD silver — free sources first
    // ─────────────────────────────────────────────
    let silverUSD = null;

    // Source 1: goldprice.org — same call returns xagPrice too
    try {
      const r = await fetch("https://data-asg.goldprice.org/dbXRates/USD", {
        headers: {
          "Accept": "application/json",
          "Origin": "https://goldprice.org",
          "Referer": "https://goldprice.org/"
        }
      });
      if (r.ok) {
        const d = await r.json();
        const xag = d?.items?.[0]?.xagPrice;
        if (xag > 0) { silverUSD = xag; console.log("Silver goldprice.org:", silverUSD); }
      }
    } catch(e) {}

    // Source 2: metals.live
    if (!silverUSD) {
      try {
        const r = await fetch("https://metals.live/api/spot", {
          headers: { "Accept": "application/json" }
        });
        if (r.ok) {
          const d = await r.json();
          const item = Array.isArray(d) ? d[0] : d;
          const xag  = item?.silver ?? item?.XAG;
          if (xag > 0) { silverUSD = xag; console.log("Silver metals.live:", silverUSD); }
        }
      } catch(e) {}
    }

    // Source 3: Yahoo Finance
    if (!silverUSD) {
      try {
        const r = await fetch(
          "https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=1d",
          { headers: { "Accept": "application/json" } }
        );
        if (r.ok) {
          const d = await r.json();
          const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p > 0) { silverUSD = p; console.log("Silver Yahoo Finance:", silverUSD); }
        }
      } catch(e) {}
    }

    // Fallback: derive from gold using historical ~85:1 ratio
    if (!silverUSD) { silverUSD = goldPriceUSD / 85; console.log("Silver: ratio fallback"); }

    // ─────────────────────────────────────────────
    // STEP 5: IBJA official Indian rates
    // Primary: ibjarates.com API
    // Fallback: Moneycontrol MCX commodity feed (free, no key)
    // ─────────────────────────────────────────────
    let ibja24k = null, ibja22k = null, ibja995 = null;
    let ibjaSource = "none";

    // Primary: IBJA official API
    try {
      const r = await fetch("https://ibjarates.com/api/goldrates", {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)"
        }
      });
      if (r.ok) {
        const d = await r.json();
        const g999 = d?.Gold999 ?? d?.gold999 ?? d?.["999"];
        const g916 = d?.Gold916 ?? d?.gold916 ?? d?.["916"];
        const g995 = d?.Gold995 ?? d?.gold995 ?? d?.["995"];
        if (g999 > 1000) {
          ibja24k    = g999 / 10;
          ibja22k    = g916 ? g916 / 10 : ibja24k * 0.916;
          ibja995    = g995 ? g995 / 10 : ibja24k * 0.995;
          ibjaSource = "ibjarates.com";
          console.log("IBJA 24K/g:", ibja24k);
        }
      }
    } catch(e) { console.log("IBJA API error:", e.message); }

    // Fallback: Moneycontrol MCX Gold feed — free, no key needed
    if (!ibja24k) {
      try {
        const r = await fetch(
          "https://priceapi.moneycontrol.com/pricefeed/commodity/getdata?exchange=MCX&type=C&sc_id=MCX_GOLD",
          {
            headers: {
              "Accept": "application/json",
              "Referer": "https://www.moneycontrol.com/",
              "User-Agent": "Mozilla/5.0 (compatible; rateof.gold/1.0)"
            }
          }
        );
        if (r.ok) {
          const d  = await r.json();
          // MCX Gold price is per 10g in INR
          const p  = d?.data?.pricecurrent ?? d?.data?.price;
          if (p && p > 10000) {
            ibja24k    = p / 10;
            ibja22k    = ibja24k * 0.916;
            ibja995    = ibja24k * 0.995;
            ibjaSource = "moneycontrol-mcx";
            console.log("IBJA via MCX:", ibja24k);
          }
        }
      } catch(e) { console.log("MCX fallback error:", e.message); }
    }

    // ─────────────────────────────────────────────
    // STEP 6: Live ETF NAVs — NSE official API
    // These are free, no key needed
    // ─────────────────────────────────────────────
    const etfSymbols = ["GOLDBEES", "SBIGETS", "HDFCMFGETF"];
    const etfNavs    = {};

    for (const sym of etfSymbols) {
      // Attempt 1: NSE India official equity quote
      try {
        const r = await fetch(
          `https://www.nseindia.com/api/quote-equity?symbol=${sym}`,
          {
            headers: {
              "Accept": "application/json",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
              "Referer": "https://www.nseindia.com/",
              "Accept-Language": "en-US,en;q=0.9",
            }
          }
        );
        if (r.ok) {
          const d   = await r.json();
          const ltp = d?.priceInfo?.lastPrice ?? d?.priceInfo?.close;
          if (ltp > 0) { etfNavs[sym] = ltp; continue; }
        }
      } catch(e) {}

      // Attempt 2: Yahoo Finance (.NS suffix = NSE)
      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=1d`,
          { headers: { "Accept": "application/json" } }
        );
        if (r.ok) {
          const d = await r.json();
          const p = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p > 0) { etfNavs[sym] = p; continue; }
        }
      } catch(e) {}

      // Attempt 3: mfapi.in (mutual fund NAV API — free)
      try {
        const r = await fetch(`https://api.mfapi.in/mf/search?q=${sym}`, {
          headers: { "Accept": "application/json" }
        });
        if (r.ok) {
          const d   = await r.json();
          const hit = Array.isArray(d) ? d[0] : null;
          if (hit?.schemeCode) {
            const r2 = await fetch(`https://api.mfapi.in/mf/${hit.schemeCode}`, {
              headers: { "Accept": "application/json" }
            });
            if (r2.ok) {
              const d2  = await r2.json();
              const nav = parseFloat(d2?.data?.[0]?.nav);
              if (nav > 0) { etfNavs[sym] = nav; }
            }
          }
        }
      } catch(e) {}
    }

    // Build and cache response
    cache = {
      price:       goldPriceUSD,
      usdInr:      usdInr,
      aedInr:      aedInr,
      silverPrice: silverUSD,
      ibja24k:     ibja24k,
      ibja22k:     ibja22k,
      ibja995:     ibja995,
      etfNavs:     etfNavs,
      timestamp:   new Date().toISOString(),
      sources: {
        fx:   usdInr === 84.5   ? "fallback"    : "live",
        gold: goldSource,
        ibja: ibjaSource,
        etf:  Object.keys(etfNavs).length > 0 ? "live" : "none"
      }
    };
    cacheTime = Date.now();

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).json(cache);

  } catch (err) {
    console.error("price API error:", err);
    // Return stale cache on error rather than failing completely
    if (cache) {
      return res.status(200).json({ ...cache, cached: true, stale: true });
    }
    res.status(500).json({ error: err.toString() });
  }
}
