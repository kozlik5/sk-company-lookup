import { Request, Response, NextFunction } from 'express';

const ALLOWED_ORIGINS = [
  // Development
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',

  // Genesis B2B
  'https://genesis-b2b.pages.dev',
  'https://genesis-b2b.com',
  'https://www.genesis-b2b.com',

  // TrustAPI
  'https://genesis-trustapi.fly.dev',
  'https://trust-api.com',
  'https://www.trust-api.com',

  // VoVreci
  'https://app.vovreci.com',
  'https://vovreci.com',
  'https://www.vovreci.com',

  // Add from environment (comma-separated)
  ...(process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()) || [])
].filter(Boolean);

function isAllowedOrigin(origin: string): boolean {
  // Exact match
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // Wildcard subdomains for Cloudflare Pages previews
  try {
    const url = new URL(origin);
    if (url.hostname.endsWith('.genesis-b2b.pages.dev')) return true;
    if (url.hostname.endsWith('.vovreci-on-the-go.pages.dev')) return true;
  } catch {
    // Invalid URL
  }

  // Development - allow any localhost
  if (process.env.NODE_ENV !== 'production') {
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
    } catch {
      // Invalid URL
    }
  }

  return false;
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
