// -----------------------------------------------------------------
//  rateof.gold -- /api/price
//
//  IBJA scraping strategy (confirmed against live ibjarates.com HTML):
//
//  The page has TWO sets of numbers:
//  (1) Hero cards  -- <h3>14810 (1 Gram)</h3>  -> already per gram
//  (2) History table -- 148100 per 10g          -> divide by 10
//
//  S1: ibjarates.com hero cards  <- primary
//  S2: ibjarates.com history table (date-matched row)
//  S3: goodreturns.in HTML scrape
//  S4: Yahoo MCX GOLDM.MCX / GOLD.MCX
//  S5: Calculated fallback (NO duty multiplier, labelled CALC)
//
//  CRITICAL: ibja24k/22k/995 are returned as-is to the frontend.
//  Do NOT multiply by any duty/GST factor here. IBJA already
//  reflects India landed cost. Only calc24k is raw spot * FX.
// -----------------------------------------------------------------

let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000;

const TROY           = 31.1035;
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
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    function tout(p, ms = 8000) {
      return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
    }

    // =========================================================
    // STEP 1: USD / INR  (fallback = 85.0)
    // =========================================================
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
    ];
    for (const fn of fxSources) {
      try { const v = await fn(); if (v && v > 75 && v < 120) { usdInr = v; break; } } catch (_) {}
    }
    if (!usdInr) { usdInr = 85.0; console.log("USD/INR: fallback 85.0"); }
    else { console.log(`USD/INR: ${usdInr.toFixed(4)} (live)`); }

    const aedInr = usdInr / 3.6725;

    // =========================================================
    // STEP 2: XAU / USD
    // =========================================================
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
      ["yahoo-gc", async () => {
        const r = await tout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d", { headers: { "User-Agent": UA } }));
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

    // calc24k = pure international spot in INR/gram, NO duty added.
    // Used ONLY for the "International Spot -> INR" display column.
    const calc24k = (goldUSD / TROY) * usdInr;
    console.log(`XAU/USD $${goldUSD.toFixed(2)} [${goldSrc}] | USD/INR ${usdInr.toFixed(2)} | calc24k Rs.${calc24k.toFixed(2)}/g`);

    // =========================================================
    // STEP 3: XAG / USD
    // =========================================================
    let silverUSD = null;
    try { const r = await tout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } })); if (r.ok) { const d = await r.json(); const v = d?.items?.[0]?.xagPrice; if (v > 0) silverUSD = v; } } catch (_) {}
    try { if (!silverUSD) { const r = await tout(fetch("https://gold-api.com/price/XAG")); if (r.ok) { const d = await r.json(); if (d?.price > 0) silverUSD = d.price; } } } catch (_) {}
    try { if (!silverUSD) { const r = await tout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=1d", { headers: { "User-Agent": UA } })); if (r.ok) { const d = await r.json(); const v = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (v > 0) silverUSD = v; } } } catch (_) {}
    if (!silverUSD) silverUSD = goldUSD / 85;

    // =========================================================
    // STEP 4: IBJA India gold rate (Rs./gram, 999 purity)
    //
    //  ibjaOk: valid per-gram range Rs.7,000-Rs.25,000
    //  One fetch to ibjarates.com, four parse strategies on the same HTML.
    // =========================================================
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSrc = "?";

    const ibjaOk = v => typeof v === "number" && isFinite(v) && v > 7000 && v < 25000;

    const setIBJA = (v24, src, v22 = null, v995 = null) => {
      ibja24k = v24;
      ibja22k = (v22  && ibjaOk(v22))  ? v22  : v24 * 0.916;
      ibja995 = (v995 && ibjaOk(v995)) ? v995 : v24 * 0.995;
      ibjaSrc = src;
      console.log(`IBJA [${src}]: 999=Rs.${ibja24k.toFixed(2)}, 916=Rs.${ibja22k.toFixed(2)}, 995=Rs.${ibja995.toFixed(2)}`);
    };

    // -- S1 + S2: ibjarates.com (one fetch, four parse strategies) --
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://ibjarates.com/", {
          headers: {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-IN,en;q=0.9",
            "Cache-Control": "no-cache",
            "Referer": "https://www.google.com/search?q=ibja+gold+rate+today",
          }
        }), 12000);

        if (r.ok) {
          const html = await r.text();
          console.log(`ibjarates.com: HTTP ${r.status}, HTML ${html.length} bytes`);

          // Strategy A: <h3>NNNNN (1 Gram)</h3> hero cards
          // Order on page: 999, 995, 916, 750, 585
          const h3Re = /<h3[^>]*>\s*([\d,]+)\s*\(1\s*[Gg]ram\)\s*<\/h3>/g;
          const h3Vals = [];
          let m;
          while ((m = h3Re.exec(html)) !== null) {
            h3Vals.push(parseFloat(m[1].replace(/,/g, "")));
          }
          console.log("ibjarates A (h3):", h3Vals);
          if (h3Vals.length >= 3 && ibjaOk(h3Vals[0])) {
            setIBJA(h3Vals[0], "ibjarates.com-hero", h3Vals[2], h3Vals[1]);
          }

          // Strategy B: date-matched history table row (per 10g -> /10)
          if (!ibja24k) {
            const today = new Date();
            for (let d = 0; d <= 3; d++) {
              const dt = new Date(today); dt.setDate(dt.getDate() - d);
              const ds = `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${dt.getFullYear()}`;
              const datePatterns = [
                new RegExp(`(?:<strong>|<b>)\\s*${ds.replace(/\//g,"\\/")}\\s*(?:</strong>|</b>)\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>`, "i"),
                new RegExp(`${ds.replace(/\//g,"\\/")}[^<]{0,30}</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>`, "i"),
              ];
              let matched = false;
              for (const pat of datePatterns) {
                const tm = html.match(pat);
                if (tm) {
                  const v999 = parseFloat(tm[1]) / 10;
                  const v995 = parseFloat(tm[2]) / 10;
                  const v916 = parseFloat(tm[3]) / 10;
                  console.log(`ibjarates B (table ${ds} /10): 999=${v999}, 995=${v995}, 916=${v916}`);
                  if (ibjaOk(v999)) { setIBJA(v999, `ibjarates.com-table-${ds}`, v916, v995); matched = true; break; }
                }
              }
              if (matched || ibja24k) break;
            }
          }

          // Strategy C: any three consecutive 6-digit <td> cells
          if (!ibja24k) {
            const sm = html.match(/<td>\s*(1[34567]\d{4})\s*<\/td>\s*<td>\s*(1[34567]\d{4})\s*<\/td>\s*<td>\s*(1[0-3]\d{4})\s*<\/td>/);
            if (sm) {
              const v999 = parseFloat(sm[1]) / 10;
              const v995 = parseFloat(sm[2]) / 10;
              const v916 = parseFloat(sm[3]) / 10;
              console.log(`ibjarates C (3-cell /10): 999=${v999}, 995=${v995}, 916=${v916}`);
              if (ibjaOk(v999)) setIBJA(v999, "ibjarates.com-3cell", v916, v995);
            }
          }

          // Strategy D: any "NNNNN (1 Gram)" pattern anywhere on page
          if (!ibja24k) {
            const dm = html.match(/(1[34567]\d{3})\s*\(1\s*[Gg]ram\)/);
            if (dm) {
              const v = parseFloat(dm[1]);
              console.log(`ibjarates D (any 1-gram): ${v}`);
              if (ibjaOk(v)) setIBJA(v, "ibjarates.com-ctx");
            }
          }
        } else {
          console.log(`ibjarates.com HTTP ${r.status}`);
        }
      } catch (e) {
        console.log("ibjarates.com error:", e.message);
      }
    }

    // -- S3: goodreturns.in --
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://www.goodreturns.in/gold-rates/", {
          headers: { "User-Agent": UA, "Referer": "https://www.google.com/" }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          const patterns = [
            /(1[34567]\d{3})\s*(?:per gram|\/gram|per gm)/i,
            /(?:24\s*[Kk]|999)[\s\S]{1,200}?(1[34567]\d{3})/i,
          ];
          for (const pat of patterns) {
            const pm = html.match(pat);
            if (pm) {
              const v = parseFloat(pm[1].replace(/,/g, ""));
              if (ibjaOk(v)) { setIBJA(v, "goodreturns"); break; }
            }
          }
        }
      } catch (e) { console.log("goodreturns.in error:", e.message); }
    }

    // -- S4: Yahoo MCX --
    // GOLDM.MCX = mini contract, Rs./gram directly (no division)
    // GOLD.MCX  = main contract, Rs./10g -> divide by 10
    if (!ibja24k) {
      const mcxSymbols = [
        { sym: "GOLDM.MCX", div: 1  },
        { sym: "GOLD.MCX",  div: 10 },
      ];
      outer:
      for (const { sym, div } of mcxSymbols) {
        for (const host of ["query1", "query2"]) {
          try {
            const r = await tout(fetch(
              `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
              { headers: { "User-Agent": UA } }
            ), 8000);
            if (r.ok) {
              const d = await r.json();
              const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
              if (price > 0) {
                const v = price / div;
                console.log(`Yahoo ${host} ${sym}: raw=${price} /${div}=${v}/g`);
                if (ibjaOk(v)) { setIBJA(v, `yahoo-${sym}`); break outer; }
              }
            }
          } catch (e) { console.log(`Yahoo ${host} ${sym}:`, e.message); }
        }
      }
    }

    // -- S5: Fallback -- calc24k as-is, NO duty multiplier, labelled CALC --
    if (!ibja24k) {
      setIBJA(calc24k, "calculated");
      console.log(`IBJA fallback = calc24k Rs.${calc24k.toFixed(2)}/g -- no duty added, labelled CALC`);
    }

    console.log(`=== IBJA FINAL: 999=Rs.${ibja24k?.toFixed(2)}, 916=Rs.${ibja22k?.toFixed(2)}, 995=Rs.${ibja995?.toFixed(2)} [${ibjaSrc}] ===`);

    // =========================================================
    // STEP 5: ETF NAV -> Rs. per gram
    // =========================================================
    const ETF_SYMS = ["GOLDBEES", "SBIGETS", "HDFCMFGETF", "AXISGOLD", "KOTAKGOLD", "ICICIGOLD"];
    const BSE_CODES = {
      GOLDBEES: "590096", SBIGETS: "590091", HDFCMFGETF: "590094",
      AXISGOLD: "590102", KOTAKGOLD: "590103", ICICIGOLD: "590100",
    };

    async function fetchETF(sym) {
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
        etfNavs[s] = etfRaw[s] / GRAMS_PER_UNIT;
        if (etfPrevRaw[s]) etfPrevClose[s] = etfPrevRaw[s] / GRAMS_PER_UNIT;
      }
    });
    console.log("ETF Rs./g:", Object.entries(etfNavs).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(", ") || "none");

    // =========================================================
    // STEP 6: Sparklines (ETF price history -> Rs./gram)
    // =========================================================
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
          const pts = cls.map((c, i) => c != null ? { t: ts?.[i] ?? null, v: Math.round(c * scale * 100) / 100 } : null).filter(Boolean);
          if (pts.length >= 2) return pts;
        } catch (_) {}
      }
      return null;
    }

    const spJobs = [], spIdx = [];
    for (const s of ETF_SYMS) for (const { key, range, iv } of RANGES) { spJobs.push(fetchSpark(s, range, iv)); spIdx.push({ s, key }); }
    const spResults = await Promise.allSettled(spJobs);
    const etfSparklines = {};
    spResults.forEach((r, i) => {
      const { s, key } = spIdx[i];
      if (r.status === "fulfilled" && r.value?.length >= 2) {
        if (!etfSparklines[s]) etfSparklines[s] = {};
        etfSparklines[s][key] = r.value;
      }
    });

    cache = {
      price:       goldUSD,
      usdInr,
      aedInr,
      silverPrice: silverUSD,
      ibja24k,
      ibja22k,
      ibja995,
      etfNavs,
      etfPrevClose,
      etfSparklines,
      timestamp: new Date().toISOString(),
      sources: {
        fx:   usdInr === 85.0 ? "fallback-85" : "live",
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
