// middleware.js — Vercel Edge Middleware for rate limiting
// No npm imports — uses standard Web API only.
// Place at the ROOT of your project (same level as vercel.json and index.html).

const buckets = new Map();
const WINDOW_MS = 60_000;        // 1 minute
const MAX_PER_WINDOW_API = 60;   // 60 req/min/IP on /api/*
const MAX_PER_WINDOW_PAGE = 200; // 200 req/min/IP on pages

function getClientIp(request) {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}

function checkRateLimit(ip, max) {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
  }
  bucket.count++;
  buckets.set(ip, bucket);

  // Cleanup old entries occasionally
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (now > v.resetAt) buckets.delete(k);
    }
  }

  return {
    allowed: bucket.count <= max,
    remaining: Math.max(0, max - bucket.count),
    resetAt: bucket.resetAt,
  };
}

export default function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const ip = getClientIp(request);

  const isApi = pathname.startsWith('/api/');
  const max = isApi ? MAX_PER_WINDOW_API : MAX_PER_WINDOW_PAGE;
  const limit = checkRateLimit(ip, max);

  if (!limit.allowed) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Please slow down.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil((limit.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': String(max),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(limit.resetAt / 1000)),
        },
      }
    );
  }

  // Allow request through — Vercel handles routing after middleware returns nothing
  return;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)).*)'],
};
