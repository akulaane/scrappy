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
  // '--disable-gpu',
  // '--single-process',
  // '--no-zygote',
];

let BROWSER = null;
async function getBrowser() {
  if (BROWSER && BROWSER.isConnected()) return BROWSER;
  BROWSER = await chromium.launch({ headless: true, args: CHROME_ARGS });
  return BROWSER;
}

async function newContext() {
  const browser = await getBrowser();

  // 1) Create context (options only)
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

  // 2) Speed up: block heavy/trackers
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

    // Per-page additional blocking (cheap)
    await page.route('**/*', route => {
      const r = route.request();
      const t = r.resourceType();
      const u = r.url();
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
// Convert "HH:MM" <-> minutes since midnight
function hmToMin(s) { const [h,m] = String(s||'').split(':').map(Number); return (h|0)*60 + (m|0); }
function minToHHMM(min) { const v=((min%1440)+1440)%1440, H=Math.floor(v/60), M=v%60; return `${String(H).padStart(2,'0')}:${String(M).padStart(2,'0')}`; }

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

    // Trim trackers
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

        // Club name from title (cleaned)
        {
          const rawTitle = await page.title().catch(() => '');
          clubDebug.clubTitleRaw = rawTitle;
          clubDebug.clubName = (rawTitle || '')
            .replace(/^Book a court\s+(?:at|in)\s+/i, '')
            .replace(/\s*\|\s*Playtomic\s*$/i, '')
            .trim();
        }

        // Drive picker to date
        const cal = await forceDateInUI(page, date);
        clubDebug.steps.push('date_selected');
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

        // Build the index (prefer target date if present)
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

          const cm = meta.courts[b.courtId] || {};

          perClubItems.push({
            slug,
            clubName: meta.clubName || slug,
            resourceId: b.courtId,
            slotDate: date,
            courtName: cm.courtName || null,
            startTime: startHH,
            endTime: endHH,
            price: lookedUp || '? EUR',  // show “? EUR” when no JSON price
            priceRaw: lookedUp || null,  // keep raw for debugging/optional display
            priceSource: lookedUp ? 'availability' : 'dom_only',
            hasPrice: !!lookedUp,
            size: cm.size || null,
            location: cm.location || null,
          });
        }

        clubDebug.filtered = perClubItems.length;
        clubDebug.status = 'ok';

        // Optional screenshot
        if (wantShot) {
          try {
            clubDebug.screenshot = Buffer
              .from(await page.screenshot({ fullPage: true }))
              .toString('base64');
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
    if (succeeded === 0) verdict = 'error';
    else if (totalslots === 0) verdict = 'empty_ok';
    else if (failed > 0) verdict = 'partial_ok';
    else verdict = 'ok';

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
        verdict, // 'ok' | 'partial_ok' | 'empty_ok' | 'error'
        uiHint
      },
      debug
    });
  } catch (e) {
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
   Single-slot price verifier
   ========================= */
// GET /price
// Params:
//   slug        = club slug (e.g. "padelikeskus")   [required]
//   date        = YYYY-MM-DD                        [required]
//   resourceId  = court resource UUID               [required]
//   start       = "HH:MM"                           [required]
//   end         = "HH:MM"                           [preferred]
//   duration    = 60|90|120                         [fallback if end not provided]
app.get('/price', async (req, res) => {
  const BASE = 'https://playtomic.com';

  const slug       = String(req.query.slug || '').trim();
  const date       = String(req.query.date || '').trim();
  const resourceId = String(req.query.resourceId || '').trim();
  const startHH    = normHHMM(String(req.query.start || ''));
  let   endHH      = normHHMM(String(req.query.end   || ''));
  let   duration   = parseInt(req.query.duration || '0', 10) || 0;

  if (!slug || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !resourceId || !startHH) {
    return res.status(400).json({ error: 'Bad or missing slug/date/resourceId/start' });
  }

  if (!endHH && duration) endHH = minToHHMM(hmToMin(startHH) + duration);
  if (!duration && endHH) duration = ((hmToMin(endHH) - hmToMin(startHH) + 1440) % 1440);
  if (!endHH && !duration) {
    return res.status(400).json({ error: 'Provide end=HH:MM or duration=minutes' });
  }

  // Snap duration to [60,90,120] if fuzzed
  const allowedDur = [60, 90, 120];
  if (!allowedDur.includes(duration)) {
    const nearest = allowedDur.reduce((best, v) =>
      Math.abs(v - duration) < Math.abs(best - duration) ? v : best, allowedDur[0]);
    duration = nearest;
    endHH = minToHHMM(hmToMin(startHH) + duration);
  }

  const debug = {
    slug, date, resourceId, startHH, endHH, duration,
    url: `${BASE}/clubs/${encodeURIComponent(slug)}`,
    steps: [],
    clicked: false,
    courtName: null,
    tooltipFound: false,
    tooltipHeaderMatch: { name: null, time: null },
    rows: [],
    chosen: null
  };

  const HARD_DEADLINE_MS = 15000;
  const deadline = Date.now() + HARD_DEADLINE_MS;

  let context, page;
  try {
    context = await newContext();
    page = await context.newPage();

    // Trim trackers
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.includes('google-analytics.com') || u.includes('googletagmanager.com') ||
          u.includes('doubleclick.net') || u.includes('hotjar') ||
          u.includes('facebook.net')   || u.includes('segment.com')) {
        return route.abort();
      }
      route.continue();
    });

    // Nav + hydrate
    if (Date.now() > deadline) throw new Error('timeout_before_nav');
    await page.goto(debug.url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
    await page.waitForSelector('#__next', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
    await autoDismissConsent(page).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(()=>{});
    const hydrated = await ensureHydrated(page);
    debug.steps.push(hydrated ? 'hydrated' : 'not_hydrated');

    // Pick date
    if (Date.now() > deadline) throw new Error('timeout_before_date');
    await forceDateInUI(page, date);
    debug.steps.push('date_selected');

    // Row court name (used to anchor correct tooltip)
    debug.courtName = await getCourtNameForResource(page, resourceId);

    // Click exact slot
    if (Date.now() > deadline) throw new Error('timeout_before_click');
    const clickRes = await findAndClickSlot(page, resourceId, startHH, endHH);
    debug.clicked = !!clickRes?.clicked;
    debug.courtName = clickRes?.courtName || debug.courtName || null;
    await page.waitForTimeout(180);

    if (!debug.clicked) {
      return res.json({
        slug, date, resourceId,
        startTime: startHH, endTime: endHH,
        price: '? EUR',
        source: 'not_clicked',
        debug
      });
    }

    // Find the *right* tooltip by header (court name + start time) — tolerant, no "Continue" required
    const tip = await findTooltipByHeader(page, debug.courtName, startHH, Math.max(800, deadline - Date.now()));
    if (!tip) {
      return res.json({
        slug, date, resourceId,
        startTime: startHH, endTime: endHH,
        price: '? EUR',
        source: 'tooltip_not_found',
        debug
      });
    }
    debug.tooltipFound = true;

    // Record header we matched (for transparency)
    try {
      let header = tip.locator('.flex.flex-row.justify-between.font-bold').first();
      if (!(await header.count())) {
        header = tip.locator('div').filter({
          has: page.locator(':scope > div:nth-child(2)', { hasText: /\b\d{1,2}:\d{2}\b/ })
        }).first();
      }
      const kids = header.locator(':scope > div');
      debug.tooltipHeaderMatch.name = (await kids.nth(0).innerText().catch(()=>null)) || null;
      debug.tooltipHeaderMatch.time = (await kids.nth(1).innerText().catch(()=>null)) || null;
    } catch {}

    // Read duration/price rows and pick the one for our requested duration
    const rows = await readRowsFromTooltip(tip);
    debug.rows = rows;
    const chosen = rows.find(r => r.minutes === duration) || null;
    debug.chosen = chosen;

    return res.json({
      slug, date, resourceId,
      startTime: startHH,
      endTime: endHH,
      price: chosen ? chosen.price : '? EUR',
      source: chosen ? 'popup_row' : 'popup',
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
   Helpers (single, de-duplicated)
   ========================= */

// Find the scroll grid row label (court name) for a given resource
async function getCourtNameForResource(page, rid) {
  try {
    return await page.evaluate((resourceId) => {
      const block = document.querySelector(`div[data-court-id="${resourceId}"]`);
      if (!block) return null;
      const row = block.closest('div.flex.border-b');
      const name = row?.querySelector('.truncate')?.textContent || '';
      return name.replace(/\u00a0/g, ' ').trim() || null;
    }, rid);
  } catch { return null; }
}

// Find the *right* tooltip by matching header: left=name, right=time (tolerant)
// We do NOT require a "Continue" button. Returns a Locator or null.
async function findTooltipByHeader(page, expectName, expectStart, timeoutMs = 4500) {
  const deadline = Date.now() + timeoutMs;

  const norm = s => String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
  const toHMM = s => {
    const m = /(\d{1,2}):(\d{2})/.exec(String(s||'')); 
    return m ? `${parseInt(m[1],10)}:${m[2]}` : null; // strip leading zero in hours
  };
  const wantName = expectName ? norm(expectName) : null;
  const wantTime = toHMM(expectStart);

  // Candidate containers for the floating tooltip
  const containerSel = [
    'div.absolute',
    'div[style*="position: absolute"]',
    '[role="tooltip"]',
  ].join(', ');

  while (Date.now() < deadline) {
    const pops = page.locator(containerSel);
    const n = await pops.count().catch(() => 0);

    for (let i = 0; i < n; i++) {
      const p = pops.nth(i);
      try { await p.waitFor({ state: 'visible', timeout: 100 }); } catch {}

      // header: try the known class first, then any row with two <div> children where the right is time
      let header = p.locator('.flex.flex-row.justify-between.font-bold').first();
      if (!(await header.count())) {
        header = p.locator('div').filter({
          has: page.locator(':scope > div:nth-child(2)', { hasText: /\b\d{1,2}:\d{2}\b/ })
        }).first();
      }
      if (!(await header.count())) continue;

      const kids = header.locator(':scope > div');
      if ((await kids.count().catch(()=>0)) < 2) continue;

      const leftName  = (await kids.nth(0).innerText().catch(()=>'')) || '';
      const rightTime = (await kids.nth(1).innerText().catch(()=>'')) || '';

      const nameOk = !wantName || norm(leftName).includes(wantName) || wantName.includes(norm(leftName));
      const timeOk = !wantTime || toHMM(rightTime) === wantTime;
      if (nameOk && timeOk) return p;
    }

    await page.waitForTimeout(120);
  }
  return null;
}

// Extract rows like ["1h 30m","54 EUR"] from a tooltip container Locator
async function readRowsFromTooltip(tip) {
  const norm = s => String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  const rows = [];

  // Try the obvious row selector first
  const candidates = await tip.locator('div.flex.cursor-pointer.flex-row.justify-between').all().catch(()=>[]);
  const scan = candidates.length ? candidates : await tip.locator('div').all().catch(()=>[]);

  for (const r of scan) {
    const kids = r.locator(':scope > div');
    if ((await kids.count().catch(()=>0)) !== 2) continue;

    const left  = norm(await kids.nth(0).innerText().catch(()=>'')); // "2h 00m"
    const right = norm(await kids.nth(1).innerText().catch(()=>'')); // "72 EUR"

    const looksDur   = /(\d+\s*h\s*\d{1,2}\s*m)|(\d+\s*h)|(\d{1,3}\s*m)/i.test(left);
    const looksMoney = (/\d/.test(right) && /(EUR|€|USD|\$|GBP|£|kr)/i.test(right));
    if (!looksDur || !looksMoney) continue;

    // parse minutes from "Xh YYm" | "Xh" | "YYm"
    let minutes = null, m;
    const s = left.toLowerCase();
    if ((m = s.match(/(\d+)\s*h\s*(\d{1,2})\s*m/))) minutes = (+m[1])*60 + (+m[2]);
    else if ((m = s.match(/(\d+)\s*h(?![a-z])/)))  minutes = (+m[1])*60;
    else if ((m = s.match(/(\d{1,3})\s*m/)))       minutes = (+m[1]);

    if (minutes) rows.push({ label: left, minutes, price: right });
  }
  return rows;
}

// Click a specific slot by resourceId + start + end, tolerant of "H:MM" vs "HH:MM".
// Returns { clicked: boolean, where: string|null, courtName: string|null }
async function findAndClickSlot(page, resourceId, startHH, endHH, maxSweeps = 24) {
  function toHMM(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    return `${parseInt(m[1], 10)}:${m[2]}`; // strip leading zero in hours
  }
  const wantStart = toHMM(startHH);
  const wantEnd   = toHMM(endHH);

  async function tryClickOnce() {
    return await page.evaluate(({ rid, s, e }) => {
      function norm(x) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(x || ''));
        if (!m) return null;
        return `${parseInt(m[1], 10)}:${m[2]}`;
      }
      const nodes = document.querySelectorAll('div[data-court-id][data-start-hour][data-end-hour]');
      for (const el of nodes) {
        if (el.getAttribute('data-court-id') !== rid) continue;
        const st = norm(el.getAttribute('data-start-hour'));
        const en = norm(el.getAttribute('data-end-hour'));
        if (st === s && en === e) {
          let courtName = null;
          try {
            const row = el.closest('div.flex.border-b.ui-stroke-neutral-default');
            courtName = (row?.querySelector('.truncate')?.textContent || '').trim() || null;
          } catch {}
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { el.click(); return { ok: true, courtName }; } catch {}
        }
      }
      return { ok: false, courtName: null };
    }, { rid: resourceId, s: wantStart, e: wantEnd });
  }

  // Try current viewport first
  const first = await tryClickOnce();
  if (first?.ok) return { clicked: true, where: 'initial', courtName: first.courtName };

  // Bounded downward sweeps through the scroll container
  for (let i = 0; i < maxSweeps; i++) {
    const moved = await page.evaluate(() => {
      const sample = document.querySelector('div[data-court-id][data-start-hour][data-end-hour]');
      const getScrollableParent = (el) => {
        let p = el && el.parentElement;
        while (p) {
          const cs = getComputedStyle(p);
          if (/(auto|scroll)/.test(cs.overflowY)) return p;
          p = p.parentElement;
        }
        return null;
      };
      const sc = sample && getScrollableParent(sample);
      if (sc) {
        const before = sc.scrollTop;
        const delta = Math.floor(sc.clientHeight * 0.9);
        sc.scrollTop = Math.min(sc.scrollHeight, before + delta);
        return sc.scrollTop !== before;
      } else {
        const before = window.scrollY;
        window.scrollTo(0, before + Math.floor(window.innerHeight * 0.9));
        return window.scrollY !== before;
      }
    }).catch(() => false);

    await page.waitForTimeout(120);
    const again = await tryClickOnce();
    if (again?.ok) return { clicked: true, where: `sweep_${i+1}`, courtName: again.courtName };
    if (!moved) break; // reached end
  }

  return { clicked: false, where: null, courtName: null };
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

// Open the “Today/Tomorrow” pill (date picker). Returns true if clicked/opened.
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

    // Wait for XHR to commit for the chosen date
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
  // Club name from <title>, clean marketing bits
  const rawTitle = await page.title().catch(() => '') || '';
  const clubName = (rawTitle || '')
    .replace(/^Book a court\s+(?:at|in)\s+/i, '')
    .replace(/\s*\|\s*Playtomic\s*$/i, '')
    .trim() || null;

  // Build a per-resource meta index by walking each “row”
  const courts = await page.$$eval('div.flex.border-b.ui-stroke-neutral-default', rows => {
    const out = {};
    for (const row of rows) {
      const name = (row.querySelector('.truncate')?.textContent || '').trim() || null;
      const block = row.querySelector('div[data-court-id][data-start-hour][data-end-hour]');
      const rid = block?.getAttribute('data-court-id') || null;

      const tooltip = row.querySelector('.group .text-sm:last-child');
      const tagsText = (tooltip?.textContent || '').toLowerCase();
      const tags = tagsText.split(',').map(s => s.trim()).filter(Boolean);

      const size = tags.find(t => t.includes('single') || t.includes('double')) || null;
      const location = tags.find(t => t.includes('indoor') || t.includes('outdoor')) || null;

      if (rid) {
        out[rid] = { courtName: name, size, location };
      }
    }
    return out;
  }).catch(() => ({}));

  return { clubName, courts };
}

// Build `${resourceId}|HH:MM|HH:MM` and `${resourceId}|HH:MM|` index from availability payload(s)
function buildPriceIndex(payload, targetDate) {
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

/* =========================
   Start server
   ========================= */
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});

// Graceful shutdown
async function shutdown() {
  try { await BROWSER?.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
