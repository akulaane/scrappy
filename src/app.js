

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
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
];

let BROWSER = null;
async function getBrowser() {
  if (BROWSER && BROWSER.isConnected()) return BROWSER;
  BROWSER = await chromium.launch({ headless: true, args: CHROME_ARGS });
  return BROWSER;
}

async function newContext() {
  const browser = await getBrowser();
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

  // Light “stealth” patches before any page script runs
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
          if (param === 37445) return 'Intel Inc.';                 // UNMASKED_VENDOR_WEBGL
          if (param === 37446) return 'Intel Iris OpenGL Engine';   // UNMASKED_RENDERER_WEBGL
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
// GET /availability?slug=<club-slug>&date=YYYY-MM-DD&duration=60|90|120[&screenshot=1]
app.get('/availability', async (req, res) => {
  const slug = String(req.query.slug || '').trim();
  const date = String(req.query.date || '').trim(); // YYYY-MM-DD
  const desiredDuration = parseInt(req.query.duration || '0', 10); // optional
  const wantShot = String(req.query.screenshot || '') === '1';
  const BASE = 'https://playtomic.com';

  if (!slug || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Bad or missing slug/date' });
  }

  const debug = {
    slug, date,
    url: `${BASE}/clubs/${encodeURIComponent(slug)}`,
    steps: [],
    picker: {
      opened: false,
      headerText: null,
      monthDelta: 0,
      monthClicks: 0,
      monthClickSelector: null,
      day: parseInt(date.slice(8, 10), 10),
      dayButtonFound: false,
      xhrOk: null,
      pill: null,
    },
    sawAvail: false,
    lastAvailUrl: null,
    blocksFound: 0,
    bannerUnbookable: false,
    errors: [],
    infos: [],
    next: { ok: 0, blocked: 0, failed: [] },
    rootDivs: 0,
    htmlSnippet: null,
  };

  // Helpers scoped to the route
  const hmToMin = (s) => { const [h, m] = String(s).split(':').map(Number); return (h|0)*60 + (m|0); };
  const minToHHMM = (min) => { const v=((min%1440)+1440)%1440, H=Math.floor(v/60), M=v%60; return `${String(H).padStart(2,'0')}:${String(M).padStart(2,'0')}`; };

  let context, page;
  let nextOk = 0, nextBlocked = 0, reqFailed = [];

  try {
    context = await newContext();
    page = await context.newPage();

    // Network observers
    page.on('response', (r) => {
      const u = r.url();
      if (u.includes('/_next/')) {
        const s = r.status();
        if (s >= 200 && s < 300) nextOk++; else nextBlocked++;
      }
      if (u.includes('/api/clubs/availability') && r.status() === 200) {
        debug.sawAvail = true;
        debug.lastAvailUrl = u;
      }
    });
    page.on('requestfailed', (r) => {
      const u = r.url();
      if (u.includes('playtomic.com') || u.includes('/_next/')) {
        reqFailed.push({ url: u.slice(0, 180), error: r.failure()?.errorText || 'unknown' });
      }
    });
    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') debug.errors.push(text);
      else debug.infos.push(`${type}: ${text}`);
    });

    // 1) Load and hydrate
    await page.goto(debug.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#__next', { timeout: 30000 }).catch(() => {});
    await autoDismissConsent(page).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(()=>{});
    const hydrated = await ensureHydrated(page);
    debug.steps.push(hydrated ? 'hydrated' : 'not_hydrated');
    debug.steps.push('navigated');

    // 2) Drive the calendar to the requested date (no ?date=)
    const cal = await forceDateInUI(page, date);
    debug.picker.opened           = cal.opened;
    debug.picker.headerText       = cal.headerText;
    debug.picker.monthDelta       = cal.monthDelta;
    debug.picker.monthClicks      = cal.monthClicks;
    debug.picker.monthClickSelector = cal.monthClickSelector;
    debug.picker.dayButtonFound   = cal.dayButtonFound;
    debug.picker.xhrOk            = cal.xhrOk;
    debug.picker.pill             = cal.pill;

    // 3) Wait for blocks or “cannot book” banner
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{});
    const sawBlocks = await page.locator('div[data-court-id][data-start-hour][data-end-hour]').first().isVisible().catch(()=>false);
    if (!sawBlocks) {
      const unbook = await page.getByText(/You cannot book in the selected date/i).first().isVisible().catch(()=>false);
      debug.bannerUnbookable = !!unbook;
    }

    // 4) Collect available-block divs (if present)
    const blocks = await page.$$eval(
      'div[data-court-id][data-start-hour][data-end-hour]',
      (els) => els.map((el) => ({
        courtId: el.getAttribute('data-court-id'),
        start:   el.getAttribute('data-start-hour'),
        end:     el.getAttribute('data-end-hour'),
      }))
    ).catch(() => []);

    debug.blocksFound = blocks.length;
    debug.rootDivs = await page.$$eval('#__next div', (els) => els.length).catch(() => 0);

    // 5) Normalize + optional duration filter (robust HH:mm + cross-midnight)
    const slots = [];
    for (const b of blocks) {
      const startHH = normHHMM(b.start);
      const endHH   = normHHMM(b.end);
      if (!b.courtId || !startHH || !endHH) continue;

      const st = hmToMin(startHH);
      const en = hmToMin(endHH);
      const dur = ((en - st + 1440) % 1440) || 0;

      if (desiredDuration && dur && dur !== desiredDuration) continue;

      const endYmd = en < st ? addDaysYMD(date, 1) : date; // roll to next day if wraps midnight

      slots.push({
        slug,
        resourceId: b.courtId,
        slotDate: date,
        startLocal: startHH,
        endLocal: endHH,
        startMin: st,
        endMin: en,
        duration: dur || undefined,
        start: new Date(`${date}T${startHH}:00`).toISOString(),
        end:   new Date(`${endYmd}T${endHH}:00`).toISOString(),
      });
    }
    slots.sort((a, b) => a.startMin - b.startMin);

    // Optional screenshot + HTML snippet
    if (wantShot) {
      const shot = await page.screenshot({ fullPage: true }).catch(() => null);
      if (shot) debug.screenshot = Buffer.from(shot).toString('base64');
    }
    const html = await page.content().catch(() => '');
    debug.htmlSnippet = html ? html.slice(0, 2048) : null;

    debug.next = { ok: nextOk, blocked: nextBlocked, failed: reqFailed.slice(0, 10) };

    return res.json({ date, slug, slots, debug });
  } catch (e) {
    debug.next = { ok: nextOk, blocked: nextBlocked, failed: reqFailed.slice(0, 10) };
    return res.status(500).json({ error: 'scrape failed', detail: String(e), debug });
  } finally {
    try { await page?.close(); } catch {}
    try { await context?.close(); } catch {}
  }
});

/* =========================
   Helpers
   ========================= */

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

/* =========================
   Start server
   ========================= */
app.listen(PORT, () => {
  console.log(`Server running on :${PORT} (TZ=${TZ})`);
});
