// -----------------------------------------------------------------
//  rateof.gold -- /api/price
//
//  IBJA scraping chain (S0 → S8, stops at first success):
//  S0: ibja.co official (multiple URL variants)
//  S1: ibjarates.com (Cloudflare-detection)
//  S2: livemint.com gold rates
//  S3: goldrate24.in
//  S4: economictimes.indiatimes.com
//  S5: goodreturns.in
//  S6: 24carat.in
//  S7: Yahoo Finance MCX GOLD.MCX / GOLDM.MCX (div:10)
//  S8: Duty-adjusted calculated fallback (spot × 1.05, labelled CALC)
//
//  ETF NAV chain (per symbol):
//  Phase 1: Yahoo Finance v7 bulk (.NS)
//  Phase 2 individual: v8 chart → v7 single → BSE API (x2) → MoneyControl → AMFI
//
//  Digital gold live prices:
//  MMTC-PAMP → Augmont → SafeGold  (multi-endpoint each, formula fallback)
//
//  goldHistory / silverHistory: XAU(XAG)/USD converted to Rs./gram
//  for each time range — used by hero history panels.
//
//  CRITICAL: ibja24k/22k/995 returned as-is; do NOT add duty/GST here.
// -----------------------------------------------------------------

let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 15 * 60 * 1000;  // 15 min — keeps digital gold prices fresh

const TROY = 31.1035;

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
      try { const v = await fn(); if (v && v > 75 && v < 130) { usdInr = v; break; } } catch (_) {}
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
    // ibjaOk   : valid per-gram  range Rs. 5,000 – 30,000
    // per10gOk : valid per-10g   range Rs. 50,000 – 300,000
    // =========================================================
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSrc = "?";

    const ibjaOk   = v => typeof v === "number" && isFinite(v) && v > 5000  && v < 30000;
    const per10gOk = v => typeof v === "number" && isFinite(v) && v > 50000 && v < 300000;

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
      const n = parseFloat(String(str).replace(/,/g, ""));
      if (ibjaOk(n))   return { v: n,      per10g: false };
      if (per10gOk(n)) return { v: n / 10, per10g: true  };
      return null;
    }

    const cfCheck = html => /checking your browser|just a moment|cloudflare ray|cf-browser-verification/i.test(html);

    // ---- S0: ibja.co OFFICIAL WEBSITE ----
    if (!ibja24k) {
      const ibjaUrls = [
        "https://ibja.co/IBJARates",
        "https://www.ibja.co/IBJARates",
        "https://ibja.co/",
        "https://www.ibja.co/",
        "https://ibja.co/rates",
        "https://ibja.co/Home",
      ];
      for (const url of ibjaUrls) {
        try {
          const r = await tout(fetch(url, {
            headers: {
              "User-Agent": UA,
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-IN,en;q=0.9",
              "Referer": "https://www.google.com/search?q=ibja+gold+rate+today",
              "Cache-Control": "no-cache",
            }
          }), 12000);
          if (!r.ok) { console.log(`ibja.co [${url}]: HTTP ${r.status}`); continue; }
          const html = await r.text();
          console.log(`ibja.co [${url}]: HTTP ${r.status}, ${html.length} bytes`);
          if (cfCheck(html)) { console.log(`ibja.co [${url}]: CF challenge`); continue; }

          // A: "Fine Gold" label near a number
          const mFine = html.match(/Fine\s*Gold[^<]{0,120}?([\d,]{5,8})/i);
          if (mFine) { const p = parseRsVal(mFine[1]); if (p) { setIBJA(p.v, "ibja.co-FineGold"); break; } }

          // B: "999" near a number
          const m999 = html.match(/\b999\b[^<]{0,80}?([\d,]{5,8})/i);
          if (!ibja24k && m999) { const p = parseRsVal(m999[1]); if (p) { setIBJA(p.v, "ibja.co-999"); break; } }

          // C: JSON-like data embedded in page scripts
          if (!ibja24k) {
            const jsonMatch = html.match(/"(?:rate999|gold999|rate24k|price999)"\s*:\s*"?([\d.]+)"?/i);
            if (jsonMatch) { const p = parseRsVal(jsonMatch[1]); if (p) { setIBJA(p.v, "ibja.co-json"); break; } }
          }

          // D: grab all valid numbers (per gram or per 10g); first valid one wins
          if (!ibja24k) {
            const allNums = [...html.matchAll(/([\d,]{5,8})/g)].map(m => m[1]);
            for (const s of allNums) {
              const p = parseRsVal(s);
              if (p && ibjaOk(p.v) && Math.abs(p.v - calc24k) / calc24k < 0.20) { // within 20% of calc
                setIBJA(p.v, "ibja.co-scan"); break;
              }
            }
          }
        } catch (e) { console.log(`ibja.co [${url}] error:`, e.message); }
        if (ibja24k) break;
      }
    }

    // ---- S1: ibjarates.com ----
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
          if (cfCheck(html)) {
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

            // C: three consecutive 5-6 digit <td> cells
            if (!ibja24k) {
              const sm = html.match(/<td>\s*(\d{5,6})\s*<\/td>\s*<td>\s*(\d{5,6})\s*<\/td>\s*<td>\s*(\d{5,6})\s*<\/td>/);
              if (sm) {
                const v999=parseFloat(sm[1])/10, v995=parseFloat(sm[2])/10, v916=parseFloat(sm[3])/10;
                if (ibjaOk(v999)) setIBJA(v999, "ibjarates.com-3cell", v916, v995);
              }
            }

            // D: any "(1 Gram)" pattern
            if (!ibja24k) {
              const dm = html.match(/(\d{4,6})\s*\(1\s*[Gg]ram\)/);
              if (dm) { const v = parseFloat(dm[1]); if (ibjaOk(v)) setIBJA(v, "ibjarates.com-ctx"); }
            }
          }
        } else { console.log(`ibjarates.com HTTP ${r.status}`); }
      } catch (e) { console.log("ibjarates.com error:", e.message); }
    }

    // ---- S2: livemint.com ----
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://www.livemint.com/market/commodities/gold-rate-today", {
          headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://www.google.com/" }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          console.log(`livemint: HTTP ${r.status}, ${html.length} bytes`);
          if (!cfCheck(html)) {
            const patterns = [
              /24\s*[Kk][^<]{0,120}?([\d,]{4,6})\s*(?:per gram|\/gram|per gm)/i,
              /999[^<]{0,120}?([\d,]{4,6})/i,
              /(?:10\s*gram|10g)[^<]{0,80}?([\d,]{6,7})/i,
            ];
            for (const pat of patterns) {
              const pm = html.match(pat);
              if (pm) { const p = parseRsVal(pm[1]); if (p && ibjaOk(p.v)) { setIBJA(p.v, "livemint"); break; } }
            }
          }
        }
      } catch (e) { console.log("livemint error:", e.message); }
    }

    // ---- S3: goldrate24.in ----
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://goldrate24.in/", {
          headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://www.google.com/search?q=ibja+gold+rate+today" }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          console.log(`goldrate24.in: HTTP ${r.status}, ${html.length} bytes`);
          if (!cfCheck(html)) {
            const patterns = [
              /IBJA[^<]{0,60}?([\d,]{4,6})\s*(?:per gram|\/gram|per gm)?/i,
              /999[^<]{0,80}?(?:IBJA|pure|purity)[^<]{0,80}?([\d,]{4,6})/i,
              /24\s*(?:K|carat|karat)[^<]{0,80}?([\d,]{4,6})\s*(?:per gram|\/gram)?/i,
              // table approach: look for per-gram numbers near IBJA context
              /([\d,]{4,6})\s*(?:per gram|\/gram|per gm)/i,
            ];
            for (const pat of patterns) {
              const pm = html.match(pat);
              if (pm) {
                const raw = pm[pm.length - 1]; // last capture group
                const v = parseFloat(raw.replace(/,/g, ""));
                if (ibjaOk(v)) { setIBJA(v, "goldrate24.in"); break; }
                const p = parseRsVal(raw); if (p && ibjaOk(p.v)) { setIBJA(p.v, "goldrate24.in-10g"); break; }
              }
            }
          }
        }
      } catch (e) { console.log("goldrate24.in error:", e.message); }
    }

    // ---- S4: economictimes.indiatimes.com ----
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://economictimes.indiatimes.com/markets/gold/gold-rate-in-india", {
          headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://www.google.com/" }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          console.log(`economictimes: HTTP ${r.status}, ${html.length} bytes`);
          if (!cfCheck(html)) {
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

    // ---- S5: goodreturns.in ----
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://www.goodreturns.in/gold-rates/", {
          headers: { "User-Agent": UA, "Referer": "https://www.google.com/" }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          console.log(`goodreturns: HTTP ${r.status}, ${html.length} bytes`);
          if (!cfCheck(html)) {
            const patterns = [
              /(\d{4,6})\s*(?:per gram|\/gram|per gm)/i,
              /(?:24\s*[Kk]|999)[\s\S]{1,200}?(\d{4,6})/i,
            ];
            for (const pat of patterns) {
              const pm = html.match(pat);
              if (pm) { const v = parseFloat(pm[1].replace(/,/g, "")); if (ibjaOk(v)) { setIBJA(v, "goodreturns"); break; } }
            }
          }
        }
      } catch (e) { console.log("goodreturns.in error:", e.message); }
    }

    // ---- S6: 24carat.in ----
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://24carat.in/frame.php?q=gold_rate_today", {
          headers: { "User-Agent": UA, "Referer": "https://www.google.com/" }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          console.log(`24carat.in: HTTP ${r.status}, ${html.length} bytes`);
          if (!cfCheck(html)) {
            const pm = html.match(/(?:24\s*karat|999|Fine\s*Gold)[^<]{0,100}?([\d,]{4,6})/i);
            if (pm) { const v = parseFloat(pm[1].replace(/,/g, "")); if (ibjaOk(v)) setIBJA(v, "24carat.in"); }
          }
        }
      } catch (e) { console.log("24carat.in error:", e.message); }
    }

    // ---- S7: Yahoo Finance MCX ----
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
                console.log(`Yahoo ${host} ${sym}: raw=${price} /${div}=${v.toFixed(2)}/g`);
                if (ibjaOk(v)) { setIBJA(v, `yahoo-${sym}`); break outer; }
              }
            }
          } catch (e) { console.log(`Yahoo ${host} ${sym}:`, e.message); }
        }
      }
    }

    // ---- S8: Calculated fallback ----
    // Based on observed IBJA vs international spot ratio (~5% premium post 2024 duty cut).
    // This is closer to actual IBJA than the old 9% estimate.
    // Labelled "calculated" so frontend shows CALC badge.
    if (!ibja24k) {
      const dutyAdj = calc24k * 1.05;
      setIBJA(dutyAdj, "calculated");
      console.log(`IBJA fallback = calc24k×1.05 = Rs.${dutyAdj.toFixed(2)}/g`);
    }

    console.log(`=== IBJA FINAL: 999=Rs.${ibja24k?.toFixed(2)}, 916=Rs.${ibja22k?.toFixed(2)}, 995=Rs.${ibja995?.toFixed(2)} [${ibjaSrc}] ===`);

    // =========================================================
    // STEP 5: ETF NAV -> Rs. per gram
    // =========================================================
    // NOTE: All symbols are NSE symbols (Yahoo Finance uses .NS = NSE)
    // SBI Gold ETF is SETFGOLD on NSE; SBIGETS is the old BSE-only symbol.
    const ETF_SYMS = ["GOLDBEES", "SETFGOLD", "HDFCMFGETF", "AXISGOLD", "KOTAKGOLD", "ICICIGOLD"];
    const BSE_CODES = {
      GOLDBEES: "590096", SETFGOLD: "590091", HDFCMFGETF: "590094",
      AXISGOLD: "590102", KOTAKGOLD: "590103", ICICIGOLD: "590100",
    };
    // AMFI name fragments for fallback NAV lookup
    const AMFI_NAMES = {
      GOLDBEES:   "Gold BeES",
      SETFGOLD:   "SBI-ETF Gold",
      HDFCMFGETF: "HDFC Gold ETF",
      AXISGOLD:   "Axis Gold ETF",
      KOTAKGOLD:  "Kotak Gold ETF",
      ICICIGOLD:  "ICICI Prudential Gold ETF",
    };

    async function fetchETFIndividual(sym) {
      // S1: Yahoo Finance v8 (5d range more reliable than 1d for intraday)
      for (const host of ["query1", "query2"]) {
        for (const range of ["1d", "5d"]) {
          try {
            const r = await tout(fetch(
              `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1d&range=${range}`,
              { headers: { "User-Agent": UA, "Accept": "application/json" } }
            ));
            if (r.ok) {
              const d = await r.json(), m = d?.chart?.result?.[0]?.meta;
              if (m?.regularMarketPrice > 0)
                return { nav: m.regularMarketPrice, prevClose: m.chartPreviousClose || m.previousClose || null };
            }
          } catch (_) {}
        }
      }
      // S2: Yahoo Finance v7 quoteSummary
      for (const host of ["query1", "query2"]) {
        try {
          const r = await tout(fetch(
            `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${sym}.NS`,
            { headers: { "User-Agent": UA, "Accept": "application/json" } }
          ));
          if (r.ok) {
            const d = await r.json();
            const q = d?.quoteResponse?.result?.[0];
            if (q?.regularMarketPrice > 0)
              return { nav: q.regularMarketPrice, prevClose: q.regularMarketPreviousClose || null };
          }
        } catch (_) {}
      }
      // S3: BSE API (multiple field name variants)
      try {
        const r = await tout(fetch(
          `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${BSE_CODES[sym]}&seriesid=`,
          { headers: { Referer: "https://www.bseindia.com/", "User-Agent": UA, "Accept": "application/json" } }
        ));
        if (r.ok) {
          const d = await r.json();
          const ltp  = parseFloat(d?.CurrRate || d?.Ltp || d?.LastRate || d?.currentValue || d?.LTP || d?.price || 0);
          const prev = parseFloat(d?.PrevClose || d?.PrevRate || d?.previousClose || d?.PrevClosing || 0);
          if (ltp > 10) return { nav: ltp, prevClose: prev || null };
        }
      } catch (_) {}
      // S4: BSE India market data endpoint
      try {
        const r = await tout(fetch(
          `https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w?scripcode=${BSE_CODES[sym]}&seriesid=&flag=0`,
          { headers: { Referer: "https://www.bseindia.com/", "User-Agent": UA } }
        ));
        if (r.ok) {
          const d = await r.json();
          const ltp = parseFloat(d?.CurrRate || d?.close || d?.LTP || 0);
          if (ltp > 10) return { nav: ltp, prevClose: null };
        }
      } catch (_) {}
      // S5: MoneyControl price feed
      try {
        const r = await tout(fetch(
          `https://priceapi.moneycontrol.com/pricefeed/nse/equityCash/${sym}`,
          { headers: { "User-Agent": UA, "Referer": "https://www.moneycontrol.com/" } }
        ));
        if (r.ok) {
          const d = await r.json();
          const ltp = parseFloat(d?.data?.pricecurrent || d?.data?.price || 0);
          if (ltp > 10) return { nav: ltp, prevClose: parseFloat(d?.data?.previousclose || 0) || null };
        }
      } catch (_) {}
      // S6: AMFI India official NAV (T-1 close, but reliable — better than no data)
      try {
        const r = await tout(fetch("https://www.amfiindia.com/spages/NAVAll.txt", { headers: { "User-Agent": UA } }), 12000);
        if (r.ok) {
          const txt = await r.text();
          const term = AMFI_NAMES[sym];
          if (term) {
            const line = txt.split("\n").find(l => l.includes(term) && l.includes(";"));
            if (line) {
              const parts = line.split(";");
              const nav = parseFloat(parts[4]);
              if (nav > 10) return { nav, prevClose: null };
            }
          }
        }
      } catch (_) {}
      return { nav: null, prevClose: null };
    }

    // First try bulk Yahoo v7 fetch (gets all 6 in one request — most efficient)
    const etfRaw = {}, etfPrevRaw = {};
    try {
      const symbols = ETF_SYMS.map(s => s + ".NS").join(",");
      for (const host of ["query1", "query2"]) {
        try {
          const r = await tout(fetch(
            `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`,
            { headers: { "User-Agent": UA, "Accept": "application/json" } }
          ), 10000);
          if (r.ok) {
            const d = await r.json();
            const quotes = d?.quoteResponse?.result || [];
            for (const q of quotes) {
              const sym = q.symbol?.replace(".NS", "");
              if (sym && ETF_SYMS.includes(sym) && q.regularMarketPrice > 0) {
                etfRaw[sym] = q.regularMarketPrice;
                if (q.regularMarketPreviousClose > 0) etfPrevRaw[sym] = q.regularMarketPreviousClose;
              }
            }
            if (Object.keys(etfRaw).length >= 4) break; // got enough, stop trying other host
          }
        } catch (_) {}
      }
      console.log(`ETF bulk v7: got ${Object.keys(etfRaw).length} symbols`);
    } catch (_) {}

    // Fill any missing ETFs with individual fetches
    const missingSyms = ETF_SYMS.filter(s => !etfRaw[s]);
    if (missingSyms.length > 0) {
      const etfResults = await Promise.allSettled(missingSyms.map(s => tout(fetchETFIndividual(s), 12000)));
      missingSyms.forEach((sym, i) => {
        const res = etfResults[i];
        if (res.status === "fulfilled" && res.value?.nav > 0) {
          etfRaw[sym] = res.value.nav;
          if (res.value.prevClose) etfPrevRaw[sym] = res.value.prevClose;
        }
      });
    }
    console.log(`ETF raw NAVs (${Object.keys(etfRaw).length}/${ETF_SYMS.length}):`, Object.entries(etfRaw).map(([k,v])=>`${k}:${v}`).join(", ") || "none");

    // Convert ETF unit price -> Rs./gram using ibja24k as gold reference.
    // gramsPerUnit = etfUnitPrice / ibja24k (dynamic, self-correcting after splits)
    const etfNavs = {}, etfPrevClose = {};
    ETF_SYMS.forEach(s => {
      if (etfRaw[s] > 0 && ibja24k > 0) {
        const gramsPerUnit = etfRaw[s] / ibja24k;
        etfNavs[s]    = etfRaw[s]    / gramsPerUnit;   // ≈ ibja24k with tracking error
        if (etfPrevRaw[s]) etfPrevClose[s] = etfPrevRaw[s] / gramsPerUnit;
      }
    });
    console.log("ETF Rs./g:", Object.entries(etfNavs).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(", ") || "none");

    // =========================================================
    // STEP 6: ETF Sparklines (for the ETF 52-week chart panel)
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
    // STEP 6b: Digital gold live buy prices
    // Tries multiple endpoint patterns per platform.
    // Returns per-gram buy price (already includes platform spread + 3% GST).
    // Falls back to ibja24k × spread × 1.03 if all live fetches fail.
    // =========================================================
    async function fetchDigitalGoldPrices(base) {
      const live = {};

      // ---- MMTC-PAMP ----
      // Try internal JSON endpoints their app / website uses
      for (const url of [
        "https://www.mmtcpamp.com/service/api/v1/digitalGoldPrice",
        "https://www.mmtcpamp.com/fetchCurrentPrice",
        "https://www.mmtcpamp.com/service/goldprice",
        "https://www.mmtcpamp.com/api/v1/price",
        "https://www.mmtcpamp.com/goldprice",
      ]) {
        try {
          const r = await tout(fetch(url, {
            headers: { "User-Agent": UA, "Referer": "https://www.mmtcpamp.com/", "Accept": "application/json" }
          }), 6000);
          if (!r.ok) continue;
          const ct = r.headers.get("content-type") || "";
          if (!ct.includes("json")) continue;
          const d = await r.json();
          const v = parseFloat(
            d?.buyPrice || d?.buy_price || d?.goldBuyPrice || d?.buy ||
            d?.data?.buyPrice || d?.data?.goldBuyPrice || d?.price || 0
          );
          if (v > 5000 && v < 30000) { live.mmtcPamp = v; break; }
        } catch (_) {}
      }
      // HTML scrape fallback for MMTC-PAMP
      if (!live.mmtcPamp) {
        try {
          const r = await tout(fetch("https://www.mmtcpamp.com/gold-silver-rate-today", {
            headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://www.google.com/" }
          }), 8000);
          if (r.ok) {
            const html = await r.text();
            const m = html.match(/(?:buy|purchase)\s*(?:price|rate)?[^₹\d]{0,40}[₹]?\s*([\d,]{4,6})/i);
            if (m) { const v = parseFloat(m[1].replace(/,/g,"")); if (v > 5000 && v < 30000) live.mmtcPamp = v; }
          }
        } catch (_) {}
      }

      // ---- AUGMONT ----
      for (const url of [
        "https://spot.augmont.com/liverates",
        "https://www.augmont.com/api/v1/live_rates",
        "https://api.augmont.com/api/v1/liveRates",
        "https://www.augmont.com/api/goldrate",
        "https://business.augmont.com/api/live-rates",
      ]) {
        try {
          const r = await tout(fetch(url, {
            headers: { "User-Agent": UA, "Referer": "https://www.augmont.com/", "Accept": "application/json" }
          }), 6000);
          if (!r.ok) continue;
          const ct = r.headers.get("content-type") || "";
          if (!ct.includes("json")) continue;
          const d = await r.json();
          const v = parseFloat(
            d?.goldBuyPrice || d?.buyPrice || d?.buy_price || d?.buy ||
            d?.data?.goldBuyPrice || d?.data?.buyPrice ||
            d?.rates?.gold?.buy || d?.gold?.buy || 0
          );
          if (v > 5000 && v < 30000) { live.augmont = v; break; }
        } catch (_) {}
      }
      // HTML scrape fallback for Augmont
      if (!live.augmont) {
        try {
          const r = await tout(fetch("https://www.augmont.com/gold-rate-today", {
            headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://www.google.com/" }
          }), 8000);
          if (r.ok) {
            const html = await r.text();
            const m = html.match(/(?:buy|purchase)[^₹\d]{0,50}[₹]?\s*([\d,]{4,6})/i);
            if (m) { const v = parseFloat(m[1].replace(/,/g,"")); if (v > 5000 && v < 30000) live.augmont = v; }
          }
        } catch (_) {}
      }

      // ---- SAFEGOLD ----
      for (const url of [
        "https://www.safegold.com/goldrate",
        "https://app.safegold.com/api/v1/price",
        "https://www.safegold.com/api/gold-price",
        "https://www.safegold.com/api/v1/gold/price",
        "https://api.safegold.com/v1/price",
      ]) {
        try {
          const r = await tout(fetch(url, {
            headers: { "User-Agent": UA, "Referer": "https://www.safegold.com/", "Accept": "application/json" }
          }), 6000);
          if (!r.ok) continue;
          const ct = r.headers.get("content-type") || "";
          if (!ct.includes("json")) continue;
          const d = await r.json();
          const v = parseFloat(
            d?.buyPrice || d?.buy || d?.price || d?.goldBuyPrice ||
            d?.data?.buyPrice || d?.data?.price || 0
          );
          if (v > 5000 && v < 30000) { live.safegold = v; break; }
        } catch (_) {}
      }
      // HTML scrape fallback for SafeGold
      if (!live.safegold) {
        try {
          const r = await tout(fetch("https://www.safegold.com/gold-rate", {
            headers: { "User-Agent": UA, "Accept": "text/html", "Referer": "https://www.google.com/" }
          }), 8000);
          if (r.ok) {
            const html = await r.text();
            const m = html.match(/(?:buy|purchase)[^₹\d]{0,50}[₹]?\s*([\d,]{4,6})/i);
            if (m) { const v = parseFloat(m[1].replace(/,/g,"")); if (v > 5000 && v < 30000) live.safegold = v; }
          }
        } catch (_) {}
      }

      // Paytm Gold uses MMTC-PAMP backend + ~1% extra spread
      if (live.mmtcPamp) live.paytm = Math.round(live.mmtcPamp * 1.01 * 100) / 100;

      // Formula fallbacks for any that failed (ibja × spread × 1.03 GST)
      if (!live.mmtcPamp) live.mmtcPamp = null;   // frontend will use formula
      if (!live.augmont)  live.augmont  = null;
      if (!live.safegold) live.safegold = null;
      if (!live.paytm)    live.paytm    = null;

      const gotLive = Object.values(live).filter(Boolean).length;
      console.log(`Digital gold live: ${gotLive}/4 fetched —`,
        Object.entries(live).filter(([,v])=>v).map(([k,v])=>`${k}:₹${v.toFixed(0)}`).join(", ") || "all formula"
      );
      return live;
    }

    const digitalGoldPrices = await fetchDigitalGoldPrices(ibja24k);

    // =========================================================
    // STEP 7: Gold price history -> Rs./gram (hero history panel)
    // Uses XAU/USD spot/futures converted to Rs./gram via USD/INR.
    // =========================================================
    async function fetchMetalHist(range, iv, syms) {
      for (const sym of syms) {
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

    const goldSyms   = ["GC%3DF",  "XAUUSD%3DX"];
    const silverSyms = ["SI%3DF",  "XAGUSD%3DX"];

    const [ghResults, shResults] = await Promise.all([
      Promise.allSettled(RANGES.map(({ range, iv }) => fetchMetalHist(range, iv, goldSyms))),
      Promise.allSettled(RANGES.map(({ range, iv }) => fetchMetalHist(range, iv, silverSyms))),
    ]);

    const goldHistory = {}, silverHistory = {};
    ghResults.forEach((r, i) => { if (r.status === "fulfilled" && r.value?.length >= 2) goldHistory[RANGES[i].key] = r.value; });
    shResults.forEach((r, i) => { if (r.status === "fulfilled" && r.value?.length >= 2) silverHistory[RANGES[i].key] = r.value; });

    console.log("goldHistory keys:",   Object.keys(goldHistory).join(", ")   || "none");
    console.log("silverHistory keys:", Object.keys(silverHistory).join(", ") || "none");

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
      etfNavRaw:      { ...etfRaw },   // raw unit NAV price (Rs./unit) for grams-per-unit calc
      etfPrevClose,
      etfSparklines,
      digitalGoldPrices,               // { mmtcPamp, augmont, safegold, paytm } — null = use formula
      goldHistory,
      silverHistory,
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
