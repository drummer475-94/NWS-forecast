#!/usr/bin/env node
// Deterministic browser smoke suite for the forecast and NC Status pages.
//
// Runs with plain Node (no package.json in this repo): it starts its own static server, launches Chromium
// through Playwright, and answers every external request (NWS, NOAA, RainViewer, USGS, Zippopotam.us, unpkg)
// from the fixtures in ./fixtures. Any request that is not stubbed is aborted and fails the run.
//
// Environment:
//   PLAYWRIGHT_MODULE_DIR  directory whose node_modules contains `playwright` (default: normal resolution)
//   LEAFLET_DIR            leaflet@1.9.4 `dist` directory (default: resolved next to playwright)
//   SMOKE_SCREENSHOTS=1    save full-page screenshots to SMOKE_SCREENSHOT_DIR (default: <tmpdir>/nws-smoke)
//   CHROMIUM_EXECUTABLE_PATH  use this Chromium binary instead of Playwright's own download
//   SMOKE_VERBOSE=1        also print every console message and stubbed request host

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtureDir = path.join(here, 'fixtures');

const moduleDir = process.env.PLAYWRIGHT_MODULE_DIR;
const nodeRequire = moduleDir
  ? createRequire(path.join(path.resolve(moduleDir), 'resolve-from-here.js'))
  : createRequire(import.meta.url);
const { chromium } = nodeRequire('playwright');
const leafletDir = process.env.LEAFLET_DIR
  ? path.resolve(process.env.LEAFLET_DIR)
  : path.dirname(nodeRequire.resolve('leaflet/dist/leaflet.js'));
const screenshotDir = process.env.SMOKE_SCREENSHOT_DIR || path.join(os.tmpdir(), 'nws-smoke');
const takeScreenshots = process.env.SMOKE_SCREENSHOTS === '1';
const verbose = process.env.SMOKE_VERBOSE === '1';

const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 375, height: 812 },
  { width: 1280, height: 900 }
];

// Console errors that an intentionally failing stub is expected to cause. Browsers log every non-2xx
// subresource response as a console error; each entry must match both the failing URL and the message.
const ALLOWED_CONSOLE_ERRORS = [
  {
    urlIncludes: 'https://api.weather.gov/products/types/AFD/',
    text: /status of 503/,
    reason: 'failure-path scenario returns 503 for the latest forecast discussion'
  },
  {
    urlIncludes: 'https://opengeo.ncep.noaa.gov/',
    text: /status of 503/,
    reason: 'NWS radar service stub returns 503 so the app falls back to RainViewer'
  },
  {
    urlIncludes: 'https://api.zippopotam.us/us/00000',
    text: /status of 404/,
    reason: 'invalid-ZIP stub returns 404'
  }
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// ---------------------------------------------------------------------------------------------------------
// Static server for the repository root

function startStaticServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = path.join(repoRoot, pathname);
      const relative = path.relative(repoRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some((part) => part.startsWith('.'))) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const body = await fs.readFile(file);
      response.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------------------------------------
// Fixtures. `{{now-20m}}` / `{{now+1h}}` become ISO timestamps, `"{{unix-5m}}"` a number of Unix seconds, and
// `{{day+2@10}}` the UTC date two days ahead at 10:00 (hours may exceed 23), all relative to the moment of use.

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const fixtureCache = new Map();

async function readFixtureText(name) {
  if (!fixtureCache.has(name)) fixtureCache.set(name, await fs.readFile(path.join(fixtureDir, name), 'utf8'));
  return fixtureCache.get(name);
}

function stampTimes(text, nowMs) {
  const offset = (sign, amount, unit) => (sign === '-' ? -1 : 1) * Number(amount) * UNIT_MS[unit];
  const midnight = new Date(nowMs);
  midnight.setUTCHours(0, 0, 0, 0);
  return text
    .replace(/"\{\{unix([+-])(\d+)([smhd])\}\}"/g, (_, sign, amount, unit) =>
      String(Math.floor((nowMs + offset(sign, amount, unit)) / 1000)))
    .replace(/\{\{unix([+-])(\d+)([smhd])\}\}/g, (_, sign, amount, unit) =>
      String(Math.floor((nowMs + offset(sign, amount, unit)) / 1000)))
    .replace(/\{\{now([+-])(\d+)([smhd])\}\}/g, (_, sign, amount, unit) =>
      new Date(nowMs + offset(sign, amount, unit)).toISOString())
    .replace(/\{\{day\+(\d+)@(\d+)\}\}/g, (_, days, hours) =>
      new Date(midnight.getTime() + Number(days) * UNIT_MS.d + Number(hours) * UNIT_MS.h).toISOString());
}

async function fixtureJson(name, nowMs = Date.now()) {
  return JSON.parse(stampTimes(await readFixtureText(name), nowMs));
}

async function statusSnapshot(nowMs = Date.now()) {
  const snapshot = await fixtureJson('nc-status-snapshot.json', nowMs);
  const geojson = JSON.parse(await fs.readFile(path.join(repoRoot, 'data', 'nc-counties.geojson'), 'utf8'));
  const overrides = snapshot.powerOverrides || {};
  delete snapshot.powerOverrides;
  snapshot.power = geojson.features
    .map((feature) => ({
      countyFips: String(feature.properties.GEOID),
      countyName: String(feature.properties.NAME).replace(/\s+County$/i, '')
    }))
    .sort((a, b) => a.countyFips.localeCompare(b.countyFips))
    .map((county) => ({
      ...county,
      customersOut: 0,
      customersServed: 50_000,
      ...(overrides[county.countyFips] || {})
    }));
  return snapshot;
}

// ---------------------------------------------------------------------------------------------------------
// External-host stubs

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

function json(route, body, status = 200, contentType = 'application/json') {
  return route.fulfill({
    status,
    headers: { ...CORS, 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function png(route) {
  return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: PNG });
}

async function installStubs(context, baseOrigin, stubState) {
  const hit = (key) => stubState.hits.set(key, (stubState.hits.get(key) || 0) + 1);

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.origin === baseOrigin) {
      if (url.pathname === '/data/nc-status.json') {
        hit('local nc-status.json (fixture)');
        return json(route, await statusSnapshot());
      }
      return route.continue();
    }

    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, OPTIONS' } });
    }

    hit(url.host);

    switch (url.host) {
      case 'unpkg.com': {
        const match = /^\/leaflet@1\.9\.4\/dist\/(.+)$/.exec(url.pathname);
        const file = match && path.join(leafletDir, match[1]);
        if (file && !path.relative(leafletDir, file).startsWith('..')) {
          try {
            return route.fulfill({
              status: 200,
              headers: { ...CORS, 'content-type': MIME[path.extname(file)] || 'application/octet-stream' },
              body: await fs.readFile(file)
            });
          } catch { /* fall through to unstubbed */ }
        }
        break;
      }
      case 'api.zippopotam.us':
        if (url.pathname === '/us/27601') return json(route, await fixtureJson('zippopotam-27601.json'));
        if (url.pathname === '/us/00000') return json(route, {}, 404);
        break;
      case 'api.weather.gov': {
        const p = url.pathname;
        const now = Date.now();
        if (/^\/points\/-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(p)) {
          const point = await fixtureJson('nws-points.json', now);
          if (stubState.pointCounty) point.properties.county = stubState.pointCounty;
          return json(route, point, 200, 'application/geo+json');
        }
        if (p === '/gridpoints/RAH/73,57/forecast') return json(route, await fixtureJson('nws-daily.json', now), 200, 'application/geo+json');
        if (p === '/gridpoints/RAH/73,57/forecast/hourly') return json(route, await fixtureJson('nws-hourly.json', now), 200, 'application/geo+json');
        if (p === '/gridpoints/RAH/73,57') return json(route, await fixtureJson('nws-gridpoint.json', now), 200, 'application/geo+json');
        if (p === '/gridpoints/RAH/73,57/stations') return json(route, await fixtureJson('nws-stations.json', now), 200, 'application/geo+json');
        if (p === '/stations/KRDU/observations/latest') return json(route, await fixtureJson('nws-observation-krdu.json', now), 200, 'application/geo+json');
        if (p === '/stations/KRWI/observations/latest') return json(route, await fixtureJson('nws-observation-krwi.json', now), 200, 'application/geo+json');
        if (p === '/alerts/active' && url.searchParams.has('point')) {
          if (stubState.pointAlerts === 'none') return json(route, { features: [] }, 200, 'application/geo+json');
          const name = stubState.pointAlerts === 'multi' ? 'nws-alerts-point-multi.json' : 'nws-alerts-point.json';
          return json(route, await fixtureJson(name, now), 200, 'application/geo+json');
        }
        if (p === '/alerts/active' && url.searchParams.get('area') === 'NC') return json(route, await fixtureJson('nws-alerts-nc.json', now), 200, 'application/geo+json');
        if (p === '/products/types/AFD/locations/RAH/latest') {
          if (stubState.afdListStatus) { hit('AFD latest (failure stub)'); return json(route, {}, stubState.afdListStatus); }
          hit('AFD product');
          return json(route, await fixtureJson('nws-afd-product.json', now), 200, 'application/geo+json');
        }
        if (p === '/radar/stations') return json(route, await fixtureJson('nws-radar-stations.json', now), 200, 'application/geo+json');
        if (p.startsWith('/icons/')) return png(route);
        break;
      }
      case 'opengeo.ncep.noaa.gov':
        // Intentional failure: the app must fall back to RainViewer.
        hit('NWS radar service (503)');
        return route.fulfill({
          status: 503,
          headers: { ...CORS, 'content-type': 'text/plain' },
          body: 'Service Unavailable (smoke-test stub)'
        });
      case 'api.rainviewer.com':
        if (url.pathname === '/public/weather-maps.json') return json(route, await fixtureJson('rainviewer-weather-maps.json'));
        break;
      case 'tilecache.rainviewer.com':
      case 'basemap.nationalmap.gov':
        return png(route);
      default:
        break;
    }

    stubState.unstubbed.push(`${request.method()} ${request.url()}`);
    return route.abort('blockedbyclient');
  });
}

// ---------------------------------------------------------------------------------------------------------
// Test plumbing

const results = [];
const failuresByViewport = new Map();

function record(viewport, scenario, name, ok, detail) {
  results.push({ viewport, scenario, name, ok, detail });
  const label = `${viewport} ${scenario}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${label}] ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failuresByViewport.set(viewport, (failuresByViewport.get(viewport) || 0) + 1);
}

function makeRunner(viewport, scenario) {
  return async function step(name, fn) {
    try {
      const detail = await fn();
      record(viewport, scenario, name, true, typeof detail === 'string' ? detail : '');
    } catch (error) {
      record(viewport, scenario, name, false, String(error && error.message || error).split('\n')[0]);
    }
  };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectMatch(text, pattern, what) {
  if (!pattern.test(text)) throw new Error(`${what}: ${JSON.stringify(String(text).slice(0, 200))} does not match ${pattern}`);
}

async function newScenarioPage(browser, baseOrigin, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: []
  });
  context.setDefaultTimeout(15_000);
  const stubState = { hits: new Map(), unstubbed: [] };
  await installStubs(context, baseOrigin, stubState);
  const page = await context.newPage();

  const problems = [];
  const net = { phase: 'load', requests: [], sizePromises: [] };
  page.on('pageerror', (error) => problems.push(`uncaught page error: ${error.message}`));
  page.on('crash', () => problems.push('page crashed'));
  page.on('console', (message) => {
    if (verbose) console.log(`      console.${message.type()}: ${message.text()}`);
    if (message.type() !== 'error') return;
    const location = message.location();
    const text = message.text();
    const allowed = ALLOWED_CONSOLE_ERRORS.find((entry) =>
      (location.url || text).includes(entry.urlIncludes) && entry.text.test(text));
    if (!allowed) problems.push(`console error: ${text} (${location.url || 'no url'})`);
  });
  const phaseOf = new WeakMap();
  page.on('request', (request) => {
    const url = new URL(request.url());
    phaseOf.set(request, net.phase);
    net.requests.push({ phase: net.phase, host: url.origin === baseOrigin ? 'local' : url.host, url: request.url() });
  });
  page.on('requestfinished', (request) => {
    if (new URL(request.url()).origin !== baseOrigin) return;
    const phase = phaseOf.get(request) || net.phase;
    net.sizePromises.push(
      request.sizes().then((sizes) => ({ phase, url: new URL(request.url()).pathname, bytes: Math.max(0, sizes.responseBodySize) + Math.max(0, sizes.responseHeadersSize) }))
        .catch(() => ({ phase, url: new URL(request.url()).pathname, bytes: 0 }))
    );
  });
  return { context, page, problems, stubState, net };
}

async function finishScenarioPage(viewportLabel, scenario, handle) {
  const { context, problems, stubState } = handle;
  const step = makeRunner(viewportLabel, scenario);
  await step('no uncaught page errors or unexpected console errors', async () => {
    expect(!problems.length, problems.join(' | '));
  });
  await step('no un-stubbed external requests', async () => {
    expect(!stubState.unstubbed.length, stubState.unstubbed.join(' | '));
  });
  await context.close();
}

async function screenshot(page, name) {
  if (!takeScreenshots) return;
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function scrollMetrics(page) {
  return page.evaluate(() => ({ scrollWidth: document.scrollingElement.scrollWidth, innerWidth: window.innerWidth }));
}

async function expectNoHorizontalScroll(page, where) {
  const metrics = await scrollMetrics(page);
  expect(metrics.scrollWidth <= metrics.innerWidth,
    `horizontal scroll ${where}: scrollWidth ${metrics.scrollWidth} > innerWidth ${metrics.innerWidth}`);
  return `scrollWidth ${metrics.scrollWidth} <= innerWidth ${metrics.innerWidth}`;
}

async function checkThemeToggle(page) {
  const button = page.locator('#themeToggleButton');
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  // The forecast page leaves data-theme unset until the visitor chooses; NC Status pins the OS theme at start.
  expect(before === null || before === 'dark', `expected the dark OS theme initially, got data-theme=${before}`);
  expectEqual(await button.getAttribute('aria-pressed'), 'false', 'aria-pressed before toggle (dark OS scheme)');
  await button.click();
  expectEqual(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', 'data-theme after toggle');
  expectEqual(await button.getAttribute('aria-pressed'), 'true', 'aria-pressed after toggle');
  expectEqual(await page.evaluate(() => window.localStorage.getItem('theme')), 'light', 'persisted theme');
  await page.reload({ waitUntil: 'load' });
  expectEqual(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', 'data-theme after reload');
  expectEqual(await page.locator('#themeToggleButton').getAttribute('aria-pressed'), 'true', 'aria-pressed after reload');
  return 'dark -> light, persisted across reload';
}

// ---------------------------------------------------------------------------------------------------------
// Scenario: forecast page

async function waitForInitialForecastPage(page) {
  await page.waitForFunction(() => {
    const label = document.querySelector('#locationLabel');
    const radar = document.querySelector('#radarStatus');
    return label && label.textContent.trim() !== 'Finding your location' && radar && radar.dataset.state === 'ready';
  });
}

async function waitForRadarReady(page, expectedText) {
  await page.waitForFunction((text) => {
    const radar = document.querySelector('#radarStatus');
    return radar && radar.dataset.state === 'ready' && radar.textContent.trim() === text;
  }, expectedText);
}

async function waitForHits(stubState, key, minimum) {
  const deadline = Date.now() + 15_000;
  while ((stubState.hits.get(key) || 0) < minimum) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${key} (hits: ${stubState.hits.get(key) || 0})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function runForecastScenario(browser, baseOrigin, viewport, perfOut) {
  const label = `${viewport.width}x${viewport.height}`;
  const handle = await newScenarioPage(browser, baseOrigin, viewport);
  const { page, stubState, net } = handle;
  const step = makeRunner(label, 'forecast');

  await step('initial load state renders', async () => {
    await page.goto(`${baseOrigin}/index.html`, { waitUntil: 'load' });
    await waitForInitialForecastPage(page);
    const label = (await page.locator('#locationLabel').textContent()).trim();
    expectMatch(label, /^Manual location needed$/, 'location label (geolocation denied)');
    expectEqual((await page.locator('#currentTemp').textContent()).trim(), '—', 'placeholder temperature');
    expectEqual(await page.locator('#hourlyForecast .hour-card').count(), 0, 'hour cards before a location is chosen');
    expect(await page.locator('#zipLocationForm').isVisible(), 'ZIP form should be visible when location is needed');
    expectEqual((await page.locator('#radarStatus').textContent()).trim(), 'RainViewer HD ready', 'initial radar status');
    expect(await page.locator('.leaflet-container').count() === 1, 'Leaflet map did not initialise');
    return `label "${label}", radar RainViewer HD ready`;
  });

  await step('no horizontal scroll (initial)', () => expectNoHorizontalScroll(page, 'initial'));

  net.phase = 'other'; // theme reload, keyboard and invalid-ZIP checks are not part of the profile numbers
  await step('theme toggle switches data-theme and persists', () => checkThemeToggle(page));

  await step('Tab reaches the ZIP input with a visible focus indicator', async () => {
    await waitForInitialForecastPage(page);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    let reached = false;
    for (let index = 0; index < 40 && !reached; index += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement && document.activeElement.id === 'zipLocation');
    }
    expect(reached, 'Tab never reached #zipLocation within 40 presses');
    // Under prefers-reduced-motion the stylesheet shortens transitions to 0.01 ms rather than removing them, so
    // the first computed value after focus can still be the pre-transition one. Give it a few frames to settle.
    await page.waitForFunction(() => {
      const computed = getComputedStyle(document.activeElement);
      return (computed.outlineStyle !== 'none' && parseFloat(computed.outlineWidth) > 0) || computed.boxShadow !== 'none';
    }, undefined, { timeout: 2000 }).catch(() => {});
    const style = await page.evaluate(() => {
      const computed = getComputedStyle(document.activeElement);
      return {
        outlineStyle: computed.outlineStyle,
        outlineWidth: parseFloat(computed.outlineWidth),
        boxShadow: computed.boxShadow,
        focusVisible: document.activeElement.matches(':focus-visible')
      };
    });
    expect(style.focusVisible, 'ZIP input does not match :focus-visible after keyboard focus');
    expect((style.outlineStyle !== 'none' && style.outlineWidth > 0) || style.boxShadow !== 'none',
      `no visible focus style: ${JSON.stringify(style)}`);
    return `outline ${style.outlineStyle} ${style.outlineWidth}px`;
  });

  await step('invalid ZIP shows an error message', async () => {
    await page.locator('#zipLocation').fill('00000');
    await page.locator('#zipLocation').press('Enter');
    await page.waitForFunction(() => /could not be found/i.test(document.querySelector('#toast').textContent));
    const toast = (await page.locator('#toast').textContent()).trim();
    expect(await page.locator('#zipLocationForm').isVisible(), 'ZIP form should stay open after an invalid ZIP');
    expectEqual(await page.locator('#hourlyForecast .hour-card').count(), 0, 'hour cards after invalid ZIP');
    return toast;
  });

  // Valid ZIP: capture in-page timings from submit to first render of each section.
  net.phase = 'zip';
  const radarHitsBefore = stubState.hits.get('NWS radar service (503)') || 0;
  let timings;
  await step('ZIP 27601 renders hourly and daily forecasts', async () => {
    await page.evaluate(() => {
      const marks = (window.__smokeMarks = {});
      const checks = {
        hourly: () => document.querySelector('#hourlyForecast .hour-card'),
        daily: () => document.querySelector('#dailyForecast .day-card'),
        observed: () => /^Observed /.test(document.querySelector('#currentSource').textContent),
        alerts: () => document.querySelector('#alertsList .alert-card')
      };
      const update = () => {
        for (const [name, test] of Object.entries(checks)) {
          if (marks[name] === undefined && test()) marks[name] = performance.now() - marks.submit;
        }
      };
      document.querySelector('#zipLocationForm').addEventListener('submit', () => {
        marks.submit = performance.now();
        new MutationObserver(update).observe(document.body, { childList: true, subtree: true, characterData: true });
      }, true);
    });
    await page.locator('#zipLocation').fill('27601');
    await page.locator('#zipLocation').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#hourlyForecast .hour-card').length > 0);
    await page.waitForFunction(() => document.querySelectorAll('#dailyForecast .day-card').length > 0);
    expectEqual((await page.locator('#hourlyCount').textContent()).trim(), '24 hours', 'hourly count');
    expectEqual(await page.locator('#hourlyForecast .hour-card').count(), 24, 'hour cards');
    const days = await page.locator('#dailyForecast .day-card').count();
    expectEqual(days, 7, 'day cards');
    expectEqual((await page.locator('#locationLabel').textContent()).trim(), 'Raleigh, NC', 'location label');
    expectMatch((await page.locator('#dailyOffice').textContent()).trim(), /RAH/, 'forecast office');
    return `${days} days, 24 hourly cards`;
  });

  await step('current conditions name the station; null field is labeled Forecast', async () => {
    await page.waitForFunction(() => /^Observed /.test(document.querySelector('#currentSource').textContent));
    await page.waitForFunction(() => document.querySelector('#precipTotal').textContent.trim() !== 'Loading…');
    const source = (await page.locator('#currentSource').textContent()).trim();
    expectMatch(source, /^Observed .* at KRDU \(Raleigh-Durham International Airport\)/, 'current source text');
    expectMatch(source, /Forecast used for humidity\./, 'forecast fallback note');
    expectEqual(await page.locator('#currentSource').getAttribute('data-source'), 'observed', 'current source data-source');
    const humidity = page.locator('#humidity');
    expectMatch((await humidity.textContent()).trim(), /^62% Forecast$/, 'humidity');
    expectEqual((await humidity.locator('.metric-source').textContent()).trim(), 'Forecast', 'humidity source tag');
    expectEqual(await page.locator('#wind .metric-source').count(), 0, 'observed wind must not be tagged Forecast');
    expectEqual(await page.locator('#currentTemp').getAttribute('data-source'), 'observed', 'temperature source');
    expectEqual((await page.locator('#currentTemp').textContent()).trim(), '65', 'observed 18.3 C in F');
    const precip = (await page.locator('#precipTotal').textContent()).trim();
    expect(precip !== '--' && precip !== 'Loading…', `24h precipitation not rendered: ${precip}`);
    return `${source} | humidity ${(await humidity.textContent()).trim()} | precip ${precip}`;
  });

  await step('alerts panel lists the Tornado Warning with an official link', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#alertsList .alert-card').length > 0);
    expect(await page.locator('#alertsPanel').isVisible(), 'alerts panel hidden');
    expectEqual((await page.locator('#alertsCount').textContent()).trim(), '1 active', 'alerts count');
    const card = page.locator('#alertsList .alert-card').first();
    expectMatch(await card.textContent(), /Tornado Warning/, 'alert card');
    const link = card.getByRole('link', { name: 'Official NWS details' });
    expectEqual(await link.count(), 1, 'official link count');
    expectMatch(await link.getAttribute('href'), /^https:\/\/api\.weather\.gov\/alerts\/urn:oid:.*smoke\.tornado$/, 'official link href');
    expectEqual(await link.getAttribute('target'), '_blank', 'link target');
  });

  await step('red warning banner appears', async () => {
    const banner = page.locator('#warningBanner');
    await page.waitForFunction(() => !document.querySelector('#warningBanner').classList.contains('hidden'));
    expectMatch(await banner.textContent(), /Tornado Warning/, 'banner text');
    expectEqual(await banner.getAttribute('role'), 'alert', 'banner role');
    const rgb = await banner.evaluate((node) => getComputedStyle(node).backgroundColor);
    const [r, g, b] = rgb.match(/[\d.]+/g).map(Number);
    expect(r > 200 && r > g * 3 && r > b * 3, `banner background is not red: ${rgb}`);
    return rgb;
  });

  await step('severe weather mode: panel, warning text verbatim, expiry, official link, banner link', async () => {
    await page.waitForFunction(() => !document.querySelector('#severePanel').classList.contains('hidden'));
    await page.waitForFunction(() => /customers without power/.test(document.querySelector('#severeOutageText').textContent));
    expect(await page.locator('#severePanel').isVisible(), 'severe panel hidden');
    expectEqual((await page.locator('#severeHeading').textContent()).trim(), 'Severe weather', 'heading');
    expectMatch(await page.locator('#severeLocation').textContent(), /^Active warnings for Raleigh, NC$/, 'location line');
    const card = page.locator('#severeAlerts .severe-card').first();
    expectEqual((await card.locator('h3').textContent()).trim(), 'Tornado Warning', 'card heading');
    expectMatch(await card.textContent(), /Severity: Extreme.*Urgency: Immediate.*Certainty: Observed/s, 'badges');
    expectMatch(await card.textContent(), /Issued by\s*NWS Raleigh NC/, 'sender');
    expectMatch((await card.locator('.severe-expiry').textContent()).trim(), /^Expires \d{1,2}:\d{2} [AP]M \(in (4[0-5]|3\d) min\)$/, 'expiry format');
    const params = await card.locator('.severe-facts').textContent();
    for (const part of [/Tornado detection\s*OBSERVED/, /Max hail size \(inches\)\s*1\.75/, /Max wind gust\s*60 MPH/, /Thunderstorm damage threat\s*CONSIDERABLE/]) expectMatch(params, part, 'parameter');
    expectEqual(await card.locator('.severe-instruction .severe-text').textContent(),
      'TAKE COVER NOW! Move to a basement or an interior room on the lowest floor of a sturdy building.\nAvoid windows.', 'instruction verbatim');
    expectEqual(await card.locator('.severe-description > .severe-text').textContent(),
      'At 1210 AM EDT, a severe thunderstorm capable of producing a tornado was located near Garner, moving northeast at 30 mph.\n\nHAZARD...Tornado.\n\nSOURCE...Radar indicated rotation. <b>Not markup</b>', 'description verbatim');
    expectEqual(await card.locator('.severe-text b').count(), 0, 'NWS text must not become markup');
    expectEqual(await card.locator('.severe-description').evaluate((node) => node.open), true, 'first warning description starts open');
    expectEqual(await card.locator('.severe-text').first().evaluate((node) => getComputedStyle(node).whiteSpace), 'pre-wrap', 'pre-wrap text');
    const link = card.getByRole('link', { name: 'Official NWS alert' });
    expectMatch(await link.getAttribute('href'), /^https:\/\/api\.weather\.gov\/alerts\/urn:oid:.*smoke\.tornado$/, 'official link');
    expectEqual(await link.getAttribute('rel'), 'noreferrer', 'link rel');
    expectEqual(await page.locator('#warningBanner a').getAttribute('href'), '#severeHeading', 'banner link target');
    expectMatch(await page.locator('#severeAnnouncer').textContent(), /^Severe weather: Tornado Warning in effect/, 'announcement');
    const heading = await page.locator('#severePanel').evaluate((node) => node.nextElementSibling && node.nextElementSibling.className);
    expectMatch(heading, /hero-panel/, 'panel sits directly before the hero');
    // Submitting the ZIP form hides it; focus must move to the panel rather than drop to <body>.
    expectEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'severeHeading', 'focus after ZIP submit');
    return expectNoHorizontalScroll(page, 'severe panel');
  });

  await step('severe weather mode: freshness line and Wake County outage line with link', async () => {
    await page.waitForFunction(() => /Latest radar scan/.test(document.querySelector('#severeFreshness').textContent));
    expectMatch(await page.locator('#severeFreshness').textContent(), /^Alerts checked \d{1,2}:\d{2} [AP]M · Latest radar scan \d{1,2}:\d{2} [AP]M$/, 'freshness line');
    expect(await page.locator('#severeNotice').isHidden(), 'no stale-alerts notice while alerts are current');
    expectMatch(await page.locator('#severeOutageText').textContent(), /^1,234 customers without power in Wake County \(NC Emergency Management, as of \d{1,2}:\d{2} [AP]M\)$/, 'outage line');
    const link = page.locator('#severeOutageLink');
    expectEqual((await link.textContent()).trim(), 'NC outage and alert status', 'outage link text');
    expectEqual(await link.getAttribute('href'), 'status.html', 'outage link href');
    expectEqual(stubState.hits.get('local nc-status.json (fixture)'), 1, 'one snapshot request');
  });

  await step('severe weather mode: radar button scrolls to and focuses the radar heading (mouse and keyboard)', async () => {
    const button = page.locator('#severeRadarButton');
    const box = await button.boundingBox();
    expect(box && box.height >= 44 && box.width >= 44, `radar button tap target ${JSON.stringify(box)}`);
    const radarVisible = () => page.waitForFunction(() => {
      const rect = document.querySelector('#radarHeading').getBoundingClientRect();
      return document.activeElement.id === 'radarHeading' && rect.top >= 0 && rect.top < window.innerHeight;
    }, null, { timeout: 5000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await button.click();
    await radarVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await button.focus();
    await page.keyboard.press('Enter');
    await radarVisible();
    expectEqual(await page.evaluate(() => document.activeElement.id), 'radarHeading', 'focus after keyboard activation');
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  await step('severe weather mode: minimize toggle updates aria-expanded and keeps a compact warning summary', async () => {
    const toggle = page.locator('#severeToggle');
    const box = await toggle.boundingBox();
    expect(box && box.height >= 44, `toggle tap target ${JSON.stringify(box)}`);
    expectEqual(await toggle.getAttribute('aria-expanded'), 'true', 'expanded initially');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#severeToggle').getAttribute('aria-expanded') === 'false');
    expect(await page.locator('#severeBody').isHidden(), 'body hidden when minimized');
    expectMatch(await page.locator('#severeSummary').textContent(), /^Tornado Warning — Expires \d{1,2}:\d{2} [AP]M \(in \d+ min\)$/, 'compact summary');
    expect(await page.locator('#severeHeading').isVisible(), 'heading stays visible');
    expectEqual((await toggle.textContent()).trim(), 'Show details', 'toggle label');
    expectEqual(await page.evaluate(() => document.activeElement.id), 'severeToggle', 'focus stays on the toggle');
    await expectNoHorizontalScroll(page, 'severe panel minimized');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#severeToggle').getAttribute('aria-expanded') === 'true');
    expect(await page.locator('#severeBody').isVisible(), 'body visible again');
  });

  await step('radar falls back to RainViewer and shows the latest scan', async () => {
    await waitForHits(stubState, 'NWS radar service (503)', radarHitsBefore + 1);
    await waitForRadarReady(page, 'RainViewer HD ready');
    const nwsHits = (stubState.hits.get('NWS radar service (503)') || 0) - radarHitsBefore;
    expect(nwsHits >= 1, 'the failing NWS radar stub was never requested');
    const legend = page.locator('#radarLegend');
    expectEqual(await legend.getAttribute('data-source'), 'rainviewer', 'legend source');
    expect(await legend.isVisible(), 'radar legend hidden');
    const freshness = page.locator('#radarFreshness');
    await freshness.waitFor({ state: 'visible' });
    expectMatch((await freshness.textContent()).trim(), /^Latest scan \S+/, 'latest scan text');
    expectMatch((await page.locator('#radarTimestamp').textContent()).trim(), /^Radar .* HD$/, 'radar timestamp');
    expectMatch((await page.locator('#zoomLevel').textContent()).trim(), /\/ 8$/, 'RainViewer zoom limit');
    return `${(await freshness.textContent()).trim()} (NWS stub hit ${nwsHits}x)`;
  });

  net.phase = 'after'; // radar controls and station selection below are measured separately
  await step('radar play/pause toggles', async () => {
    const button = page.locator('#radarPlayButton');
    await page.waitForFunction(() => !document.querySelector('#radarPlayButton').disabled);
    expectEqual((await button.textContent()).trim(), 'Play', 'initial label');
    expectEqual(await button.getAttribute('aria-pressed'), 'false', 'initial aria-pressed');
    const firstFrame = (await page.locator('#radarTimestamp').textContent()).trim();
    await button.focus();
    await button.press('Enter');
    expectEqual((await button.textContent()).trim(), 'Pause', 'label while playing');
    expectEqual(await button.getAttribute('aria-pressed'), 'true', 'aria-pressed while playing');
    await page.waitForFunction((initial) =>
      document.querySelector('#radarTimestamp').textContent.trim() !== initial, firstFrame);
    await button.press('Enter');
    expectEqual((await button.textContent()).trim(), 'Play', 'label after pause');
    expectEqual(await button.getAttribute('aria-pressed'), 'false', 'aria-pressed after pause');
    return 'frame advanced while playing; paused again';
  });

  await step('nearby radar dots: focusable, Enter selects, auto-detect restores', async () => {
    const dots = page.locator('#radarMap path.radar-site-dot');
    await page.waitForFunction(() => document.querySelectorAll('#radarMap path.radar-site-dot').length >= 2);
    const count = await dots.count();
    expect(count >= 2, `expected at least 2 radar dots, found ${count}`);
    const labels = await dots.evaluateAll((nodes) => nodes.map((node) => ({
      label: node.getAttribute('aria-label'), role: node.getAttribute('role'), tabindex: node.getAttribute('tabindex')
    })));
    expect(labels.every((dot) => dot.role === 'button' && dot.tabindex === '0'), `dots are not all keyboard buttons: ${JSON.stringify(labels)}`);
    const autoButton = page.locator('#radarAutoButton');
    expect(await autoButton.count() === 1, 'auto-detect option missing');
    expect(await autoButton.isDisabled(), 'auto-detect should be disabled while already in auto mode');
    expectMatch((await page.locator('#radarChoiceStatus').textContent()).trim(), /^Auto-detect: KRAX/, 'initial choice status');
    expectMatch(await page.locator('#radarPickerHelp').textContent(), /manually selecting a nearby radar dot may give you better coverage/, 'picker help');

    const targetIndex = labels.findIndex((dot) => !/selected|auto-detect choice/.test(dot.label));
    expect(targetIndex >= 0, 'no non-auto radar dot to select');
    const hitsBefore = stubState.hits.get('NWS radar service (503)') || 0;
    const target = dots.nth(targetIndex);
    await target.focus();
    expectEqual(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), labels[targetIndex].label, 'focused dot');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /^Manual selection: /.test(document.querySelector('#radarChoiceStatus').textContent));
    expect(await autoButton.isEnabled(), 'auto-detect should be enabled after a manual selection');
    await waitForHits(stubState, 'NWS radar service (503)', hitsBefore + 1);
    await waitForRadarReady(page, 'RainViewer HD ready');

    await autoButton.focus();
    await autoButton.press('Enter');
    await page.waitForFunction(() => /^Auto-detect: KRAX/.test(document.querySelector('#radarChoiceStatus').textContent));
    expect(await autoButton.isDisabled(), 'auto-detect button should disable again once restored');
    await waitForRadarReady(page, 'RainViewer HD ready');
    return `${count} dots; selected "${labels[targetIndex].label}" by keyboard, then restored auto-detect`;
  });

  await step('forecast discussion shows office and issue time; stays collapsed until opened', async () => {
    await page.waitForFunction(() => /RAH/.test(document.querySelector('#discussionMeta').textContent));
    const meta = (await page.locator('#discussionMeta').textContent()).trim();
    expectMatch(meta, /^NWS .*\(?RAH\)? \u00b7 Issued .*(AM|PM)/, 'discussion meta');
    expectMatch(meta, /5 h ago$/, 'discussion age');
    expectEqual(await page.locator('#discussionDetails').evaluate((node) => node.open), false, 'discussion initially open');
    expectEqual(await page.locator('#discussionBody .discussion-section').count(), 0, 'sections built before opening');
    expect(await page.locator('#discussionNote').isHidden(), 'fresh discussion should not show the old-discussion note');
    return meta;
  });

  await step('discussion opens by keyboard and renders sections plus the original text', async () => {
    const summary = page.locator('#discussionDetails > summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#discussionBody .discussion-section').length >= 4);
    const titles = await page.locator('#discussionBody .discussion-section > summary').allTextContents();
    expectEqual(titles.join('|'), 'WHAT HAS CHANGED|KEY MESSAGES|AVIATION /00Z Friday THROUGH Wednesday/|Original product text', 'section titles');
    const open = await page.locator('#discussionBody .discussion-section').evaluateAll((nodes) => nodes.map((node) => node.open));
    expectEqual(open.join(','), 'false,true,false,false', 'default-open section (KEY MESSAGES)');
    const original = await page.locator('#discussionBody .discussion-original pre').textContent();
    expectMatch(original, /^\n000\nFXUS62 KRAH 082340/, 'original text start');
    expectMatch(original, /SHORT TERM\.\.\.Smith\n$/, 'original text end');
    expectEqual(await page.locator('#discussionBody b').count(), 0, 'fetched text must not become markup');
    expectMatch(await page.locator('#discussionMeta').textContent(), /Raleigh NC \(RAH\)/, 'office name from product text');
    expectEqual(stubState.hits.get('AFD product'), 1, 'one request for the latest discussion');
    // :focus-visible can apply a frame after the key press when earlier steps used the mouse.
    const visible = await page.waitForFunction(() => {
      const node = document.querySelector('#discussionDetails > summary');
      const c = getComputedStyle(node);
      return document.activeElement === node && c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0;
    }, null, { timeout: 2000 }).then(() => true, () => false);
    const style = await summary.evaluate((node) => { const c = getComputedStyle(node); return { focused: document.activeElement === node, outlineStyle: c.outlineStyle, outlineWidth: parseFloat(c.outlineWidth) }; });
    expect(visible, `summary has no visible focus: ${JSON.stringify(style)}`);
    return titles.join(' / ');
  });

  await step('discussion official link and no horizontal overflow when open', async () => {
    const link = page.locator('#discussionSource');
    expectEqual(await link.getAttribute('href'), 'https://forecast.weather.gov/product.php?site=NWS&issuedby=RAH&product=AFD&format=txt&version=1&glossary=0', 'official link href');
    expectEqual(await link.getAttribute('target'), '_blank', 'link target');
    expectEqual(await link.getAttribute('rel'), 'noreferrer', 'link rel');
    await page.locator('#discussionBody .discussion-original > summary').click();
    return expectNoHorizontalScroll(page, 'discussion open');
  });

  await step('data source health: summary pill opens the panel by keyboard and rows report status, age and the radar fallback', async () => {
    const rowText = (key, part) => page.locator(`#sourceHealthList li[data-source="${key}"] ${part}`).textContent();
    await page.waitForFunction(() => document.querySelector('#sourceHealthSummary').textContent.trim() === 'Data sources: all current');
    const pill = page.locator('#sourceHealthSummary');
    expect(await pill.isVisible(), 'summary pill should be visible once data has loaded');
    expectEqual(await pill.getAttribute('data-state'), 'ok', 'pill state');
    expectEqual(await pill.getAttribute('aria-expanded'), 'false', 'pill aria-expanded before opening');
    expect(!(await page.locator('#sourceHealth').evaluate((node) => node.open)), 'panel starts collapsed');
    await pill.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#sourceHealth').open);
    expectEqual(await pill.getAttribute('aria-expanded'), 'true', 'pill aria-expanded after opening');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'sourceHealthToggle');
    expect(await page.locator('#sourceHealthToggle').isVisible(), 'panel summary should be visible');
    for (const key of ['forecast', 'observations', 'precip', 'alerts', 'discussion']) {
      expectEqual((await rowText(key, '.health-status')).trim(), 'Current', `${key} status`);
    }
    for (const key of ['forecast', 'observations', 'alerts', 'discussion', 'radar']) {
      expectMatch(await rowText(key, '.health-facts'), /Data age\s*(\d+ min old|\d+ h( \d+ min)? old|under 1 min old)/, `${key} data age`);
      expectMatch(await rowText(key, '.health-facts'), /Last success\s*\d{1,2}:\d{2}/, `${key} last success clock time`);
    }
    expectEqual((await rowText('radar', '.health-status')).trim(), 'Current', 'radar status');
    expectMatch(await rowText('radar', '.health-detail'), /Fallback active: RainViewer HD \(NWS super-resolution unavailable\)/, 'radar fallback detail');
    expectMatch(await rowText('zip', '.health-name'), /ZIP lookup \(Zippopotam\.us\)/, 'ZIP row listed after use');
    expectEqual((await rowText('zip', '.health-status')).trim(), 'Current', 'ZIP status');
    expectMatch(await page.locator('#sourceHealth .health-legend').textContent(), /provider error.*app error/s, 'legend explains provider vs app');
    expectEqual(await page.locator('#sourceHealthList').evaluate((node) => Boolean(node.closest('[aria-live]'))), false, 'health list is not inside a live region');
    return expectNoHorizontalScroll(page, 'health panel open');
  });

  await step('data source health lists the NC outage snapshot as Current once severe mode used it', async () => {
    expectEqual((await page.locator('#sourceHealthList li[data-source="outages"] .health-name').textContent()).trim(), 'NC outage snapshot', 'outage row name');
    expectEqual((await page.locator('#sourceHealthList li[data-source="outages"] .health-status').textContent()).trim(), 'Current', 'outage row status');
    expectMatch(await page.locator('#sourceHealthList li[data-source="outages"] .health-facts').textContent(), /Data age\s*(\d+ min old|under 1 min old)/, 'outage data age');
  });

  await step('no horizontal scroll (after forecast load)', () => expectNoHorizontalScroll(page, 'after load'));

  await screenshot(page, `forecast-${label}`);

  // Performance numbers for this viewport.
  try {
    timings = await page.evaluate(() => window.__smokeMarks);
    const sizes = await Promise.all(net.sizePromises);
    const summarize = (phase) => {
      const requests = net.requests.filter((entry) => entry.phase === phase);
      const local = requests.filter((entry) => entry.host === 'local');
      return {
        requests: requests.length,
        localRequests: local.length,
        externalStubbedRequests: requests.length - local.length,
        localBytes: sizes.filter((entry) => entry.phase === phase).reduce((sum, entry) => sum + entry.bytes, 0)
      };
    };
    perfOut[label] = {
      msFromSubmitTo: {
        firstHourlyCard: Math.round(timings.hourly),
        dailyCards: Math.round(timings.daily),
        observedConditions: Math.round(timings.observed),
        alertCard: Math.round(timings.alerts)
      },
      initialPageLoad: {
        ...summarize('load'),
        localAssets: sizes.filter((entry) => entry.phase === 'load').map((entry) => `${entry.url} ${entry.bytes}`)
      },
      zipSubmitThroughRadarFallback: summarize('zip'),
      requestsByHostDuringZipLoad: net.requests.filter((entry) => entry.phase === 'zip')
        .reduce((hosts, entry) => ({ ...hosts, [entry.host]: (hosts[entry.host] || 0) + 1 }), {})
    };
  } catch (error) {
    record(label, 'forecast', 'collect performance numbers', false, error.message);
  }

  await finishScenarioPage(label, 'forecast', handle);
}

// ---------------------------------------------------------------------------------------------------------
// Scenario: NC Status page

async function runStatusScenario(browser, baseOrigin, viewport) {
  const label = `${viewport.width}x${viewport.height}`;
  const handle = await newScenarioPage(browser, baseOrigin, viewport);
  const { page } = handle;
  const step = makeRunner(label, 'status');

  async function waitForStatusLoaded() {
    await page.waitForFunction(() =>
      document.querySelectorAll('#countySelect option').length === 100 &&
      document.querySelector('#overallStatusPill').dataset.state === 'fresh' &&
      document.querySelectorAll('#statusMap path.leaflet-interactive').length >= 100);
  }

  await step('loads the fixture snapshot with fresh sources', async () => {
    await page.goto(`${baseOrigin}/status.html`, { waitUntil: 'load' });
    await waitForStatusLoaded();
    expectEqual((await page.locator('#overallStatusPill').textContent()).trim(), 'Sources current', 'overall status');
    expectEqual((await page.locator('#selectedCountyName').textContent()).trim(), 'Wake County', 'default county');
    const power = (await page.locator('#powerFreshness').textContent()).trim();
    expectMatch(power, /^Current /, 'power freshness');
    return `${power}; 100 counties in the list and on the map`;
  });

  await step('Wake County shows its outage count and the county alert', async () => {
    await page.locator('#countySelect').selectOption('37183');
    expectEqual((await page.locator('#selectedCountyName').textContent()).trim(), 'Wake County', 'selected county');
    expectEqual((await page.locator('#powerTotal').textContent()).trim(), '1,234', 'summary outage count');
    expectEqual((await page.locator('#powerDetailTotal').textContent()).trim(), '1,234', 'detail outage count');
    expectEqual((await page.locator('#alertTotal').textContent()).trim(), '1', 'alert total');
    const cards = page.locator('#statusAlertList .status-alert-card');
    expectEqual(await cards.count(), 1, 'county alert cards');
    expectMatch(await cards.first().textContent(), /Flood Watch/, 'county alert');
    const link = cards.first().getByRole('link', { name: 'View official NWS alert' });
    expectMatch(await link.getAttribute('href'), /smoke\.flood$/, 'county alert link');
    expect(!/Special Weather Statement/.test(await page.locator('#statusAlertList').textContent()), 'unmatched alert leaked into the county list');
  });

  await step('unmatched alert is listed separately with its official link', async () => {
    const section = page.locator('#statusUnmatchedAlerts');
    expect(await section.isVisible(), 'unmatched section is hidden');
    expectMatch(await section.textContent(), /1 NWS alert could not be matched to a county/, 'unmatched message');
    const link = section.getByRole('link', { name: /Special Weather Statement .*official NWS details/ });
    expectEqual(await link.count(), 1, 'unmatched alert link');
    expectMatch(await link.getAttribute('href'), /smoke\.unmatched$/, 'unmatched alert href');
  });

  await step('another county does not show the Wake or unmatched alert as a county alert', async () => {
    await page.locator('#countySelect').selectOption('37001');
    expectEqual((await page.locator('#selectedCountyName').textContent()).trim(), 'Alamance County', 'selected county');
    expectEqual((await page.locator('#powerTotal').textContent()).trim(), '0', 'outage count');
    expectEqual(await page.locator('#statusAlertList .status-alert-card').count(), 0, 'county alert cards');
    const text = await page.locator('#statusAlertList').textContent();
    expect(!/Flood Watch|Special Weather Statement/.test(text), `county list still mentions a foreign alert: ${text.trim()}`);
    expectMatch(text, /No active NWS alerts apply to this county/, 'empty county alert copy');
    expectEqual((await page.locator('#alertTotal').textContent()).trim(), '0', 'alert total');
    expect(await page.locator('#statusUnmatchedAlerts').isVisible(), 'unmatched alerts must stay listed for every county');
  });

  await step('no horizontal scroll', () => expectNoHorizontalScroll(page, 'status page'));

  await screenshot(page, `status-${label}`);

  await step('theme toggle switches data-theme and persists', async () => {
    const detail = await checkThemeToggle(page);
    await waitForStatusLoaded();
    await expectNoHorizontalScroll(page, 'status page after reload');
    return detail;
  });

  await finishScenarioPage(label, 'status', handle);
}

// ---------------------------------------------------------------------------------------------------------
// Scenario: the latest forecast discussion fails (503); the rest of the forecast must still render

async function runDiscussionFailureScenario(browser, baseOrigin, viewport) {
  const label = `${viewport.width}x${viewport.height}`;
  const handle = await newScenarioPage(browser, baseOrigin, viewport);
  const { page, stubState } = handle;
  stubState.afdListStatus = 503;
  const step = makeRunner(label, 'discussion-failure');

  await step('forecast renders and the discussion shows an unavailable message with the official link', async () => {
    await page.goto(`${baseOrigin}/index.html`, { waitUntil: 'load' });
    await waitForInitialForecastPage(page);
    await page.locator('#zipLocation').fill('27601');
    await page.locator('#zipLocation').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#dailyForecast .day-card').length > 0);
    await page.waitForFunction(() => /could not be loaded/.test(document.querySelector('#discussionStatus').textContent));
    expectMatch(await page.locator('#discussionStatus').textContent(), /^The forecast discussion for RAH could not be loaded\./, 'unavailable message');
    expect(await page.locator('#discussionDetails').isHidden(), 'details should be hidden when unavailable');
    expect(await page.locator('#discussionSource').isVisible(), 'official link should stay visible');
    expectEqual((await page.locator('#hourlyCount').textContent()).trim(), '24 hours', 'hourly forecast still rendered');
    return expectNoHorizontalScroll(page, 'discussion failure');
  });

  await step('data source health reports the discussion as a provider error, not an app error', async () => {
    await page.waitForFunction(() => /1 issue/.test(document.querySelector('#sourceHealthSummary').textContent));
    const pill = page.locator('#sourceHealthSummary');
    expectEqual((await pill.textContent()).trim(), 'Data sources: 1 issue', 'pill text');
    expectEqual(await pill.getAttribute('data-state'), 'issue', 'pill state');
    await pill.click();
    await page.waitForFunction(() => document.querySelector('#sourceHealth').open);
    const row = page.locator('#sourceHealthList li[data-source="discussion"]');
    expectEqual((await row.locator('.health-status').textContent()).trim(), 'Provider error', 'discussion status');
    expectMatch(await row.locator('.health-detail').textContent(), /HTTP 503 from api\.weather\.gov \u2014 provider problem, not the app/, 'discussion detail');
    expectEqual((await page.locator('#sourceHealthList li[data-source="forecast"] .health-status').textContent()).trim(), 'Current', 'forecast stays current');
    expectEqual((await page.locator('#sourceHealthList li[data-source="radar"] .health-status').textContent()).trim(), 'Current', 'radar stays current');
    return expectNoHorizontalScroll(page, 'health panel with an issue');
  });

  await finishScenarioPage(label, 'discussion-failure', handle);
}

// ---------------------------------------------------------------------------------------------------------
// Scenario: severe weather mode variants (several warnings, no warnings, non-NC location)

async function loadZipForecast(page, baseOrigin) {
  await page.goto(`${baseOrigin}/index.html`, { waitUntil: 'load' });
  await waitForInitialForecastPage(page);
  await page.locator('#zipLocation').fill('27601');
  await page.locator('#zipLocation').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#dailyForecast .day-card').length > 0);
}

async function runSevereVariantsScenario(browser, baseOrigin, viewport) {
  const label = `${viewport.width}x${viewport.height}`;

  const multi = await newScenarioPage(browser, baseOrigin, viewport);
  multi.stubState.pointAlerts = 'multi';
  const step = makeRunner(label, 'severe-variants');
  await step('several warnings: advisories and watches excluded, priority order, only the first description open', async () => {
    await loadZipForecast(multi.page, baseOrigin);
    await multi.page.waitForFunction(() => document.querySelectorAll('#severeAlerts .severe-card').length > 0);
    const events = await multi.page.locator('#severeAlerts .severe-card h3').allTextContents();
    expectEqual(events.join(' | '), 'Tornado Warning | Severe Thunderstorm Warning | Flash Flood Warning', 'warning order');
    const open = await multi.page.locator('#severeAlerts .severe-description').evaluateAll((nodes) => nodes.map((node) => node.open));
    expectEqual(open.join(','), 'true,false,false', 'description open state');
    expectMatch(await multi.page.locator('#severeAlerts .severe-card').nth(1).textContent(), /Max hail size \(inches\)\s*1\.00.*Max wind gust\s*70 MPH/s, 'thunderstorm parameters');
    expectMatch(await multi.page.locator('#severeAlerts .severe-card').nth(2).textContent(), /Flash flood damage threat\s*CONSIDERABLE/, 'flood parameters');
    expectMatch(await multi.page.locator('#severeAnnouncer').textContent(), /Tornado Warning • Severe Thunderstorm Warning • Flash Flood Warning/, 'announcement lists warnings');
    expect(!/Tornado Watch/.test(await multi.page.locator('#severePanel').textContent()), 'watch leaked into severe mode');
    await screenshot(multi.page, `severe-${label}`);
    return expectNoHorizontalScroll(multi.page, 'several warnings');
  });
  await step('several warnings: description toggle state survives a refresh of the same warnings', async () => {
    await multi.page.locator('#severeAlerts .severe-description > summary').first().click();
    await multi.page.locator('#refreshButton').click();
    await multi.page.waitForTimeout(800);
    expectEqual(await multi.page.locator('#severeAlerts .severe-description').first().evaluate((node) => node.open), false, 'closed description stays closed');
  });
  await finishScenarioPage(label, 'severe-variants multi', multi);

  const none = await newScenarioPage(browser, baseOrigin, viewport);
  none.stubState.pointAlerts = 'none';
  await step('no warnings: severe panel and banner stay hidden and no outage snapshot is requested', async () => {
    await loadZipForecast(none.page, baseOrigin);
    await none.page.waitForFunction(() => document.querySelector('#alertsCount').textContent.trim() === 'None');
    expect(await none.page.locator('#severePanel').isHidden(), 'severe panel visible without warnings');
    expect(await none.page.locator('#warningBanner').isHidden(), 'banner visible without warnings');
    expectEqual(none.stubState.hits.get('local nc-status.json (fixture)') || 0, 0, 'snapshot requests');
    expectEqual(await none.page.locator('#sourceHealthList li[data-source="outages"]').count(), 0, 'outage source is listed only after use');
    return expectNoHorizontalScroll(none.page, 'no warnings');
  });
  await finishScenarioPage(label, 'severe-variants none', none);

  const outside = await newScenarioPage(browser, baseOrigin, viewport);
  outside.stubState.pointCounty = 'https://api.weather.gov/zones/county/TXC201';
  await step('non-NC location: warnings shown, outage line says North Carolina only, no snapshot request', async () => {
    await loadZipForecast(outside.page, baseOrigin);
    await outside.page.waitForFunction(() => !document.querySelector('#severePanel').classList.contains('hidden'));
    await outside.page.waitForFunction(() => /North Carolina locations only/.test(document.querySelector('#severeOutageText').textContent));
    expectEqual((await outside.page.locator('#severeOutageText').textContent()).trim(), 'Power outage data is available for North Carolina locations only.', 'unsupported line');
    expect(await outside.page.locator('#severeOutageLink').isHidden(), 'status link hidden for non-NC');
    expectEqual(outside.stubState.hits.get('local nc-status.json (fixture)') || 0, 0, 'snapshot requests');
  });
  await finishScenarioPage(label, 'severe-variants outside NC', outside);
}

// ---------------------------------------------------------------------------------------------------------
// Main

const server = await startStaticServer();
const baseOrigin = `http://127.0.0.1:${server.address().port}`;
console.log(`Smoke suite: serving ${repoRoot} at ${baseOrigin}`);
console.log(`Leaflet: ${leafletDir}`);

const perf = {};
let browser;
try {
  browser = await chromium.launch(
    process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}
  );
  console.log(`Chromium ${browser.version()}`);
  for (const viewport of VIEWPORTS) {
    for (const scenario of [runForecastScenario, runDiscussionFailureScenario, runSevereVariantsScenario, runStatusScenario]) {
      try {
        await scenario(browser, baseOrigin, viewport, perf);
      } catch (error) {
        record(`${viewport.width}x${viewport.height}`, scenario.name, 'scenario crashed', false, error.stack || error.message);
      }
    }
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const failed = results.filter((entry) => !entry.ok);
console.log('\nPerformance (forecast page, stubbed upstreams; Task 8 profiling baseline)');
console.log(JSON.stringify(perf, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed across ${VIEWPORTS.length} viewports`);
if (failed.length) {
  console.log('Failures:');
  for (const entry of failed) console.log(`  [${entry.viewport} ${entry.scenario}] ${entry.name}: ${entry.detail}`);
  process.exitCode = 1;
}
