// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  rateof.gold â€” /api/price
//
//  IBJA rate strategy (scrape-first, no API keys needed):
//
//  S1: ibjarates.com HTML scrape  â€” THE official source, scraped directly
//  S2: goodreturns.in scrape      â€” mirrors IBJA, very reliable
//  S3: bankbazaar.com JSON API    â€” has undocumented public endpoint
//  S4: Yahoo Finance MCX          â€” GOLD.MCX futures (per 10g â†’ Ã·10)
//  S5: Calculated fallback        â€” spot Ã— 1.0865 (last resort)
//
//  KEY BUG FIX: ibjarates.com shows rates per 10 GRAMS in their HTML
//  table (e.g. 148100), and per GRAM in the hero cards (e.g. 14810).
//  We scrape the hero card values (per gram) to avoid Ã·10 errors.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

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

    // Randomise UA slightly to avoid trivial bot detection
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    function tout(p, ms = 8000) {
      return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // STEP 1: USD / INR
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
    else          { console.log(`USD/INR: ${usdInr.toFixed(4)} (live)`); }

    const aedInr = usdInr / 3.6725;

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // STEP 2: XAU / USD
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
    console.log(`XAU/USD $${goldUSD.toFixed(2)} [${goldSrc}] | USD/INR ${usdInr.toFixed(2)} | calc24k â‚¹${calc24k.toFixed(2)}/g`);

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // STEP 3: XAG / USD
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    let silverUSD = null;
    try { const r = await tout(fetch("https://data-asg.goldprice.org/dbXRates/USD", { headers: { Origin: "https://goldprice.org", Referer: "https://goldprice.org/" } })); if (r.ok) { const d = await r.json(); const v = d?.items?.[0]?.xagPrice; if (v > 0) silverUSD = v; } } catch (_) {}
    try { if (!silverUSD) { const r = await tout(fetch("https://gold-api.com/price/XAG")); if (r.ok) { const d = await r.json(); if (d?.price > 0) silverUSD = d.price; } } } catch (_) {}
    try { if (!silverUSD) { const r = await tout(fetch("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=1d", { headers: { "User-Agent": UA } })); if (r.ok) { const d = await r.json(); const v = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (v > 0) silverUSD = v; } } } catch (_) {}
    if (!silverUSD) silverUSD = goldUSD / 85;

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // STEP 4: IBJA India gold rate (â‚¹/gram, 999 purity)
    //
    //  IMPORTANT: ibjarates.com shows two sets of numbers:
    //  - Hero cards at top of page: â‚¹/gram (e.g. 14810) â† we want these
    //  - Historical table:          â‚¹/10g  (e.g. 148100) â† divide by 10
    //
    //  ibjaOk: sanity check â€” â‚¹7,000â€“â‚¹25,000/gram covers all realistic
    //  gold prices for the foreseeable future.
    //
    //  Sources:
    //  S1: ibjarates.com     â€” direct HTML scrape of official source
    //  S2: goodreturns.in    â€” reliable IBJA mirror with JSON endpoint
    //  S3: bankbazaar.com    â€” has undocumented public JSON for gold rates
    //  S4: Yahoo MCX GOLD.MCX â€” futures price per 10g, divide by 10
    //  S5: Calculated        â€” spot Ã— 1.0865 (last resort, labelled CALC)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    let ibja24k = null, ibja22k = null, ibja995 = null, ibjaSrc = "?";

    const ibjaOk = v => { const n = parseFloat(v); return n > 7000 && n < 25000; };

    const setIBJA = (v24, src, v22 = null, v995 = null) => {
      ibja24k = parseFloat(v24);
      ibja22k = v22  ? parseFloat(v22)  : ibja24k * 0.916;
      ibja995 = v995 ? parseFloat(v995) : ibja24k * 0.995;
      ibjaSrc = src;
      console.log(`IBJA [${src}]: 999=â‚¹${ibja24k.toFixed(2)}, 916=â‚¹${ibja22k.toFixed(2)}, 995=â‚¹${ibja995.toFixed(2)}`);
    };

    // â”€â”€ S1: ibjarates.com direct HTML scrape â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //
    //  The page shows gold rates in CARDS at the top in this format:
    //  <h3>14810 (1 Gram)</h3>  â† for 999 purity
    //
    //  We parse these h3 tags. The order on the page is always:
    //  999, 995, 916, 750, 585
    //
    //  We also try the historical table as a fallback (per 10g â†’ Ã·10)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://ibjarates.com", {
          headers: {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-IN,en;q=0.9",
            "Referer": "https://www.google.com/",
          }
        }), 10000);

        if (r.ok) {
          const html = await r.text();
          console.log("ibjarates.com HTML length:", html.length);

          // Strategy A: parse hero card <h3>NNNNN (1 Gram)</h3>
          // The page has one h3 per purity in order: 999, 995, 916, 750, 585
          const h3Matches = [...html.matchAll(/<h3[^>]*>\s*([\d,]+)\s*\(1\s*Gram\)\s*<\/h3>/gi)];
          console.log("ibjarates h3 matches:", h3Matches.map(m => m[1]));

          if (h3Matches.length >= 3) {
            const v999 = parseFloat(h3Matches[0][1].replace(/,/g, ""));
            const v995 = parseFloat(h3Matches[1][1].replace(/,/g, ""));
            const v916 = parseFloat(h3Matches[2][1].replace(/,/g, ""));
            console.log(`ibjarates hero cards: 999=${v999}, 995=${v995}, 916=${v916}`);
            if (ibjaOk(v999)) {
              setIBJA(v999, "ibjarates.com-hero", v916, v995);
            }
          }

          // Strategy B: parse historical table (per 10g, divide by 10)
          // Rows look like: <td>04/05/2026</td><td>148100</td><td>147507</td>...
          if (!ibja24k) {
            const tableMatch = html.match(/<td>\s*(\d{2}\/\d{2}\/\d{4})\s*<\/td>\s*<td>\s*([\d]+)\s*<\/td>\s*<td>\s*([\d]+)\s*<\/td>\s*<td>\s*([\d]+)\s*<\/td>/);
            if (tableMatch) {
              const v999 = parseFloat(tableMatch[2]) / 10;
              const v995 = parseFloat(tableMatch[3]) / 10;
              const v916 = parseFloat(tableMatch[4]) / 10;
              console.log(`ibjarates table (Ã·10): 999=${v999}, 995=${v995}, 916=${v916}`);
              if (ibjaOk(v999)) {
                setIBJA(v999, "ibjarates.com-table", v916, v995);
              }
            }
          }

          // Strategy C: any 5-digit number followed by common per-gram context
          if (!ibja24k) {
            const anyMatch = html.match(/(\d{4,6})\s*\(1\s*Gram\)/i);
            if (anyMatch) {
              const raw = parseFloat(anyMatch[1]);
              // Could be per gram (14810) or per 10g (148100)
              const v = raw > 50000 ? raw / 10 : raw;
              console.log(`ibjarates fallback context match: raw=${raw} -> ${v}/g`);
              if (ibjaOk(v)) setIBJA(v, "ibjarates.com-ctx");
            }
          }
        } else {
          console.log("ibjarates.com HTTP", r.status);
        }
      } catch (e) { console.log("ibjarates.com error:", e.message); }
    }

    // â”€â”€ S2: goodreturns.in â€” IBJA mirror, very reliable â”€â”€â”€â”€â”€â”€
    //
    //  goodreturns publishes the IBJA AM rate daily. Their page
    //  has gold rate in structured data / meta tags AND inline text.
    //
    //  Endpoint: https://www.goodreturns.in/gold-rates/
    //  Also try their commodity JSON:
    //  https://www.goodreturns.in/gold-rates/gold-rate-today.json  (if exists)
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!ibja24k) {
      try {
        const r = await tout(fetch("https://www.goodreturns.in/gold-rates/", {
          headers: {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": "https://www.google.com/",
          }
        }), 10000);
        if (r.ok) {
          const html = await r.text();
          console.log("goodreturns.in HTML length:", html.length);

          // Look for JSON-LD structured data with gold price
          const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
          if (jsonLdMatch) {
            for (const block of jsonLdMatch) {
              try {
                const obj = JSON.parse(block.replace(/<[^>]+>/g, "").trim());
                const price = obj?.offers?.price || obj?.price;
                if (price && ibjaOk(price)) {
                  setIBJA(price, "goodreturns-jsonld");
                  break;
                }
              } catch (_) {}
            }
          }

          // Look for "24 Karat" / "999" price in the HTML
          // goodreturns shows: â‚¹7,405 per gram or â‚¹14,810 per gram
          if (!ibja24k) {
            // Match patterns like: 14,810 or 14810 near "24 Karat" or "999"
            const patterns = [
              /24\s*[Kk]arat[\s\S]{0,200}?(?:â‚¹|Rs\.?)\s*([\d,]+)/,
              /999\s*purity[\s\S]{0,200}?(?:â‚¹|Rs\.?)\s*([\d,]+)/,
              /(?:â‚¹|Rs\.?)\s*([\d,]+)\s*(?:per gram|\/gram)/i,
              // goodreturns specific: their rate table format
              /gold-rate-today[\s\S]{0,50}?([\d,]{5,7})/,
            ];
            for (const pat of patterns) {
              const m = html.match(pat);
              if (m) {
                const raw = parseFloat(m[1].replace(/,/g, ""));
                const v = raw > 50000 ? raw / 10 : raw;
                console.log(`goodreturns pattern match: raw=${m[1]} -> ${v}/g`);
                if (ibjaOk(v)) { setIBJA(v, "goodreturns-html"); break; }
              }
            }
          }
        } else {
          console.log("goodreturns.in HTTP", r.status);
        }
      } catch (e) { console.log("goodreturns.in error:", e.message); }
    }

    // â”€â”€ S3: bankbazaar.com undocumented endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //
    //  BankBazaar has a public (no-auth) endpoint that returns
    //  today's gold price in JSON. They publish IBJA-sourced rates.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!ibja24k) {
      const bbEndpoints = [
        "https://www.bankbazaar.com/gold-rate.html",
        "https://www.bankbazaar.com/api/gold-rate-today",
      ];
      for (const url of bbEndpoints) {
        if (ibja24k) break;
        try {
          const r = await tout(fetch(url, {
            headers: { "User-Agent": UA, "Referer": "https://www.bankbazaar.com/" }
          }), 8000);
          if (r.ok) {
            const text = await r.text();
            // Try JSON parse first
            try {
              const d = JSON.parse(text);
              const price = d?.goldRate24k || d?.rate24k || d?.gold?.["24k"] || d?.price;
              if (price && ibjaOk(parseFloat(price))) {
                setIBJA(parseFloat(price), "bankbazaar-json"); continue;
              }
            } catch (_) {}
            // HTML parse
            const patterns = [
              /24\s*[Kk][\s\S]{0,100}?([\d,]{5,6})/,
              /(?:â‚¹|Rs\.?)\s*([\d,]{5,6})\s*(?:per gram|\/g)/i,
            ];
            for (const pat of patterns) {
              const m = text.match(pat);
              if (m) {
                const raw = parseFloat(m[1].replace(/,/g, ""));
                const v = raw > 50000 ? raw / 10 : raw;
                if (ibjaOk(v)) { setIBJA(v, "bankbazaar-html"); break; }
              }
            }
          }
        } catch (e) { console.log("bankbazaar error:", e.message); }
      }
    }

    // â”€â”€ S4: Yahoo Finance MCX Spot Gold â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //
    //  GC=F  is USD-denominated COMEX â€” NOT what we want
    //  GOLD.MCX is MCX India gold futures, quoted in â‚¹ per 10g
    //  So: price Ã· 10 = â‚¹/gram
    //
    //  Why this often fails in production:
    //  - Yahoo blocks serverless IPs for .MCX symbols intermittently
    //  - We try both query1 and query2, and GOLDM.MCX as backup
    //
    //  GOLD.MCX  = 100g contract (â‚¹/10g)
    //  GOLDM.MCX = 10g contract  (â‚¹/1g) â€” use directly, no division!
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!ibja24k) {
      const mcxSymbols = [
        { sym: "GOLDM.MCX", divisor: 1  },   // Mini: quoted per gram
        { sym: "GOLD.MCX",  divisor: 10 },   // Main: quoted per 10g
      ];
      outer:
      for (const { sym, divisor } of mcxSymbols) {
        for (const host of ["query1", "query2"]) {
          try {
            const r = await tout(fetch(
              `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
              { headers: { "User-Agent": UA, "Accept": "application/json" } }
            ), 8000);
            if (r.ok) {
              const d = await r.json();
              const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
              console.log(`Yahoo ${host} ${sym}: raw price=${price}, Ã·${divisor}=${price/divisor}`);
              if (price > 0) {
                const v = price / divisor;
                if (ibjaOk(v)) {
                  setIBJA(v, `yahoo-mcx-${sym}`);
                  break outer;
                }
              }
            } else {
              console.log(`Yahoo ${host} ${sym}: HTTP ${r.status}`);
            }
          } catch (e) { console.log(`Yahoo ${host} ${sym}:`, e.message); }
        }
      }
    }

    // â”€â”€ S5: Calculated fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //
    //  India import duty structure (post July 2024 Union Budget):
    //  - Basic Customs Duty: 6%
    //  - Agriculture Cess: 0% (was removed)
    //  - IGST: 3%
    //  - Total effective multiplier: Ã—1.09 (approx)
    //
    //  Note: IBJA rate reflects the actual market price discovered
    //  through spot polling â€” it's not a mechanical formula.
    //  The calculated rate is typically within 0.5â€“1% of IBJA.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!ibja24k) {
      const v = calc24k * 1.09;
      setIBJA(v, "calculated");
      console.log(`IBJA fallback: â‚¹${calc24k.toFixed(2)} Ã— 1.09 = â‚¹${v.toFixed(2)}/g`);
    }

    console.log(`=== IBJA FINAL: 999=â‚¹${ibja24k.toFixed(2)}, 916=â‚¹${ibja22k.toFixed(2)}, 995=â‚¹${ibja995.toFixed(2)} [${ibjaSrc}] ===`);

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // STEP 5: ETF NAV â†’ â‚¹ per gram
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
        etfNavs[s]    = etfRaw[s]     / GRAMS_PER_UNIT;
        if (etfPrevRaw[s]) etfPrevClose[s] = etfPrevRaw[s] / GRAMS_PER_UNIT;
      }
    });
    console.log("ETF â‚¹/g:", Object.entries(etfNavs).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(", ") || "none");

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // STEP 6: ETF Sparklines
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // Build response
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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
