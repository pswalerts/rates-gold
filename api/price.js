// -----------------------------------------------------------------
//  rateof.gold -- /api/price
//
//  IBJA scraping chain:
//  S0: ibja.co official website
//  S1: ibjarates.com (Cloudflare-detection added)
//  S2: livemint.com gold rates
//  S3: economictimes.indiatimes.com gold rates
//  S4: goodreturns.in
//  S5: Yahoo MCX GOLD.MCX / GOLDM.MCX (both div:10)
//  S6: Duty-adjusted calculated fallback (spot × 1.09, labelled CALC)
//
//  goldHistory: XAU/USD converted to Rs./gram for each time range.
//  Used by the hero history panel -- NOT ETF sparklines.
//  ETF sparklines are still fetched separately for the ETF chart panel.
//
//  CRITICAL: ibja24k/22k/995 are returned as-is to the frontend.
//  Do NOT multiply by any duty/GST factor here.
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
    // ibjaOk   : valid per-gram  range Rs. 7,000 – 25,000
    // per10gOk : valid per-10g   range Rs. 70,000 – 250,000
    // =========================================================
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSrc = "?";

    const ibjaOk   = v => typeof v === "number" && isFinite(v) && v > 7000  && v < 25000;
    const per10gOk = v => typeof v === "number" && isFinite(v) && v > 70000 && v < 250000;

    const setIBJA = (v24, src, v22 = null, v995 = null) => {
      ibja24k = v24;
      ibja22k = (v22  && ibjaOk(v22))  ? v22  : v24 * 0.916;
      ibja995 = (v995 && ibjaOk(v995)) ? v995 : v24 * 0.995;
      ibjaSrc = src;
      console.log(`IBJA [${src}]: 999=Rs.${ibja24k.toFixed(2)}, 916=Rs.${ibja22k.toFixed(2)}, 995=Rs.${ibja995.toFixed(2)}`);
    };

    // Helper: parse a number from an HTML snippet that might be per-gram or per-10g
    function parseRsVal(str) {
      if (!str) return null;
      const n = parseFloat(str.replace(/,/g, ""));
      if (ibjaOk(n))   return { v: n,      per10g: false };
      if (per10gOk(n)) return { v: n / 10, per10g: true  };
      return null;
    }

    // -- S0: ibja.co OFFICIAL WEBSITE --
    if (!ibja24k) {
      for (const url of ["https://ibja.co/IBJARates", "https://www.ibja.co/IBJARates"]) {
        try {
          const r = await tout(fetch(url, {
            headers: {
              "User-Agent": UA,
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-IN,en;q=0.9",
              "Referer": "https://www.google.com/search?q=ibja+gold+rate+today",
            }
          }), 12000);
          if (!r.ok) { console.log(`ibja.co: HTTP ${r.status}`); continue; }
          const html = await r.text();
          console.log(`ibja.co: HTTP ${r.status}, ${html.length} bytes`);
          if (/checking your browser|just a moment|cloudflare ray/i.test(html)) { console.log("ibja.co: CF challenge"); continue; }

          // A: "Fine Gold" label near a number
          const mFine = html.match(/Fine\s*Gold[^<]{0,80}?([\d,]{5,7})/i);
          if (mFine) { const p = parseRsVal(mFine[1]); if (p) { setIBJA(p.v, "ibja.co-A"); break; } }

          // B: "999" near a number
          const m999 = html.match(/\b999\b[^<]{0,60}?([\d,]{5,7})/i);
          if (!ibja24k && m999) { const p = parseRsVal(m999[1]); if (p) { setIBJA(p.v, "ibja.co-B"); break; } }

          // C: grab all 5-6 digit numbers; first valid one wins
          if (!ibja24k) {
            const allNums = [...html.matchAll(/([\d,]{5,7})/g)].map(m => m[1]);
            for (const s of allNums) { const p = parseRsVal(s); if (p && ibjaOk(p.v)) { setIBJA(p.v, "ibja.co-C"); break; } }
          }
        } catch (e) { console.log(`ibja.co error:`, e.message); }
        if (ibja24k) break;
      }
    }

    // -- S1: ibjarates.com --
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
          console.log(`ibjarates.com: HTTP ${r.status}, ${html.length} bytes`);
          if (/checking your browser|just a moment|cloudflare ray/i.test(html)) {
            console.log("ibjarates.com: Cloudflare challenge, skipping");
          } else {
            // A: <h3>NNNNN (1 Gram)</h3>
            const h3Re = /<h3[^>]*>\s*([\d,]+)\s*\(1\s*[Gg]ram\)\s*<\/h3>/g;
            const h3Vals = []; let m;
            while ((m = h3Re.exec(html)) !== null) h3Vals.push(parseFloat(m[1].replace(/,/g, "")));
            console.log("ibjarates A (h3):", h3Vals);
            if (h3Vals.length >= 3 && ibjaOk(h3Vals[0])) setIBJA(h3Vals[0], "ibjarates.com-hero", h3Vals[2], h3Vals[1]);

            // A2: flexible spacing variant
            if (!ibja24k) {
              const flexRe = /([\d,]{4,7})\s*\(1\s*[Gg]ram\)/g;
              const fv = []; while ((m = flexRe.exec(html)) !== null) fv.push(parseFloat(m[1].replace(/,/g, "")));
              if (fv.length >= 1 && ibjaOk(fv[0])) setIBJA(fv[0], "ibjarates.com-flex", fv[2] ?? null, fv[1] ?? null);
            }

            // B: date-matched table row (per 10g -> /10)
            if (!ibja24k) {
              const today = new Date();
              for (let d = 0; d <= 3; d++) {
                const dt = new Date(today); dt.setDate(dt.getDate() - d);
                const ds = `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${dt.getFullYear()}`;
                for (const pat of [
                  new RegExp(`(?:<strong>|<b>)\\s*${ds.replace(/\//g,"\\/")}\\s*(?:</strong>|</b>)\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>`, "i"),
                  new RegExp(`${ds.replace(/\//g,"\\/")}[^<]{0,30}</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>\\s*<td>\\s*(\\d{5,6})\\s*</td>`, "i"),
                ]) {
                  const tm = html.match(pat);
                  if (tm) {
                    const v999=parseFloat(tm[1])/10, v995=parseFloat(tm[2])/10, v916=parseFloat(tm[3])/10;
                    if (ibjaOk(v999)) { setIBJA(v999, `ibjarates.com-tbl-${ds}`, v916, v995); break; }
                  }
                }
                if (ibja24k) break;
              }
            }

            // C: three consecutive 5-6 digit <td> cells (flexible range)
            if (!ibja24k) {
              const sm = html.match(/<td>\s*(\d{5,6})\s*<\/td>\s*<td>\s*(\d{5,6})\s*<\/td>\s*<td>\s*(\d{5,6})\s*<\/td>/);
              if (sm) {
                const v999=parseFloat(sm[1])/10, v995=parseFloat(sm[2])/10, v916=parseFloat(sm[3])/10;
                if (ibjaOk(v999)) setIBJA(v999, "ibjarates.com-3cell", v916, v995);
              }
            }

            // D: any "(1 Gram)" pattern (flexible range)
            if (!ibja24k) {
              const dm = html.match(/(\d{4,6})\s*\(1\s*[Gg]ram\)/);
              if (dm) { const v = parseFloat(dm[1]); if (ibjaOk(v)) setIBJA(v, "ibjarates.com-ctx"); }
            }
          }
        } else { console.log(`ibjarates.com HTTP ${r.status}`); }
      } catch (e) { console.log("ibjarates.com error:", e.message); }
    }

    // -- S2: livemint.com --
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://www.livemint.com/market/commodities/gold-rate-today", {
          headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://www.google.com/" }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          console.log(`livemint: HTTP ${r.status}, ${html.length} bytes`);
          if (!/checking your browser|just a moment/i.test(html)) {
            // Look for 24K / 999 gold price per gram
            const patterns = [
              /24\s*[Kk][^<]{0,120}?([\d,]{4,6})\s*(?:per gram|\/gram|per gm)/i,
              /999[^<]{0,120}?([\d,]{4,6})/i,
              /(?:10\s*gram|10g)[^<]{0,80}?([\d,]{6,7})/i,  // per 10g
            ];
            for (const pat of patterns) {
              const pm = html.match(pat);
              if (pm) { const p = parseRsVal(pm[1]); if (p && ibjaOk(p.v)) { setIBJA(p.v, "livemint"); break; } }
            }
          }
        }
      } catch (e) { console.log("livemint error:", e.message); }
    }

    // -- S3: economictimes.indiatimes.com --
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://economictimes.indiatimes.com/markets/gold/gold-rate-in-india", {
          headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://www.google.com/" }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          console.log(`economictimes: HTTP ${r.status}, ${html.length} bytes`);
          if (!/checking your browser|just a moment/i.test(html)) {
            const patterns = [
              /24\s*[Kk][^<]{0,120}?([\d,]{4,6})\s*(?:per gram|\/gram|per gm)/i,
              /999\s*purity[^<]{0,120}?([\d,]{4,6})/i,
              /(?:10\s*gram|10g)[^<]{0,80}?([\d,]{6,7})/i,
            ];
            for (const pat of patterns) {
              const pm = html.match(pat);
              if (pm) { const p = parseRsVal(pm[1]); if (p && ibjaOk(p.v)) { setIBJA(p.v, "economictimes"); break; } }
            }
          }
        }
      } catch (e) { console.log("economictimes error:", e.message); }
    }

    // -- S4: goodreturns.in --
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://www.goodreturns.in/gold-rates/", {
          headers: { "User-Agent": UA, "Referer": "https://www.google.com/" }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          const patterns = [
            /(\d{4,6})\s*(?:per gram|\/gram|per gm)/i,
            /(?:24\s*[Kk]|999)[\s\S]{1,200}?(\d{4,6})/i,
          ];
          for (const pat of patterns) {
            const pm = html.match(pat);
            if (pm) { const v = parseFloat(pm[1].replace(/,/g, "")); if (ibjaOk(v)) { setIBJA(v, "goodreturns"); break; } }
          }
        }
      } catch (e) { console.log("goodreturns.in error:", e.message); }
    }

    // -- S5: Yahoo MCX --
    // Both contracts quoted in Rs./10g → div:10
    if (!ibja24k) {
      const mcxSymbols = [
        { sym: "GOLD.MCX",  div: 10 },
        { sym: "GOLDM.MCX", div: 10 },
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

    // -- S6: Calculated fallback with estimated 9% India duty --
    // (6% customs + 3% IGST, post July 2024 Budget)
    // Labelled "calculated" so the frontend shows the CALC badge.
    // This is a much closer approximation to IBJA than bare calc24k.
    if (!ibja24k) {
      const dutyAdj = calc24k * 1.09;
      setIBJA(dutyAdj, "calculated");
      console.log(`IBJA fallback = calc24k*1.09 = Rs.${dutyAdj.toFixed(2)}/g`);
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

    // Convert ETF unit price -> Rs./gram using ibja24k as the gold reference.
    // This avoids the GRAMS_PER_UNIT constant becoming stale after ETF splits.
    // gramsPerUnit = etfUnitPrice / ibja24k  (dynamic, self-correcting)
    const etfNavs = {}, etfPrevClose = {};
    ETF_SYMS.forEach(s => {
      if (etfRaw[s] > 0 && ibja24k > 0) {
        const gramsPerUnit = etfRaw[s] / ibja24k;
        etfNavs[s]    = etfRaw[s]    / gramsPerUnit;   // = ibja24k (approx, with tracking error)
        if (etfPrevRaw[s]) etfPrevClose[s] = etfPrevRaw[s] / gramsPerUnit;
      }
    });
    console.log("ETF Rs./g:", Object.entries(etfNavs).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(", ") || "none");

    // =========================================================
    // STEP 6: ETF Sparklines (for the ETF 52-week chart panel only)
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
          // Store as raw ETF unit price — the ETF chart panel handles its own display
          const pts = cls.map((c, i) => c != null ? { t: ts?.[i] ?? null, v: Math.round(c * 100) / 100 } : null).filter(Boolean);
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

    // =========================================================
    // STEP 7: Gold price history -> Rs./gram  (for hero history panel)
    //
    // Uses XAU/USD spot/futures converted to Rs./gram via USD/INR.
    // This is what the hero "1D / 1W / 1M..." tabs should display.
    // NOT ETF prices — those are in per-unit, not per-gram.
    // =========================================================
    async function fetchGoldHist(range, iv) {
      for (const sym of ["GC%3DF", "XAUUSD%3DX"]) {
        for (const host of ["query1", "query2"]) {
          try {
            const r = await tout(fetch(
              `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?interval=${iv}&range=${range}`,
              { headers: { "User-Agent": UA } }
            ), 9000);
            if (!r.ok) continue;
            const d = await r.json(), result = d?.chart?.result?.[0];
            const ts = result?.timestamp, cls = result?.indicators?.quote?.[0]?.close;
            if (!cls || cls.length < 2) continue;
            const pts = cls
              .map((c, i) => c != null ? { t: ts?.[i] ?? null, v: Math.round((c / TROY) * usdInr * 100) / 100 } : null)
              .filter(Boolean);
            if (pts.length >= 2) return pts;
          } catch (_) {}
        }
      }
      return null;
    }

    const ghResults = await Promise.allSettled(
      RANGES.map(({ range, iv }) => fetchGoldHist(range, iv))
    );
    const goldHistory = {};
    ghResults.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value?.length >= 2) {
        goldHistory[RANGES[i].key] = r.value;
      }
    });
    console.log("goldHistory keys:", Object.keys(goldHistory).join(", ") || "none");

    // =========================================================
    // Build cache & respond
    // =========================================================
    cache = {
      price:        goldUSD,
      usdInr,
      aedInr,
      silverPrice:  silverUSD,
      ibja24k,
      ibja22k,
      ibja995,
      etfNavs,
      etfPrevClose,
      etfSparklines,
      goldHistory,      // <-- NEW: used by hero history panel
      timestamp:    new Date().toISOString(),
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
