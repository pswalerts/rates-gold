let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 15 * 60 * 1000;

export default async function handler(req, res) {
  try {
    if (cache && Date.now() - cacheTime < CACHE_DURATION) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=900");
      return res.status(200).json({ ...cache, cached: true });
    }
    const GOLD_API_KEY = process.env.GOLD_API_KEY;
    const METAL_PRICE_API_KEY = process.env.METAL_PRICE_API_KEY;
    let goldPrice = null;
    try {
      const goldRes = await fetch("https://www.goldapi.io/api/XAU/USD", {
        headers: { "x-access-token": GOLD_API_KEY }
      });
      if (goldRes.ok) {
        const goldData = await goldRes.json();
        goldPrice = goldData.price;
      }
    } catch (e) {}
    if (!goldPrice) {
      try {
        const metalRes = await fetch(
          `https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`
        );
        if (metalRes.ok) {
          const metalData = await metalRes.json();
          goldPrice = metalData.rates.USD;
        }
      } catch (e) {}
    }
    if (!goldPrice) throw new Error("All gold price sources failed");
    let usdInr = null;
    try {
      const fx1 = await fetch("https://open.er-api.com/v6/latest/USD");
      if (fx1.ok) {
        const fx1Data = await fx1.json();
        const rate = fx1Data?.rates?.INR;
        if (rate && rate > 80 && rate < 110) usdInr = rate;
      }
    } catch (e) {}
    if (!usdInr) {
      try {
        const fx2 = await fetch("https://api.frankfurter.app/latest?from=USD&to=INR");
        if (fx2.ok) {
          const fx2Data = await fx2.json();
          const rate = fx2Data?.rates?.INR;
          if (rate && rate > 80 && rate < 110) usdInr = rate;
        }
      } catch (e) {}
    }
    if (!usdInr) usdInr = 94.5;
    cache = { price: goldPrice, usdInr, timestamp: new Date().toISOString() };
    cacheTime = Date.now();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=900");
    res.status(200).json(cache);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
}
