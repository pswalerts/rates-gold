export default async function handler(req, res) {
  try {
    const GOLD_API_KEY = process.env.GOLD_API_KEY;

    const [goldRes, fxRes] = await Promise.all([
      fetch("https://www.goldapi.io/api/XAU/USD", {
        headers: { "x-access-token": GOLD_API_KEY }
      }),
      fetch("https://open.er-api.com/v6/latest/USD")
    ]);

    if (!goldRes.ok) {
      throw new Error(`Gold API error: ${goldRes.status}`);
    }

    const goldData = await goldRes.json();
    const fxData = await fxRes.json();

    const usdInr = fxData?.rates?.INR ?? 84.4;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache");
    res.status(200).json({
      price: goldData.price,
      usdInr: usdInr,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
}
