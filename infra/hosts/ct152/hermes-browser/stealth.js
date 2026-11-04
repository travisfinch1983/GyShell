// Runs before every page script (playwright-mcp --init-script). Removes the automation tells that bot checks look
// at first; it doesn't defeat serious fingerprinting (Cloudflare challenges may still block). claude1 2026-11-04
Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
if (!window.chrome) { window.chrome = { runtime: {} }; }
