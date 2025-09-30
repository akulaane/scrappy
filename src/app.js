

// app.js
const express = require('express');
const { chromium } = require('playwright');
const bodyParser = require('body-parser');
const base64 = require('base64-js');

const app = express();

/* =========================
   Runtime / Browser setup
   ========================= */
const PORT = process.env.PORT || 8080;
const TZ   = process.env.TZ || 'Europe/Tallinn';

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  //'--disable-gpu',
  //'--single-process',
  //'--no-zygote',
];

let BROWSER = null;
async function getBrowser() {
  if (BROWSER && BROWSER.isConnected()) return BROWSER;
  BROWSER = await chromium.launch({ headless: true, args: CHROME_ARGS });
  return BROWSER;
}
async function newContext() {
  const browser = await getBrowser();

  // 1) Create context (only the options object goes here)
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    timezoneId: TZ,
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9,et;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  // 2) Speed up: block images, fonts, trackers (note: this is OUTSIDE the options object)
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|woff2?|ttf)$/i.test(url)) return route.abort();
    if (url.includes('google-analytics.com') || url.includes('googletagmanager.com') ||
        url.includes('doubleclick.net') || url.includes('hotjar') ||
        url.includes('facebook.net')   || url.includes('segment.com')) return route.abort();
    route.continue();
  });

  // 3) Light stealth
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      const origQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (origQuery) {
        window.navigator.permissions.query = (p) =>
          p && p.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(p);
      }
      if (window.WebGLRenderingContext) {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
          if (param === 37445) return 'Intel Inc.';               // UNMASKED_VENDOR_WEBGL
          if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
          return getParameter.call(this, param);
        };
      }
    } catch {}
  });

  return context;
}


/* =========================
   Express views / demo
   ========================= */
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.render('success', {
    url: 'https://news.ycombinator.com',
    screenshot_base64: '',
    links: [],
    page_title: null,
  });
});

app.post('/', async (req, res) => {
  let url = req.body.url || 'https://news.ycombinator.com';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let context, page;
  try {
    context = await newContext();
    page = await context.newPage();

   // Block images/media/fonts/analytics to speed up
   await page.route('**/*', route => {
   const req = route.request();
   const t = req.resourceType();
  const u = req.url();
  if (t === 'image' || t === 'media' || t === 'font' || u.includes('google-analytics')) {
    return route.abort();
  }
  route.continue();
});

     

    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

    const screenshot = await page.screenshot();
    const page_title = await page.title();

    const links_and_texts = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a');
      return Array.from(anchors).map((a) => ({
        href: a.href,
        text: (a.textContent || '').replace(/<[^>]*>/g, '').trim(),
      }));
    });

    const screenshot_base64 = base64.fromByteArray(screenshot);

    res.render('success', {
      url,
      page_title,
      screenshot_base64,
      links: links_and_texts,
    });
  } catch (e) {
    res.render('error', { error_message: e.message });
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
  }
});

/* =========================
   Health
   ========================= */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    timeUTC: new Date().toISOString(),
    timeLocal: new Date().toLocaleString('en-GB', { timeZone: TZ }),
    tz: TZ,
  });
});

/* =========================
   Small utils
   ========================= */
function normHHMM(s) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(s || ''));
  if (!m) return null;
  const H = String(parseInt(m[1], 10)).padStart(2, '0');
  const M = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${H}:${M}`;
}
function addDaysYMD(ymd, n) {
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  d.setDate(d.getDate() + (n | 0));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* =========================
   Availability (calendar-driven)
   ========================= */
// GET /availability
// Params:
//   slug        = comma-separated club slugs (e.g. "padelikeskus,another-club")
//   date        = YYYY-MM-DD (required)
//   duration    = 60 | 90 | 120 (optional; exact match)
//   earliest    = "HH:MM" (optional; filter by START time >= earliest)
//   latest      = "HH:MM" (optional; filter by START time <= latest)
//   screenshot  = 1 to include per-club screenshot in debug
app.get('/availability', async (req, res) => {
  const BASE = 'https://playtomic.com';

  const slugs = String(req.query.slug || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const date = String(req.query.date || '').trim();
  const desiredDuration = parseInt(req.query.duration || '0', 10) || 0;
  const wantShot = String(req.query.screenshot || '') === '1';

  if (!slugs.length || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Bad or missing slug/date' });
  }

  // Start-time window filters
  const hmToMin = (s) => { const [h, m] = String(s).split(':').map(Number); return (h|0)*60 + (m|0); };
  const earliestHH = normHHMM(String(req.query.earliest || ''));
  const latestHH   = normHHMM(String(req.query.latest   || ''));
  const earliestMin = earliestHH ? hmToMin(earliestHH) : null;
  const latestMin   = latestHH   ? hmToMin(latestHH)   : null;

  let context, page;
  const items = [];
  const debug = { date, slugs, clubs: [] };

  try {
    context = await newContext();
    page = await context.newPage();

    // Trim some trackers to speed up a bit
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.includes('google-analytics.com') || u.includes('googletagmanager.com') ||
          u.includes('doubleclick.net') || u.includes('hotjar') ||
          u.includes('facebook.net')   || u.includes('segment.com')) {
        return route.abort();
      }
      route.continue();
    });

    for (const slug of slugs) {
      const clubDebug = {
        slug,
        url: `${BASE}/clubs/${encodeURIComponent(slug)}`,
        steps: [],
        clubName: null,
        blocksFound: 0,
        filtered: 0,
        status: 'pending',
        error: null,
      };
      debug.clubs.push(clubDebug);

      const perClubItems = [];

      try {
        // Navigate + hydrate
        await page.goto(clubDebug.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#__next', { timeout: 30000 }).catch(() => {});
        await autoDismissConsent(page).catch(() => {});
        await page.evaluate(() => window.scrollTo(0, 0)).catch(()=>{});
        const hydrated = await ensureHydrated(page);
        clubDebug.steps.push(hydrated ? 'hydrated' : 'not_hydrated');

        // Drive picker to date
        const cal = await forceDateInUI(page, date);
        clubDebug.steps.push('date_selected');

        // Give layout a moment
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{});

       // Capture ALL availability JSON (multiple responses happen), then merge
const availPayloads = [];
const onAvail = async (r) => {
  if (r.url().includes('/api/clubs/availability') && r.status() === 200) {
    try { availPayloads.push(await r.json()); } catch {}
  }
};
page.on('response', onAvail);

// Let UI settle to allow XHR(s) to fire for the selected date
await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(()=>{});

// Build a price index from everything we saw
let priceIndex = new Map();
for (const payload of availPayloads) {
  const part = buildPriceIndex(payload);
  for (const [k, v] of part) if (!priceIndex.has(k)) priceIndex.set(k, v);
}

// Stop listening for more responses for this club
page.off('response', onAvail);

        // Per-court meta (name/tags)
        const meta = await collectCourtMeta(page);
        clubDebug.clubName = meta.clubName || null;

        // Visible/available blocks → source of truth
        const blocks = await page.$$eval(
          'div[data-court-id][data-start-hour][data-end-hour]',
          (els) => els.map((el) => ({
            courtId: el.getAttribute('data-court-id'),
            start:   el.getAttribute('data-start-hour'),
            end:     el.getAttribute('data-end-hour'),
          }))
        ).catch(() => []);
        clubDebug.blocksFound = blocks.length;

        for (const b of blocks) {
          const startHH = normHHMM(b.start);
          const endHH   = normHHMM(b.end);
          if (!b.courtId || !startHH || !endHH) continue;

          const st = hmToMin(startHH);
          const en = hmToMin(endHH);
          const dur = ((en - st + 1440) % 1440) || 0;

          // exact duration match if provided
          if (desiredDuration && dur && dur !== desiredDuration) continue;

          // START-time window (inclusive)
          if (earliestMin != null && st < earliestMin) continue;
          if (latestMin   != null && st > latestMin)   continue;

          // price lookup
          let price = null;
          const k1 = `${b.courtId}|${startHH}|${endHH}`;
          const k2 = `${b.courtId}|${startHH}|`;
          price = priceIndex.get(k1) || priceIndex.get(k2) || null;

          const cm = meta.courts[b.courtId] || {};

          perClubItems.push({
            slug,
            clubName: meta.clubName || slug,
            resourceId: b.courtId,
            slotDate: date,
            courtName: cm.courtName || null,
            startTime: startHH,
            endTime: endHH,
            price: price,
            size: cm.size || null,
            location: cm.location || null,
          });
        }

        clubDebug.filtered = perClubItems.length;
        clubDebug.status = 'ok';

        // Optional screenshot for debugging
        if (wantShot) {
          try {
            clubDebug.screenshot = Buffer.from(await page.screenshot({ fullPage: true })).toString('base64');
          } catch {}
        }

        // Merge club items into global list
        items.push(...perClubItems);
      } catch (err) {
        clubDebug.status = 'failed';
        clubDebug.error = String(err).slice(0, 300);
        // continue to next slug
      }
    }

    // ---- Build top-level summary for the frontend UI ----
    const requested = slugs.length;
    const succeeded = debug.clubs.filter(c => c.status === 'ok').length;
    const failed    = requested - succeeded;
    const totalslots = items.length;

    const clubsWithSlots = (() => {
      const set = new Set(items.map(i => i.slug));
      return set.size;
    })();

    let verdict;
    if (succeeded === 0) verdict = 'error';               // all queries failed
    else if (totalslots === 0) verdict = 'empty_ok';      // queries ok, but no matches
    else if (failed > 0) verdict = 'partial_ok';          // some clubs failed
    else verdict = 'ok';                                  // all good, with results

    // Optional convenience text your UI can use directly
    let uiHint;
    if (verdict === 'ok') {
      uiHint = `Successfully retrieved slots from ${succeeded} club(s). See results below.`;
    } else if (verdict === 'partial_ok') {
      uiHint = `Successfully retrieved slots from ${succeeded} club(s). ${failed} club quer${failed === 1 ? 'y' : 'ies'} might have failed.`;
    } else if (verdict === 'empty_ok') {
      uiHint = 'No suitable slots available.';
    } else {
      uiHint = 'Something went wrong. Try again.';
    }

    return res.json({
      date,
      slugs,
      totalslots,
      items,
      summary: {
        requested,
        succeeded,
        failed,
        clubsWithSlots,
        totalslots,
        verdict,     // one of: 'ok' | 'partial_ok' | 'empty_ok' | 'error'
        uiHint       // optional helper string (use counts if you prefer building your own)
      },
      debug
    });
  } catch (e) {
    // catastrophic failure (before/around browser setup)
    return res.status(500).json({
      error: 'scrape failed',
      detail: String(e),
      summary: {
        requested: slugs.length,
        succeeded: 0,
        failed: slugs.length,
        clubsWithSlots: 0,
        totalslots: 0,
        verdict: 'error',
        uiHint: 'Something went wrong. Try again.'
      }
    });
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
  }
});



/* =========================
   Helpers
   ========================= */

// Sweep the scrollable grid so lazy/virtual rows render
async function sweepVirtualizedGrid(page) {
  const handle = await page.evaluateHandle(() => {
    const sample = document.querySelector('div[data-court-id][data-start-hour][data-end-hour]');
    const sc = sample?.closest('[class*="overflow"]') || document.scrollingElement || document.body;
    return sc;
  });

  await page.evaluate(async sc => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let prev = -1, stable = 0;
    for (let i = 0; i < 12; i++) {
      sc.scrollTop = 0;
      await sleep(60);
      sc.scrollTop = sc.scrollHeight;
      await sleep(120);
      const cnt = document.querySelectorAll('div[data-court-id][data-start-hour][data-end-hour]').length;
      if (cnt === prev) {
        if (++stable >= 2) break; // two stable reads
      } else {
        stable = 0;
        prev = cnt;
      }
    }
  }, handle).catch(() => {});
  try { await handle.dispose(); } catch {}
}

// Wait for “quiet” mutations (grid not changing)
async function waitForGridQuiet(page, ms = 600) {
  await page.evaluate((quietMs) => new Promise(resolve => {
    const root = document.getElementById('__next') || document.body;
    let timer;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { obs.disconnect(); resolve(); }, quietMs);
    });
    obs.observe(root, { childList: true, subtree: true });
    timer = setTimeout(() => { obs.disconnect(); resolve(); }, quietMs); // nothing happened
  }), ms).catch(()=>{});
}


// Wait until the Next.js app looks “hydrated” (rough heuristic)
async function ensureHydrated(page) {
  return await page
    .waitForFunction(() => {
      const root = document.getElementById('__next');
      if (!root) return false;
      return root.querySelectorAll('div').length > 80;
    }, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
}

// Click common cookie/consent buttons if they appear
async function autoDismissConsent(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button#onetrust-accept-btn-handler',
    'button:has-text("Accept all")',
    'button:has-text("ACCEPT ALL")',
    'button:has-text("Accept")',
    '[aria-label="Accept all"]',
    '[data-testid*="consent"] button',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) { await btn.click({ delay: 30 }).catch(()=>{}); await page.waitForTimeout(150); }
  }
  for (const frame of page.frames()) {
    try {
      const b = await frame.$('#onetrust-accept-btn-handler');
      if (b) { await b.click({ delay: 30 }).catch(()=>{}); await page.waitForTimeout(150); }
    } catch {}
  }
}

// Open the “Today” pill (date picker). Returns true if clicked/opened.
async function openDatePicker(page) {
  const candidates = [
    'button:has-text("Today")',
    'button:has-text("Tomorrow")',
  ];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      await el.click({ delay: 30 }).catch(()=>{});
      await page.waitForTimeout(150);
      return true;
    }
  }
  return false;
}

// Compute month delta between header like "October 2025" and target YYYY-MM-DD.
// Returns 0 if parsing fails (we’ll still try clicking the day directly).
function computeMonthDelta(headerText, targetYmd) {
  if (!headerText) return 0;
  const m = headerText.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{4})/i);
  if (!m) return 0;
  const monthNames = {
    january:0,february:1,march:2,april:3,may:4,june:5,
    july:6,august:7,september:8,october:9,november:10,december:11
  };
  const visMonth = monthNames[m[1].toLowerCase()];
  const visYear  = parseInt(m[2], 10);
  const t = new Date(`${targetYmd}T12:00:00`);
  if (Number.isNaN(t.getTime())) return 0;
  return (t.getFullYear() - visYear) * 12 + (t.getMonth() - visMonth);
}

// Drive the picker to the given YYYY-MM-DD (no querystring). Returns rich info.
async function forceDateInUI(page, ymd) {
  const out = {
    opened: false,
    headerText: null,
    monthDelta: 0,
    monthClicks: 0,
    monthClickSelector: null,
    dayButtonFound: false,
    xhrOk: null,
    pill: null,
  };

  // Open picker
  out.opened = await openDatePicker(page);

  // Read header (e.g., "October 2025")
  out.headerText = (await page.locator('div.text-center.font-medium').first().textContent().catch(() => ''))?.trim() || null;

  // Navigate months if needed
  out.monthDelta = computeMonthDelta(out.headerText, ymd);
  if (out.monthDelta !== 0) {
    const selNext = 'button:has(svg path[d="M9 5l7 7-7 7"])';     // → next month
    const selPrev = 'button:has(svg path[d="M15 19l-7-7 7-7"])'; // ← prev month
    const sel = out.monthDelta > 0 ? selNext : selPrev;
    const clicks = Math.min(24, Math.abs(out.monthDelta));
    for (let i = 0; i < clicks; i++) {
      const btn = page.locator(sel).first();
      const exists = await btn.count();
      if (exists === 0) break;
      await btn.click({ delay: 30 }).catch(()=>{});
      out.monthClicks++;
      out.monthClickSelector = sel;
      await page.waitForTimeout(120);
    }
  }

  // Click day button (rounded pill inside text-center)
  const day = String(parseInt(ymd.slice(8, 10), 10));
  const dayBtn = page.locator(`div.text-center > button.rounded-full:has-text("${day}")`).first();
  if (await dayBtn.count()) {
    try { await dayBtn.scrollIntoViewIfNeeded(); } catch {}
    await dayBtn.click({ force: true, delay: 15 }).catch(()=>{});
    out.dayButtonFound = true;

    // Close popover to ensure selection commits
    await page.keyboard.press('Escape').catch(()=>{});
    await page.mouse.click(10, 10).catch(()=>{});

    // Wait for XHR to commit for the chosen date (best signal)
    const saw = await page.waitForResponse(
      r => r.url().includes('/api/clubs/availability') && r.url().includes(`date=${ymd}`),
      { timeout: 8000 }
    ).then(() => true).catch(() => false);
    out.xhrOk = saw;

    // Read the pill text after selection
    const pillLabel = await page.$eval(
      'button.flex.cursor-pointer.items-center.text-sm.font-medium',
      el => (el.textContent || '').trim()
    ).catch(() => null);
    out.pill = pillLabel || null;
  }

  return out;
}

// Collect club name and per-court metadata (name + tags) from the current page
async function collectCourtMeta(page) {
  // Club name from <title>, minus the marketing prefix
  const rawTitle = await page.title().catch(() => '') || '';
  const clubName = rawTitle.replace(/^Book a court at\s+/i, '').trim() || null;

  // Build a per-resource meta index by walking each “row”
  const courts = await page.$$eval('div.flex.border-b.ui-stroke-neutral-default', rows => {
    const out = {};
    for (const row of rows) {
      const name = (row.querySelector('.truncate')?.textContent || '').trim() || null;
      // grab the *first* block in the row to read its resource id
      const block = row.querySelector('div[data-court-id][data-start-hour][data-end-hour]');
      const rid = block?.getAttribute('data-court-id') || null;

      // tags are shown in that hover tooltip (they’re in the DOM even if hidden)
      const tagsText = (row.querySelector('.group .text-sm:last-child')?.textContent || '').toLowerCase();
      const tags = tagsText.split(',').map(s => s.trim()).filter(Boolean);

      const size = tags.find(t => t.includes('single') || t.includes('double')) || null;      // e.g. "double"
      const location = tags.find(t => t.includes('indoor') || t.includes('outdoor')) || null; // e.g. "indoor"

      if (rid) {
        out[rid] = {
          courtName: name,
          size,
          location
        };
      }
    }
    return out;
  }).catch(() => ({}));

  return { clubName, courts };
}

function buildPriceIndex(payload) {
  // Returns Map key => priceString
  // key shapes we’ll fill:
  //   `${resourceId}|${HH:MM}|${HH:MM}`  (exact start+end)
  //   `${resourceId}|${HH:MM}|`          (fallback by start time only)
  const map = new Map();

  const symbolFrom = (code) => {
    const c = String(code || '').toUpperCase();
    if (c === 'EUR' || c === 'EURO') return '€';
    if (c === 'GBP') return '£';
    if (c === 'USD') return '$';
    if (c === 'SEK') return 'kr';
    if (c === 'NOK') return 'kr';
    if (c === 'DKK') return 'kr';
    return '';
  };

  const asHHMM = (val) => {
    const s = String(val || '');
    // direct "HH:MM"
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const H = String(parseInt(m[1], 10)).padStart(2,'0');
      const M = String(parseInt(m[2], 10)).padStart(2,'0');
      return `${H}:${M}`;
    }
    // ISO-ish datetime → to local HH:MM
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const H = String(d.getHours()).padStart(2,'0');
      const M = String(d.getMinutes()).padStart(2,'0');
      return `${H}:${M}`;
    }
    return null;
  };

  const moneyString = (node, carry = {}) => {
    // Accept common price shapes; prefer formatted if present
    if (!node || typeof node !== 'object') return null;

    // 1) common formatted fields
    const formatted = node.formatted || node.display || node.text;
    if (formatted && /[\d]/.test(String(formatted))) return String(formatted).trim();

    // 2) scalar amount in minor units (e.g., 5600 = 56.00)
    const raw =
      node.total ?? node.amount ?? node.value ?? node.price ??
      (typeof node === 'number' ? node : null);

    if (raw != null && isFinite(Number(raw))) {
      const cents = Number(raw);
      // Heuristic: if >= 1000, assume cents; else if < 1000 and has decimals, assume already in major units
      const major = cents >= 1000 ? (cents / 100) : cents;
      const sym = node.currencySymbol || carry.currencySymbol || symbolFrom(node.currency || carry.currency);
      return `${major.toFixed(2)} ${sym}`.trim();
    }

    // 3) nested price object like { total: { amount, currency }, currencySymbol }
    for (const k of ['total', 'subtotal', 'final', 'fare', 'priceWithTax', 'price_without_discount']) {
      if (node[k] && typeof node[k] === 'object') {
        const s = moneyString(node[k], carry);
        if (s) return s;
      }
    }

    return null;
  };

  // Crawl payload recursively and collect tuples (rid, start, end, priceString)
  const collect = (node, ctx = {}) => {
    if (Array.isArray(node)) {
      for (const it of node) collect(it, ctx);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const next = { ...ctx };

    // carry currency info when seen
    next.currency = node.currency || node.currencyCode || next.currency || null;
    next.currencySymbol = node.currencySymbol || node.currency_symbol || next.currencySymbol || null;

    // potential resource id
    const rid =
      node.resourceId || node.resource_id ||
      (node.resource && (node.resource.id || node.resource.uuid)) ||
      node.courtId || node.court_id || next.rid || null;
    if (rid) next.rid = rid;

    // potential start / end time fields
    const start = node.start || node.startTime || node.from || node.startsAt || node.time || null;
    const end   = node.end   || node.endTime   || node.to   || node.endsAt   || null;

    // price candidate on this node
    const priceStr = moneyString(node, next);

    if (next.rid && start) {
      const sh = asHHMM(start);
      const eh = end ? asHHMM(end) : null;
      if (sh) {
        if (priceStr) {
          if (eh) map.set(`${next.rid}|${sh}|${eh}`, priceStr);
          map.set(`${next.rid}|${sh}|`, priceStr); // fallback by start only
        }
      }
    }

    // continue recursion
    for (const v of Object.values(node)) collect(v, next);
  };

  collect(payload, {});
  return map;
}


  const addMaybe = (obj) => {
    const rid =
      obj.resourceId || obj.resource_id ||
      (obj.resource && (obj.resource.id || obj.resourceId)) ||
      obj.courtId || obj.court_id;

    const st = obj.start || obj.from || obj.startTime || obj.start_time || obj.timeStart || obj.time_start;
    const en = obj.end   || obj.to   || obj.endTime   || obj.end_time   || obj.timeEnd   || obj.time_end;

    let priceText = null;
    const price = obj.price || obj.finalPrice || obj.totalPrice || obj.priceTotal || obj.cost;
    if (price) {
      if (typeof price === 'string') {
        priceText = price;
      } else if (typeof price === 'object') {
        const amount =
          (typeof price.cents === 'number' ? price.cents / 100 : undefined) ??
          price.amount ?? price.value ?? price.total ?? price.final;
        const cur = price.currencySymbol || price.currency || price.currencyCode || '';
        if (amount != null) {
          priceText = (typeof amount === 'number' ? amount.toFixed(cur ? 2 : 0) : String(amount)) + (cur ? ` ${cur}` : '');
        }
      }
    }
    if (!priceText && (obj.amount != null || obj.cents != null)) {
      const amount2 = (typeof obj.cents === 'number') ? obj.cents / 100 : obj.amount;
      const cur2 = obj.currency || obj.currencySymbol || obj.currencyCode || '';
      priceText = (typeof amount2 === 'number' ? amount2.toFixed(cur2 ? 2 : 0) : String(amount2)) + (cur2 ? ` ${cur2}` : '');
    }

    const sh = hhmm(st);
    const eh = hhmm(en);
    if (rid && sh && priceText) {
      const key = `${rid}|${sh}|${eh || ''}`;
      if (!map.has(key)) map.set(key, priceText);
    }
  };

  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') {
      addMaybe(node);
      for (const v of Object.values(node)) walk(v);
    }
  };

  try { walk(availJson); } catch {}
  return map;
}


async function collectAllBlocks(page) {
  // 1) Nudge the list to the very top first
  await page.evaluate(() => {
    const first = document.querySelector('div[data-court-id][data-start-hour][data-end-hour]');
    if (!first) return;
    const getScrollableParent = (el) => {
      let p = el.parentElement;
      while (p) {
        const cs = getComputedStyle(p);
        if (/(auto|scroll)/.test(cs.overflowY)) return p;
        p = p.parentElement;
      }
      return null;
    };
    const sc = getScrollableParent(first);
    if (sc) sc.scrollTop = 0;
    window.scrollTo(0, 0);
  }).catch(() => {});

  // 2) Sweep downward, deduping as we go
  const seen = new Set();
  const key = (b) => [b.courtId, b.start, b.end].join('|');

  let stuckCount = 0;
  let lastPos = -1;

  for (let i = 0; i < 60; i++) {
    // collect what's currently rendered
    const chunk = await page.$$eval(
      'div[data-court-id][data-start-hour][data-end-hour]',
      (els) => els.map((el) => ({
        courtId: el.getAttribute('data-court-id'),
        start:   el.getAttribute('data-start-hour'),
        end:     el.getAttribute('data-end-hour'),
      }))
    ).catch(() => []);

    for (const b of chunk) {
      if (b && b.courtId && b.start && b.end) seen.add(key(b));
    }

    // scroll one screen down in the correct container (or window fallback)
    const pos = await page.evaluate(() => {
      const first = document.querySelector('div[data-court-id][data-start-hour][data-end-hour]');
      const getScrollableParent = (el) => {
        let p = el && el.parentElement;
        while (p) {
          const cs = getComputedStyle(p);
          if (/(auto|scroll)/.test(cs.overflowY)) return p;
          p = p.parentElement;
        }
        return null;
      };
      const sc = first && getScrollableParent(first);
      const delta = Math.floor((sc ? sc.clientHeight : window.innerHeight) * 0.9);

      let before, after, max;
      if (sc) {
        before = sc.scrollTop;
        sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + delta);
        after = sc.scrollTop;
        max = sc.scrollHeight - sc.clientHeight - 1; // -1 for float fuzz
      } else {
        before = window.scrollY;
        window.scrollTo(0, window.scrollY + delta);
        after = window.scrollY;
        max = document.documentElement.scrollHeight - window.innerHeight - 1;
      }
      return { before, after, max };
    }).catch(() => ({ before: 0, after: 0, max: 0 }));

    await page.waitForTimeout(120);

    // stop if we can't move any further
    if (pos.after === pos.before || pos.after >= pos.max) {
      stuckCount++;
      if (stuckCount >= 2) break; // reached (or very near) the end twice
    } else {
      stuckCount = 0;
    }

    // also stop if position doesn't change at all across iterations (belt & suspenders)
    if (pos.after === lastPos) break;
    lastPos = pos.after;
  }

  return Array.from(seen).map((k) => {
    const [courtId, start, end] = k.split('|');
    return { courtId, start, end };
  });
}


/* =========================
   Start server
   ========================= */
app.listen(PORT, () => {
  console.log(`Server running on :${PORT} (TZ=${TZ})`);
});
