'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const appPath = path.join(projectRoot, 'app.js');
const indexPath = path.join(projectRoot, 'index.html');

function createElement() {
  const classes = new Set();
  return {
    addEventListener() {},
    append() {},
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      contains(name) { return classes.has(name); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !classes.has(name) : force;
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      }
    },
    dataset: {},
    disabled: false,
    replaceChildren() {},
    setAttribute() {},
    style: {},
    textContent: '',
    title: '',
    value: ''
  };
}

function loadAppForTesting() {
  const elements = new Map();
  const document = {
    addEventListener() {},
    createDocumentFragment() { return createElement(); },
    createElement() { return createElement(); },
    hidden: false,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createElement());
      return elements.get(selector);
    }
  };
  const window = {
    addEventListener() {},
    cancelAnimationFrame() {},
    clearTimeout,
    requestAnimationFrame() { return 1; },
    setTimeout
  };
  const sandbox = {
    AbortController,
    console: { error() {}, log() {}, warn() {} },
    document,
    DOMException,
    navigator: { onLine: true },
    performance,
    URL,
    window
  };
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(appPath, 'utf8') + `
    ;globalThis.__weatherTestApi = {
      calculate24HourPrecip,
      calculateFeelsLike,
      distanceMiles,
      escapeHtml,
      fetchJson,
      formatDistance,
      formatHour,
      formatPrecipTotal,
      formatTemperature,
      getQuantValue,
      getRadarFrames,
      isValidCoordinates,
      mergeDailyPeriods,
      normalizeRadarStation,
      normalizeTimeZone,
      parseIsoDuration,
      parseRadarCatalog,
      parseValidTime,
      parseWindMph,
      renderAlerts,
      safeHttpsOrigin,
      safeUrl,
      state,
      toDateKey
    };
  `;
  vm.runInContext(source, context, { filename: appPath });
  return { api: context.__weatherTestApi, context, elements };
}

test('index keeps every JavaScript element hook unique and present', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const source = fs.readFileSync(appPath, 'utf8');
  const ids = Array.from(html.matchAll(/\bid=["']([^"']+)["']/g), (match) => match[1]);
  const selectorIds = Array.from(
    source.matchAll(/document\.querySelector\(["']#([^"']+)["']\)/g),
    (match) => match[1]
  );

  assert.equal(new Set(ids).size, ids.length, 'index.html contains a duplicate id');
  assert.ok(selectorIds.length > 0, 'app.js should declare DOM hooks');
  for (const id of selectorIds) {
    assert.ok(ids.includes(id), `index.html is missing #${id}, which app.js requires`);
  }
});

test('index keeps core accessibility relationships valid', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const ids = new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g), (match) => match[1]));
  const headings = Array.from(html.matchAll(/<h1\b/gi));

  assert.match(html, /<html\b[^>]*\blang=["'][^"']+["']/i);
  assert.match(html, /<main\b/i);
  assert.equal(headings.length, 1, 'index.html should contain exactly one h1');

  for (const match of html.matchAll(/<label\b[^>]*\bfor=["']([^"']+)["'][^>]*>/gi)) {
    assert.ok(ids.has(match[1]), `label points to missing #${match[1]}`);
  }
  for (const match of html.matchAll(/\baria-(?:controls|describedby|labelledby)=["']([^"']+)["']/gi)) {
    for (const id of match[1].trim().split(/\s+/)) {
      assert.ok(ids.has(id), `ARIA relationship points to missing #${id}`);
    }
  }
  for (const match of html.matchAll(/<button\b[^>]*>/gi)) {
    assert.match(match[0], /\btype=["'](?:button|submit|reset)["']/i, 'button is missing an explicit type');
  }
  for (const match of html.matchAll(/<a\b[^>]*\btarget=["']_blank["'][^>]*>/gi)) {
    assert.match(match[0], /\brel=["'][^"']*\b(?:noopener|noreferrer)\b[^"']*["']/i);
  }
});

test('index references local assets that exist in the repository', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const references = Array.from(
    html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g),
    (match) => match[1]
  ).filter((reference) =>
    !reference.startsWith('#') &&
    !reference.startsWith('data:') &&
    !/^[a-z][a-z\d+.-]*:/i.test(reference)
  );

  for (const reference of references) {
    const cleanPath = reference.split(/[?#]/, 1)[0];
    assert.ok(
      fs.existsSync(path.join(projectRoot, cleanPath)),
      `index.html references missing local asset ${cleanPath}`
    );
  }
});

test('pinned Leaflet CDN assets keep official subresource integrity hashes', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const tags = Array.from(html.matchAll(/<(?:link|script)\b[^>]+>/gi), (match) => match[0]);
  const assets = [
    {
      integrity: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=',
      url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
    },
    {
      integrity: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=',
      url: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
    }
  ];

  for (const asset of assets) {
    const tag = tags.find((candidate) => candidate.includes(asset.url));
    assert.ok(tag, `index.html is missing ${asset.url}`);
    assert.ok(tag.includes(`integrity="${asset.integrity}"`), `${asset.url} has the wrong integrity hash`);
    assert.match(tag, /\bcrossorigin=["'][^"']*["']/i, `${asset.url} is missing crossorigin`);
  }
});

test('ISO durations and valid-time intervals are parsed precisely', () => {
  const { api } = loadAppForTesting();
  assert.equal(api.parseIsoDuration('PT1H30M'), 90 * 60 * 1000);
  assert.equal(api.parseIsoDuration('P1DT2H3M4S'), 93_784_000);
  assert.ok(Number.isNaN(api.parseIsoDuration('P1W')));
  assert.ok(Number.isNaN(api.parseIsoDuration('P')));
  assert.ok(Number.isNaN(api.parseIsoDuration('PT')));

  const interval = api.parseValidTime('2026-07-31T12:00:00Z/PT6H');
  assert.equal(interval.end - interval.start, 6 * 60 * 60 * 1000);
  assert.equal(api.parseValidTime('not-a-date/PT1H'), null);
  assert.equal(api.parseValidTime('2026-07-31T12:00:00Z/PT0H'), null);
  assert.equal(api.parseValidTime('2026-07-31T12:00:00Z/PT1H/extra'), null);
});

test('24-hour precipitation prorates overlaps and ignores unusable values', () => {
  const { api } = loadAppForTesting();
  const start = Date.parse('2026-07-31T12:00:00Z');
  const properties = {
    quantitativePrecipitation: {
      values: [
        { validTime: '2026-07-31T06:00:00Z/PT12H', value: 12 },
        { validTime: '2026-07-31T18:00:00Z/PT12H', value: 8 },
        { validTime: '2026-08-01T08:00:00Z/PT8H', value: 8 },
        { validTime: 'invalid', value: 100 },
        { validTime: '2026-07-31T12:00:00Z/PT1H', value: -3 }
      ]
    }
  };

  assert.equal(api.calculate24HourPrecip(properties, start), 18);
  assert.ok(Number.isNaN(api.calculate24HourPrecip({}, start)));
  assert.ok(Number.isNaN(api.calculate24HourPrecip({
    quantitativePrecipitation: {
      values: [{ validTime: '2026-07-31T12:00:00Z/PT1H', value: null }]
    }
  }, start)));
  assert.equal(api.calculate24HourPrecip({
    quantitativePrecipitation: {
      values: [{ validTime: '2026-07-31T12:00:00Z/PT24H', value: 0 }]
    }
  }, start), 0);
});

test('weather unit formatting handles metric input and unavailable values', () => {
  const { api } = loadAppForTesting();
  assert.equal(api.getQuantValue(0), 0);
  assert.ok(Number.isNaN(api.getQuantValue(null)));
  assert.equal(api.formatTemperature(0, 'wmoUnit:degC'), '32°');
  assert.equal(api.formatDistance(1609.344, 'wmoUnit:m'), '1.0 mi');
  assert.equal(api.formatDistance(1.609344, 'wmoUnit:km'), '1.0 mi');
  assert.equal(api.formatDistance(-1, 'wmoUnit:m'), '--');
  assert.equal(api.formatPrecipTotal(25.4), '1.00 in');
  assert.equal(api.formatPrecipTotal(0.1), '<0.01 in');
  assert.equal(api.formatTemperature(NaN, 'wmoUnit:degC'), '--');
});

test('coordinates and forecast time zones are validated', () => {
  const { api } = loadAppForTesting();
  assert.equal(api.isValidCoordinates(90, 180), true);
  assert.equal(api.isValidCoordinates(-90, -180), true);
  assert.equal(api.isValidCoordinates(90.0001, 0), false);
  assert.equal(api.isValidCoordinates(0, -180.0001), false);
  assert.equal(api.isValidCoordinates('not-a-number', 0), false);
  assert.equal(api.isValidCoordinates('', ''), false);
  assert.equal(api.isValidCoordinates(null, null), false);
  assert.equal(api.isValidCoordinates(true, false), false);

  assert.equal(api.normalizeTimeZone(' America/Los_Angeles '), 'America/Los_Angeles');
  assert.equal(api.normalizeTimeZone('Not/A_Time_Zone'), '');
  assert.equal(api.normalizeTimeZone(''), '');
});

test('forecast dates stay on the NWS-local calendar day', () => {
  const { api } = loadAppForTesting();
  assert.equal(api.toDateKey('2026-01-01T23:00:00-08:00'), '2026-01-01');
  assert.equal(api.toDateKey('2026-02-30T12:00:00-08:00'), '');
  assert.equal(api.toDateKey('not-a-date'), '');

  const days = api.mergeDailyPeriods([
    {
      detailedForecast: 'Sunny.',
      icon: 'https://api.weather.gov/icons/day',
      isDaytime: true,
      startTime: '2026-01-01T23:00:00-08:00',
      temperature: 62
    },
    {
      detailedForecast: 'Clear.',
      icon: 'https://api.weather.gov/icons/night',
      isDaytime: false,
      startTime: '2026-01-01T01:00:00-08:00',
      temperature: 41
    }
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].dateKey, '2026-01-01');
  assert.equal(days[0].high, 62);
  assert.equal(days[0].low, 41);

  api.state.timeZone = 'America/Los_Angeles';
  assert.match(api.formatHour('2026-01-02T07:00:00Z'), /11\s*PM/i);
  assert.equal(api.formatHour('not-a-date'), '--');
});

test('an alert-provider failure is not reported as zero active alerts', () => {
  const { api, elements } = loadAppForTesting();
  api.renderAlerts(null);
  assert.equal(elements.get('#alertsCount').textContent, 'Unavailable');
  assert.match(elements.get('#alertsList').innerHTML, /could not be checked/i);

  api.renderAlerts([]);
  assert.equal(elements.get('#alertsCount').textContent, 'None');
  assert.match(elements.get('#alertsList').innerHTML, /No active watches or warnings/i);
});

test('feels-like calculations use mean sustained wind and weather thresholds', () => {
  const { api } = loadAppForTesting();
  assert.equal(api.parseWindMph('5 to 15 mph'), 10);
  assert.equal(api.parseWindMph('5.5 to 10.5 mph'), 8);
  assert.ok(api.calculateFeelsLike(95, 60, '5 mph') > 95);
  assert.ok(api.calculateFeelsLike(30, 70, '10 mph') < 30);
  assert.equal(api.calculateFeelsLike(70, 50, '10 mph'), 70);
});

test('untrusted URLs, markup, and radar frame paths are constrained', () => {
  const { api } = loadAppForTesting();
  assert.equal(api.safeUrl('https://api.weather.gov/icons/test'), 'https://api.weather.gov/icons/test');
  assert.equal(api.safeUrl('javascript:alert(1)'), '');
  assert.equal(api.safeUrl('http://example.com/icon.png'), '');
  assert.equal(api.safeHttpsOrigin('https://tilecache.rainviewer.com/path'), 'https://tilecache.rainviewer.com');
  assert.equal(api.safeHttpsOrigin('http://tilecache.rainviewer.com'), '');
  assert.equal(api.escapeHtml('<img src=x onerror="bad">'), '&lt;img src=x onerror=&quot;bad&quot;&gt;');

  const frames = api.getRadarFrames({
    radar: {
      past: [
        { time: 1, path: '/v2/radar/1' },
        { time: 2, path: 'https://evil.example/radar' },
        { time: 'bad', path: '/v2/radar/3' }
      ]
    }
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].path, '/v2/radar/1');
});

test('radar catalog parsing filters invalid and non-WSR-88D stations', () => {
  const { api } = loadAppForTesting();
  assert.equal(api.normalizeRadarStation(' ktlx '), 'KTLX');
  assert.equal(api.normalizeRadarStation('bad!'), '');

  const catalog = api.parseRadarCatalog({
    features: [
      {
        geometry: { coordinates: [-97.277, 35.333] },
        properties: { id: 'KTLX', name: 'Oklahoma City', stationType: 'WSR-88D' }
      },
      {
        geometry: { coordinates: [-97, 35] },
        properties: { id: 'TEST', name: 'Test station', stationType: 'TDWR' }
      },
      {
        geometry: { coordinates: ['bad', 35] },
        properties: { id: 'KXXX', name: 'Broken', stationType: 'WSR-88D' }
      }
    ]
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].id, 'KTLX');
  assert.ok(api.distanceMiles(35.333, -97.277, 35.333, -97.277) < 0.001);
});

test('fetch helper sends the NWS Accept header and preserves HTTP status', async () => {
  const { api, context } = loadAppForTesting();
  let receivedOptions;
  context.fetch = async (_url, options) => {
    receivedOptions = options;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  assert.equal((await api.fetchJson('https://api.weather.gov/points/0,0')).ok, true);
  assert.equal(receivedOptions.headers.Accept, 'application/geo+json');

  context.fetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(
    api.fetchJson('https://api.weather.gov/points/0,0'),
    (error) => error.status === 429
  );
});
