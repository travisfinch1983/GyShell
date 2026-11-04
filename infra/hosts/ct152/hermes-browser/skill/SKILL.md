---
name: web-browser
description: Use when a page needs a real browser (bot-blocked sites, logins, forms, screenshots, JavaScript-heavy pages) or when web_extract came back empty or blocked.
---

# Your web browser

You have your own Chromium browser through the `browser_*` tools (server `browser-<your id>`).
It is a real, visible browser with its own saved profile: cookies, logins and open tabs persist
between conversations and are never shared with other agents.

## When to use it (and when not to)

- **Try `web_extract` / `web_search` first** for plain articles and docs: faster and cheaper.
- **Use the browser when** a site blocks bots (eBay, many shops, Cloudflare-protected pages),
  needs JavaScript, needs you to click, type, log in or fill a form, or when you need to SEE the
  page (`browser_take_screenshot`).
- It cannot reach the home LAN (10.x / 192.168.x addresses are refused by design). Use your
  normal tools for lab services.

## How to work it

1. `browser_navigate` to the URL, then check the page title it reports matches what you wanted.
   A page loading is not proof it is the right page.
2. **Extract with `browser_evaluate`, not by reading `browser_snapshot`.** One small JavaScript
   function that returns just the fields you need, for example:
   `() => [...document.querySelectorAll('.item')].slice(0,50).map(e => ({t: e.querySelector('.title')?.innerText, p: e.querySelector('.price')?.innerText}))`
   One call returned 62 eBay listings this way; a snapshot of the same page is huge.
3. Use `browser_snapshot` when you need element refs to click or type into.
4. **`browser_take_screenshot` needs `scale` every time**: pass `scale: "css"`. Leaving it out is
   rejected even though the docs say it has a default.
5. Close tabs you no longer need (`browser_tabs`), and don't leave long-running pages open.

## Site recipes

- **eBay: never open a search URL directly.** `https://www.ebay.com/sch/i.html?_nkw=...` returns
  "SORRY - Something went wrong" on a cold hit. Open `https://www.ebay.com` first, type the query
  into the search box (`#gh-ac`) and press Enter; the real results page then loads. Prices and
  shipping are for a US ship-to (ZIP 85541) unless you change it.
- **Cloudflare "checking your browser" pages:** wait a few seconds (`browser_wait_for`) and look
  again; the browser often passes on its own. If it stays stuck, try
  `https://web.archive.org/web/2026/<url>` for static reference pages (snapshots can be months
  old, so say how old it is) and tell the user the live page is blocked.

## Rules

- Never type passwords, card numbers or other credentials unless the user explicitly asked you
  to log in to that specific site.
- Don't buy, post, send or submit anything on someone's behalf without asking first.
- Report what you found with the source and date, and say plainly when a page was blocked.
