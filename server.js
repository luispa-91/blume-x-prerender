// server.js
// Node 20+; "type": "module" in package.json

import express from "express";
import { LRUCache } from "lru-cache";
import puppeteer from "puppeteer";
import dns from "node:dns";
import net from "node:net";

// ---------- Config (env) ----------
const PORT = process.env.PORT || 8080;

// Rendering & caching
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || "20000", 10); // 20s
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || "300000", 10);         // 5m
const MAX_CACHE_ITEMS = parseInt(process.env.MAX_CACHE_ITEMS || "500", 10);

// Auth
const SECRET = process.env.RENDER_SECRET || "";

// Optional: restrict which hosts can be rendered (CSV, supports wildcards like *.example.com)
const ALLOW_HOSTS = (process.env.ALLOW_HOSTS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// SSRF guard (deny private/loopback IPs resolved from target host)
const DENY_PRIVATE_IPS = (process.env.DENY_PRIVATE_IPS || "true").toLowerCase() !== "false";

// Optional: block extra resource types to speed up (comma-separated)
const BLOCKED_RESOURCE_TYPES = new Set(
  (process.env.BLOCKED_RESOURCE_TYPES || "image,media,eventsource,websocket,manifest").split(",").map(s => s.trim())
);

// Optional: override UA
const USER_AGENT = process.env.USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";

// ---------- Cache ----------
const cache = new LRUCache({
  max: MAX_CACHE_ITEMS,
  ttl: CACHE_TTL_MS,
});

// ---------- Helpers ----------
function isAbsoluteHttpUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch {
    return false;
  }
}

function wildcardMatch(host, pattern) {
  if (!pattern.includes("*")) return host.toLowerCase() === pattern.toLowerCase();
  const esc = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace("\\*", ".*");
  return new RegExp(`^${esc}$`, "i").test(host);
}

function hostAllowed(host) {
  if (ALLOW_HOSTS.length === 0) return true; // allow all if no allowlist configured
  return ALLOW_HOSTS.some(p => wildcardMatch(host, p));
}

async function validateResolvablePublic(host) {
  if (!DENY_PRIVATE_IPS) return;
  const addrs = await new Promise((res, rej) =>
    dns.lookup(host, { all: true }, (e, a) => (e ? rej(e) : res(a)))
  );
  for (const a of addrs) {
    const ip = a.address;
    if (!net.isIP(ip)) continue;

    // RFC1918, loopback, link-local, etc.
    const isPrivate =
      ip.startsWith("10.") ||
      ip.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip.startsWith("169.254.") ||
      ip.startsWith("fe80:");

    if (isPrivate) throw new Error("private ip blocked");
  }
}

// Accept both /render?url=... and /render/https://...
function extractTargetUrl(req) {
  // 1) query string
  const q = req.query.url;
  if (typeof q === "string" && q) return q;

  // 2) path-style: /render/<absolute-url> (possibly URI-encoded)
  // examples:
  //   /render/https://example.com/page
  //   /render/https%3A%2F%2Fexample.com%2Fpage
  const path = req.path || "";
  const m = path.match(/^\/render\/(.+)$/i);
  if (m && m[1]) {
    try {
      const decoded = decodeURIComponent(m[1]);
      return decoded;
    } catch {
      return m[1]; // if not encoded, return raw
    }
  }

  return "";
}

// ---------- Puppeteer ----------
let browserPromise;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
      ],
    });
  }
  return browserPromise;
}

// ---------- Core render ----------
async function renderUrl(targetUrl) {
  const fromCache = cache.get(targetUrl);
  if (fromCache) return fromCache;

  const browser = await getBrowser();
  const page = await browser.newPage();

  await page.setUserAgent(USER_AGENT);

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(type)) {
      return req.abort();
    }
    req.continue();
  });

  let html;
  try {
    // Start navigation
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });

    // Angular presence (non-fatal if it times out)
    await page.waitForSelector("app-root, [ng-version], app", { timeout: 8000 }).catch(() => {});

    // Nudge lazy observers
    await page.evaluate(async () => {
      window.scrollTo(0, 1);
      await new Promise(r => setTimeout(r, 50));
      window.scrollTo(0, 0);
    });

    // Heuristic "content is here"
    await page.waitForFunction(() => {
      const titleOk = (document.title || "").trim().length > 0;
      const metaDescOk = !!document.querySelector('meta[name="description"][content]');
      const blocksOk = document.querySelectorAll(".blocks-container > *").length > 0;
      const textLen = document.body.innerText.replace(/\s+/g, " ").trim().length;
      const textOk = textLen > 500;
      return titleOk || metaDescOk || blocksOk || textOk || (window.__PRERENDER_READY__ === true);
    }, { timeout: 12000 }).catch(() => {});

    // Small settle
    await new Promise(res => setTimeout(res, 200));

    // Inject <base href> so previews don’t spam the render host for assets
    const origin = new URL(targetUrl).origin;
    await page.evaluate((originStr) => {
      const ensureSlash = (u) => u.endsWith("/") ? u : u + "/";
      let base = document.querySelector("base");
      if (!base) {
        base = document.createElement("base");
        document.head.prepend(base);
      }
      base.setAttribute("href", ensureSlash(originStr));
    }, origin);

    // Strip scripts and preload/prefetch to keep crawlers happy
    await page.evaluate(() => {
      [...document.querySelectorAll("script")].forEach(s => s.remove());
      [...document.querySelectorAll('link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]')].forEach(l => l.remove());
    });

    html = await page.content();
    cache.set(targetUrl, html);
  } finally {
    await page.close().catch(() => {});
  }

  return html;
}

// ---------- Express App ----------
const app = express();

// Health
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// Render endpoints (support both styles)
app.get(/^\/render(\/.*)?$/i, async (req, res) => {
  // Auth
  if (!SECRET || req.headers["x-render-secret"] !== SECRET) {
    return res.status(401).send("unauthorized");
  }

  // Input
  const targetUrl = extractTargetUrl(req);
  if (!isAbsoluteHttpUrl(targetUrl)) {
    return res.status(400).send("bad request: url must be absolute http(s) via ?url= or /render/<url>");
  }

  try {
    const { host } = new URL(targetUrl);
    if (!hostAllowed(host)) return res.status(403).send("forbidden: host not allowed");
    await validateResolvablePublic(host);

    const html = await renderUrl(targetUrl);

    // Cache hint for CDNs
    res.set("Cache-Control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);

    // Optional: quiet asset requests when humans open the HTML in a browser
    // res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline' https:; img-src 'none';");

    res.type("html").send(html);
  } catch (e) {
    console.error("Render error:", e);
    res.status(500).send(`Render error: ${e.message || e}`);
  }
});

// Everything else: not served here
app.use((req, res) => res.status(404).end());

app.listen(PORT, () => {
  console.log(`Puppeteer prerender listening on :${PORT}`);
});
