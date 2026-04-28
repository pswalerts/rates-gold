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

    let goldPrice = null;

    // Try goldapi.io first
    try {
      const goldRes = await fetch("https://www.goldapi.io/api/XAU/USD", {
        headers: { "x-access-token": GOLD_API_KEY }
      });
      if (goldRes.ok) {
        const goldData = await goldRes.json();
        goldPrice = goldData.price;
        console.log("Gold price from goldapi.io:", goldPrice);
      } else {
        console.log("goldapi.io failed with status:", goldRes.status);
      }
    } catch (e) {
      console.log("goldapi.io error:", e.message);
    }

    // Fallback to metalpriceapi.com if goldapi.io failed
    if (!goldPrice) {
      try {
        const metalRes = await fetch(
          `https://api.metalpriceapi.com/v1/latest?api_key=${METAL_PRICE_API_KEY}&base=XAU&currencies=USD`
        );
        if (metalRes.ok) {
          const metalData = await metalRes.json();
          goldPrice = metalData.rates.USD;
          console.log("Gold price from metalpriceapi.com:", goldPrice);
        } else {
          console.log("metalpriceapi.com failed with status:", metalRes.status);
        }
      } catch (e) {
        console.log("metalpriceapi.com error:", e.message);
      }
    }

    if (!goldPrice) {
      throw new Error("All gold price sources failed");
    }

    // Get USD/INR rate
    const fxRes = await fetch("https://open.er-api.com/v6/latest/USD");
    const fxData = await fxRes.json();
    const usdInr = fxData?.rates?.INR ?? 84.4;

    // Store in cache
    cache = {
      price: goldPrice,
      usdInr: usdInr,
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
