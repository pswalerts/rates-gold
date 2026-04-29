let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

export default async function handler(req, res) {
  try {
    // Return cached data if still fresh
    if (cache && Date.now() - cacheTime < CACHE_DURATION) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=900");
      return res.status(200).json({ ...cache, cached: true });
    }

    const GOLD_API_KEY = process.env.GOLD_API_KEY;
    const METAL_PRICE_API_KEY = process.env.METAL_PRICE_API_KEY;

    // ── Step 1: Get USD/INR from multiple sources ──
    let usdInr = null;

    // Source 1: exchangerate.host (reliable, free)
    try {
      const fx1 = await fetch("https://api.exchangerate.host/live?access_key=free&currencies=INR&source=USD");
      if (fx1.ok) {
        const d = await fx1.json();
        const rate = d?.quotes?.USDINR;
        if (rate && rate > 80 && rate < 110) { usdInr = rate; console.log("USD/INR source1:", usdInr); }
      }
    } catch(e) {}

    // Source 2: open.er-api.com
    if (!usdInr) {
      try {
        const fx2 = await fetch("https://open.er-api.com/v6/latest/USD");
        if (fx2.ok) {
          const d = await fx2.json();
          const rate = d?.rates?.INR;
          if (rate && rate > 80 && rate < 110) { usdInr = rate; console.log("USD/INR source2:", usdInr); }
        }
      } catch(e) {}
    }

    // Source 3: frankfurter
    if (!usdInr) {
      try {
        const fx3 = await fetch("https://api.frankfurter.app/latest?from=USD&to=INR");
        if (fx3.ok) {
          const d = await fx3.json();
          const rate = d?.rates?.INR;
          if (rate && rate > 80 && rate < 110) { usdInr = rate; console.log("USD/INR source3:", usdInr); }
        }
      } catch(e) {}
    }

    // Hardcoded fallback — updated to current rate
    if (!usdInr) { usdInr = 84.5; console.log("USD/INR fallback:", usdInr); }

    // ── Step 2: Get XAU/USD gold price ──
    let goldPriceUSD = null;

    // Try goldapi.io first
    try {
      const goldRes = await fetch("https://www.goldapi.io/api/XAU/USD", {
        headers: { "x-access-token": GOLD_API_KEY }
      });
      if (goldRes.ok) {
        const d = await goldRes.json();
        goldPriceUSD = d.price;
        console.log("Gold USD from goldapi.io:", goldPriceUSD);
      }
    } catch(e) {}

    // Fallback to metalpriceapi.com
    if (!goldPriceUSD) {
      try {
        const metalRes = await fetch(
          `https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`
        );
        if (metalRes.ok) {
          const d = await metalRes.json();
          goldPriceUSD = d.rates.USD;
          console.log("Gold USD from metalpriceapi:", goldPriceUSD);
        }
      } catch(e) {}
    }

    if (!goldPriceUSD) throw new Error("All gold price sources failed");

    // ── Step 3: Try IBJA for direct INR rate ──
    let ibja24k = null;
    let ibja22k = null;
    let ibja995 = null;
    try {
      const ibjaRes = await fetch("https://ibjarates.com/api/goldrates", {
        headers: { "Accept": "application/json" }
      });
      if (ibjaRes.ok) {
        const ibjaData = await ibjaRes.json();
        // IBJA returns rates per 10 grams
        ibja24k = ibjaData?.Gold999 ? ibjaData.Gold999 / 10 : null;
        ibja22k = ibjaData?.Gold916 ? ibjaData.Gold916 / 10 : null;
        ibja995 = ibjaData?.Gold995 ? ibjaData.Gold995 / 10 : null;
        console.log("IBJA 24K per gram:", ibja24k);
      }
    } catch(e) {
      console.log("IBJA API error:", e.message);
    }

    // ── Step 4: Get silver price ──
    let silverUSD = null;
    try {
      const silverRes = await fetch("https://www.goldapi.io/api/XAG/USD", {
        headers: { "x-access-token": GOLD_API_KEY }
      });
      if (silverRes.ok) {
        const d = await silverRes.json();
        silverUSD = d.price;
      }
    } catch(e) {}
    if (!silverUSD) silverUSD = goldPriceUSD / 80;

    cache = {
      price: goldPriceUSD,
      usdInr: usdInr,
      silverPrice: silverUSD,
      ibja24k: ibja24k,
      ibja22k: ibja22k,
      ibja995: ibja995,
      timestamp: new Date().toISOString()
    };
    cacheTime = Date.now();

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=900");
    res.status(200).json(cache);

  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
}
