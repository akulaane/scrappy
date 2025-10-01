
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

// Club name from title (cleaned)
{
  const rawTitle = await page.title().catch(() => '');
  clubDebug.clubTitleRaw = rawTitle;
  clubDebug.clubName = (rawTitle || '')
    .replace(/^Book a court\s+(?:at|in)\s+/i, '')
    .replace(/\s*\|\s*Playtomic\s*$/i, '')
    .trim();
}



         
         
        clubDebug.steps.push(hydrated ? 'hydrated' : 'not_hydrated');

        // Drive picker to date
        const cal = await forceDateInUI(page, date);
        clubDebug.steps.push('date_selected');

        // Give layout a moment
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{});

// ---- PRICE CAPTURE: (1) live responses, (2) performance sniff, (3) in-page guesses ----
let priceIndex = new Map();
const availPayloads = [];

// (1) Listen briefly for live responses to /api/clubs/availability
const onAvail = async (r) => {
  const u = r.url();
  if (u.includes('/api/clubs/availability') && r.status() === 200) {
    try {
      const j = await r.json();
      availPayloads.push(j);
      (clubDebug.availUrls ||= []).push(u);
    } catch {}
  }
};
page.on('response', onAvail);

// short settle window for the picker to fire XHRs
await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(()=>{});
page.off('response', onAvail);
         clubDebug.priceIndexSize = priceIndex.size || 0;

// (2) Look at Performance entries to discover the exact URL the app used
try {
  const perfUrls = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource') || [];
    return entries.map(e => e.name).filter(u => u.includes('/api/clubs/availability')).slice(-3);
  });
  if (perfUrls?.length) {
    clubDebug.perfAvailUrls = perfUrls;
    // Fetch the newest one again to get JSON
    const lastUrl = perfUrls[perfUrls.length - 1];
    const p = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'same-origin' });
      if (!r.ok) return null;
      try { return await r.json(); } catch { return null; }
    }, lastUrl);
    if (p) availPayloads.push(p);
  }
} catch {}

// (3) If still nothing, try a few likely query variants using clubId from __NEXT_DATA__
if (availPayloads.length === 0) {
  try {
    const guessed = await page.evaluate(async (theDate) => {
      const tried = [];
      const results = [];

      const el = document.querySelector('script#__NEXT_DATA__');
      const data = el ? JSON.parse(el.textContent || '{}') : null;

      function findUuid(n) {
        if (!n || typeof n !== 'object') return null;
        if (typeof n.id === 'string' && /^[0-9a-f-]{36}$/i.test(n.id)) return n.id;
        for (const v of Object.values(n)) { const got = findUuid(v); if (got) return got; }
        return null;
      }

      const clubId = findUuid(data);
      if (!clubId) return { tried, results };

      const urls = [
        `/api/clubs/availability?clubId=${encodeURIComponent(clubId)}&start_date=${encodeURIComponent(theDate)}`,
        `/api/clubs/availability?clubId=${encodeURIComponent(clubId)}&start_date=${encodeURIComponent(theDate)}&days=2`,
        `/api/clubs/availability?clubId=${encodeURIComponent(clubId)}&date=${encodeURIComponent(theDate)}`,
        `/api/clubs/availability?clubId=${encodeURIComponent(clubId)}&startDate=${encodeURIComponent(theDate)}`,
        `/api/clubs/availability?clubId=${encodeURIComponent(clubId)}&dateFrom=${encodeURIComponent(theDate)}`
      ];

      for (const u of urls) {
        tried.push(u);
        try {
          const r = await fetch(u, { credentials: 'same-origin' });
          if (r.ok) {
            const j = await r.json();
            if (j && (Array.isArray(j) ? j.length : Object.keys(j).length)) {
              results.push({ url: u, payload: j });
              break;
            }
          }
        } catch {}
      }
      return { tried, results };
    }, date);

    clubDebug.guessTried = guessed?.tried || [];
    if (guessed?.results?.length) {
      clubDebug.guessHit = guessed.results[0].url;
      availPayloads.push(guessed.results[0].payload);
    }
  } catch {}
}

// Finally build the index (prefer target date if present)
for (const payload of availPayloads) {
  const part = buildPriceIndex(payload, date);
  for (const [k, v] of part) if (!priceIndex.has(k)) priceIndex.set(k, v);
}
clubDebug.priceIndex = {
  size: priceIndex.size,
  sample: Array.from(priceIndex.keys()).slice(0, 5)
};


        // Per-court meta (name/tags)
const meta = await collectCourtMeta(page);
clubDebug.clubName = meta.clubName || clubDebug.clubName || null;

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

// price lookup (+ fallback for DOM-only slots)
const k1 = `${b.courtId}|${startHH}|${endHH}`;
const k2 = `${b.courtId}|${startHH}|`;
const lookedUp = priceIndex.get(k1) || priceIndex.get(k2) || null;

const price       = lookedUp ?? null;
const priceSource = lookedUp ? 'availability' : 'dom_only';

const cm = meta.courts[b.courtId] || {};

perClubItems.push({
  slug,
  clubName: meta.clubName || slug,
  resourceId: b.courtId,
  slotDate: date,
  courtName: cm.courtName || null,
  startTime: startHH,
  endTime: endHH,
  price: lookedUp || '? EUR',   // show “? EUR” when no JSON price
  priceRaw: lookedUp || null,   // keep raw for debugging/optional display
  priceSource,                  // 'availability' or 'dom_only'
  hasPrice: !!lookedUp,         // quick boolean for UI
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
   Single-slot price verifier — simple & strict
   ========================= */
app.get('/price', async (req, res) => {
  const BASE = 'https://playtomic.com';

  const slug       = String(req.query.slug || '').trim();
  const date       = String(req.query.date || '').trim();
  const resourceId = String(req.query.resourceId || '').trim();
  const startHH    = normHHMM(String(req.query.start || ''));
  let   endHH      = normHHMM(String(req.query.end   || ''));
  let   duration   = parseInt(req.query.duration || '0', 10) || 0;

  // ---- tiny helpers (pure)
  const hmToMin = (s) => { const [h, m] = String(s).split(':').map(Number); return (h|0)*60 + (m|0); };
  const minToHHMM = (min) => { const v=((min%1440)+1440)%1440, H=Math.floor(v/60), M=v%60; return `${String(H).padStart(2,'0')}:${String(M).padStart(2,'0')}`; };
  const diffMin = (a,b) => ((b - a + 1440) % 1440);
  const hhVariants = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return [String(hhmm || '')];
    const H = parseInt(m[1], 10), M = m[2];
    return [...new Set([`${H}:${M}`, `${String(H).padStart(2,'0')}:${M}`])];
  };

  if (!slug || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !resourceId || !startHH) {
    return res.status(400).json({ error: 'Bad or missing slug/date/resourceId/start' });
  }

  // prefer duration if both provided but disagree
  if (endHH && duration) {
    const inferred = diffMin(hmToMin(startHH), hmToMin(endHH));
    if (Math.abs(inferred - duration) >= 5) {
      endHH = minToHHMM(hmToMin(startHH) + duration);
    }
  }
  if (!endHH && duration) endHH = minToHHMM(hmToMin(startHH) + duration);
  if (!duration && endHH) duration = diffMin(hmToMin(startHH), hmToMin(endHH));
  if (!endHH && !duration) {
    return res.status(400).json({ error: 'Provide end=HH:MM or duration=minutes' });
  }

  // Normalize duration to 60/90/120 if slightly off
  const allowed = [60, 90, 120];
  if (!allowed.includes(duration)) {
    duration = allowed.reduce((best, v) =>
      Math.abs(v - duration) < Math.abs(best - duration) ? v : best, allowed[0]);
  }

  // ---- local minimal helpers (route-private)
  async function getGridScroller(page) {
    const handle = await page.evaluateHandle(() => {
      const sample = document.querySelector('div[data-court-id][data-start-hour][data-end-hour]');
      const getScrollableParent = (el) => {
        let p = el?.parentElement;
        while (p) {
          const cs = getComputedStyle(p);
          if (/(auto|scroll)/.test(cs.overflowY)) return p;
          p = p.parentElement;
        }
        return null;
      };
      return sample ? getScrollableParent(sample) : (document.scrollingElement || document.body);
    });
    return handle;
  }

  async function queryBlockLocator(page, rid, start, end) {
    // try both H:MM and HH:MM variants
    for (const s of hhVariants(start)) {
      for (const e of hhVariants(end)) {
        let base = page.locator(`div[data-court-id="${rid}"][data-start-hour="${s}"][data-end-hour="${e}"]`);
        if (await base.count()) {
          const abs = base.locator('xpath=.//div[contains(@class,"absolute")]').first();
          if (await abs.count()) return abs;
          return base.first();
        }
      }
    }
    return null;
  }

  async function clickExactBlock(page, rid, start, end, sweeps = 30) {
    // try in current viewport first
    let loc = await queryBlockLocator(page, rid, start, end);
    if (loc && await loc.count()) {
      try { await loc.scrollIntoViewIfNeeded(); } catch {}
      await loc.click({ force: true }).catch(()=>{});
      return true;
    }
    // sweep down the grid to trigger virtualization rendering
    for (let i = 0; i < sweeps; i++) {
      const sc = await getGridScroller(page);
      const moved = await page.evaluate(sc => {
        const before = sc ? sc.scrollTop : window.scrollY;
        const delta = Math.floor((sc ? sc.clientHeight : window.innerHeight) * 0.9);
        if (sc) sc.scrollTop = Math.min(sc.scrollHeight, before + delta);
        else window.scrollTo(0, before + delta);
        return (sc ? sc.scrollTop : window.scrollY) !== before;
      }, sc).catch(() => false);
      try { await sc?.dispose(); } catch {}
      await page.waitForTimeout(120);

      loc = await queryBlockLocator(page, rid, start, end);
      if (loc && await loc.count()) {
        try { await loc.scrollIntoViewIfNeeded(); } catch {}
        await loc.click({ force: true }).catch(()=>{});
        return true;
      }
      if (!moved) break; // reached end
    }
    return false;
  }

  async function waitForTooltip(page, timeoutMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      // the popup container you showed is an absolutely positioned div that contains a Continue button
      const tip = page.locator('div.absolute').filter({ has: page.getByRole('button', { name: /continue/i }) }).first();
      if (await tip.isVisible().catch(()=>false)) return tip;
      await page.waitForTimeout(100);
    }
    return null;
  }

  async function readRowsFromTooltip(tip) {
    // First try the explicit row pattern you pasted.
    let rows = await tip.locator('div.flex.cursor-pointer.flex-row.justify-between').all().catch(()=>[]);
    if (!rows.length) {
      // Fallback: any two-div row with duration on the left and money on the right
      rows = await tip.locator('div').all().catch(()=>[]);
    }

    const norm = s => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const r of rows) {
      const kids = r.locator(':scope > div');
      if ((await kids.count()) !== 2) continue;
      const left  = norm(await kids.nth(0).innerText().catch(()=>'')); // "1h 30m"
      const right = norm(await kids.nth(1).innerText().catch(()=>'')); // "54 EUR"

      const looksDur   = /(\d+\s*h\s*\d{1,2}\s*m)|(\d+\s*h)|(\d{1,3}\s*m)/i.test(left);
      const looksMoney = (/\d/.test(right) && /(EUR|€|USD|\$|GBP|£|kr)/i.test(right));
      if (!looksDur || !looksMoney) continue;

      let minutes = null, m;
      const s = left.toLowerCase();
      if ((m = s.match(/(\d+)\s*h\s*(\d{1,2})\s*m/))) minutes = (+m[1])*60 + (+m[2]);
      else if ((m = s.match(/(\d+)\s*h(?![a-z])/)))  minutes = (+m[1])*60;
      else if ((m = s.match(/(\d{1,3})\s*m/)))       minutes = (+m[1]);

      if (minutes) out.push({ label: left, minutes, price: right });
    }
    return out;
  }

  async function readContinuePrice(page, timeoutMs = 1500) {
    const t0 = Date.now(), moneyRe = /\b\d+(?:[.,]\d{1,2})?\s*(?:€|EUR)\b/i;
    while (Date.now() - t0 < timeoutMs) {
      const btn = page.getByRole('button', { name: /continue/i }).first();
      if (await btn.count()) {
        const txt = (await btn.textContent()) || '';
        const m = txt.match(moneyRe);
        if (m) return m[0].replace(/\s+/g, ' ').trim();
      }
      await page.waitForTimeout(100);
    }
    return null;
  }

  // ---- main
  const debug = {
    slug, date, resourceId, startHH, endHH, duration,
    url: `${BASE}/clubs/${encodeURIComponent(slug)}`,
    steps: [],
    clicked: false,
    tooltip: null,
    rows: [],
    chosen: null
  };

  let context, page;
  try {
    context = await newContext();
    page = await context.newPage();

    // light filtering for speed
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.includes('google-analytics.com') || u.includes('googletagmanager.com') ||
          u.includes('doubleclick.net') || u.includes('hotjar') ||
          u.includes('facebook.net')   || u.includes('segment.com')) {
        return route.abort();
      }
      route.continue();
    });

    await page.goto(debug.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#__next', { timeout: 15000 }).catch(()=>{});
    await autoDismissConsent(page).catch(()=>{});
    const hydrated = await ensureHydrated(page);
    debug.steps.push(hydrated ? 'hydrated' : 'not_hydrated');

    await forceDateInUI(page, date);
    debug.steps.push('date_selected');

    // 1) click the exact block by attributes (strict)
    debug.clicked = await clickExactBlock(page, resourceId, startHH, endHH, 36);
    if (!debug.clicked) {
      return res.json({
        slug, date, resourceId,
        startTime: startHH, endTime: endHH,
        price: '? EUR',
        source: 'not_clicked',
        debug
      });
    }

    // 2) wait for the tooltip created by the click
    const tip = await waitForTooltip(page, 4000);
    if (!tip) {
      return res.json({
        slug, date, resourceId,
        startTime: startHH, endTime: endHH,
        price: '? EUR',
        source: 'no_tooltip',
        debug: { ...debug, tooltip: 'not_found' }
      });
    }
    debug.tooltip = 'found';

    // 3) read rows and pick the requested duration
    const rows = await readRowsFromTooltip(tip);
    debug.rows = rows;
    const chosen = rows.find(r => r.minutes === duration) || null;
    debug.chosen = chosen;

    let price = chosen?.price || null;
    if (!price) price = await readContinuePrice(page, 1200); // last resort

    return res.json({
      slug, date, resourceId,
      startTime: startHH, endTime: endHH,
      price: price || '? EUR',
      source: chosen ? 'popup_row' : (price ? 'continue_btn' : 'popup'),
      debug
    });

  } catch (e) {
    return res.status(500).json({ error: 'price failed', detail: String(e), debug });
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
// Collect club name and per-court metadata (name + tags) from the current page
async function collectCourtMeta(page) {
  // Club name from <title>, clean marketing bits
  const rawTitle = await page.title().catch(() => '') || '';
  const clubName = (rawTitle || '')
    .replace(/^Book a court\s+(?:at|in)\s+/i, '')   // handle "at" or "in"
    .replace(/\s*\|\s*Playtomic\s*$/i, '')          // drop " | Playtomic"
    .trim() || null;

  // Build a per-resource meta index by walking each “row”
  const courts = await page.$$eval('div.flex.border-b.ui-stroke-neutral-default', rows => {
    const out = {};
    for (const row of rows) {
      const name = (row.querySelector('.truncate')?.textContent || '').trim() || null;
      // grab the *first* block in the row to read its resource id
      const block = row.querySelector('div[data-court-id][data-start-hour][data-end-hour]');
      const rid = block?.getAttribute('data-court-id') || null;

      // tags are shown in that hover tooltip (they’re in the DOM even if hidden)
      const tooltip = row.querySelector('.group .text-sm:last-child');
      const tagsText = (tooltip?.textContent || '').toLowerCase();
      const tags = tagsText.split(',').map(s => s.trim()).filter(Boolean);

      const size = tags.find(t => t.includes('single') || t.includes('double')) || null;      // e.g. "double"
      const location = tags.find(t => t.includes('indoor') || t.includes('outdoor')) || null; // e.g. "indoor"

      if (rid) {
        out[rid] = { courtName: name, size, location };
      }
    }
    return out;
  }).catch(() => ({}));

  return { clubName, courts };
}


function buildPriceIndex(payload, targetDate) {
  // Keys we produce:
  //   `${resourceId}|HH:MM|HH:MM`  (exact start+end)
  //   `${resourceId}|HH:MM|`       (start-only fallback)
  //
  // Matches Playtomic array like:
  // [
  //   { resource_id: 'uuid', start_date: 'YYYY-MM-DD', slots: [
  //       { start_time:'21:00:00', duration:60, price:'28 EUR' }, ...
  //   ]},
  //   ...
  // ]
  const map = new Map();

  const toHHMM = (s) => {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(s || ''));
    if (!m) return null;
    const H = String(parseInt(m[1], 10)).padStart(2, '0');
    return `${H}:${m[2]}`;
  };

  const addMinutes = (hhmm, minutes) => {
    const [H, M] = hhmm.split(':').map(Number);
    let t = (H * 60 + M + (minutes | 0)) % 1440;
    if (t < 0) t += 1440;
    const HH = String(Math.floor(t / 60)).padStart(2, '0');
    const MM = String(t % 60).padStart(2, '0');
    return `${HH}:${MM}`;
  };

  const arr = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const hasTarget = !!targetDate && arr.some(sec => String(sec.start_date || '') === String(targetDate));

  for (const sec of arr) {
    const rid = sec.resource_id || sec.resourceId || sec.court_id || sec.courtId;
    if (!rid) continue;

    if (targetDate && hasTarget) {
      if (String(sec.start_date || '') !== String(targetDate)) continue;
    }

    const slots = Array.isArray(sec.slots) ? sec.slots : [];
    for (const sl of slots) {
      const startHH = toHHMM(sl.start_time || sl.start || sl.startTime);
      const dur     = parseInt(sl.duration || sl.minutes || 0, 10) || 0;
      const price   = sl.price || sl.price_text || sl.priceText || null;
      if (!startHH || !dur || !price) continue;

      const endHH = addMinutes(startHH, dur);

      map.set(`${rid}|${startHH}|${endHH}`, String(price));
      map.set(`${rid}|${startHH}|`,         String(price)); // fallback by start only
    }
  }

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
  console.log(`Server running on :${PORT}`);
   
});
