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
    contains() { return false; },
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
    querySelectorAll() { return []; },
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
    setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer; }
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
      classifySourceError,
      createSourceHealth,
      fetchResource,
      getSourceFreshness,
      getSourceHealthRows,
      markSourceFailure,
      markSourcePending,
      markSourceSuccess,
      providerError,
      recordObservationHealth,
      summarizeSourceHealth,
      discussionSourceUrl,
      readDiscussionProduct,
      parseDiscussionSections,
      distanceMiles,
      distanceToMiles,
      ensureRadarLayer,
      getMeasuredValue,
      handleVisibilityChange,
      isRadarAnimating,
      loadLatestObservation,
      readObservation,
      reconcileRadarFrames,
      refreshRadarFrames,
      renderRadarFrame,
      resolveCurrentConditions,
      resumeRadarRefresh,
      scheduleRadarRefresh,
      setCurrentUnavailable,
      startRadarAnimation,
      toFahrenheit,
      toMph,
      updateCurrent,
      updateRadarFreshness,
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
      loadForecast,
      getThreatWarnings,
      refreshLocationAlerts,
      renderWarningBanner,
      renderSevereMode,
      buildSevereFreshness,
      formatSevereTime,
      toggleSevereMinimized,
      safeHttpsOrigin,
      safeUrl,
      state,
      toDateKey
    };
  `;
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'severe-weather.js'), 'utf8'), context, { filename: 'severe-weather.js' });
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

function warning(overrides = {}) {
  return { properties: { event: 'Tornado Warning', status: 'Actual', messageType: 'Alert',
    effective: new Date(Date.now() - 60000).toISOString(),
    expires: new Date(Date.now() + 60000).toISOString(), ...overrides } };
}

test('threat banner only accepts active actual tornado and flash flood warnings', () => {
  const { api } = loadAppForTesting();
  const features = [warning(), warning({ event: 'Flash Flood Warning' }),
    warning({ event: 'Tornado Watch' }), warning({ event: 'Flood Warning' }),
    warning({ status: 'Test' }), warning({ messageType: 'Cancel' }),
    warning({ expires: new Date(Date.now() - 1).toISOString() }),
    warning({ effective: new Date(Date.now() + 60000).toISOString() }),
    warning({ expires: 'invalid' }), null];
  assert.deepEqual(Array.from(api.getThreatWarnings(features, Date.now()), a => a.event),
    ['Tornado Warning', 'Flash Flood Warning']);
});

test('alert list uses the same active rule as the banner and links official details', () => {
  const { api, elements } = loadAppForTesting();
  api.renderAlerts([warning({ event: 'Flood Watch', '@id': 'https://api.weather.gov/alerts/abc' }),
    warning({ event: 'Flood Warning', status: 'Exercise' }), warning({ event: 'Wind Warning', messageType: 'Cancel' }),
    warning({ event: 'Heat Warning', ends: new Date(Date.now() - 1).toISOString() })]);
  assert.equal(elements.get('#alertsCount').textContent, '1 active');
});

test('banner escapes upstream text, retains warnings on failure, and clears on empty results', () => {
  const { api, elements } = loadAppForTesting();
  api.renderAlerts([warning({ headline: '<img src=x onerror=alert(1)>' })]);
  const banner = elements.get('#warningBanner');
  assert.equal(banner.classList.contains('hidden'), false);
  assert.match(banner.innerHTML, /&lt;img/);
  api.renderAlerts(null);
  assert.match(banner.innerHTML, /Updates unavailable/);
  api.state.warningFeatures = [warning({ expires: new Date(Date.now() - 1).toISOString() })];
  api.renderWarningBanner();
  assert.equal(banner.classList.contains('hidden'), true);
  api.renderAlerts([]);
  assert.equal(banner.innerHTML, '');
});

test('late alert responses for a previous location cannot replace current warnings', async () => {
  const { api, context, elements } = loadAppForTesting();
  api.state.lat = 35; api.state.lon = -97;
  vm.runInContext('globalThis.pendingAlerts = []; fetchJson = function(url) { return new Promise(resolve => pendingAlerts.push({ url, resolve })); };', context);
  const first = api.refreshLocationAlerts();
  api.state.lat = 36;
  const second = api.refreshLocationAlerts();
  assert.match(context.pendingAlerts[1].url, /point=36,-97$/);
  context.pendingAlerts[1].resolve({ features: [warning({ event: 'Flash Flood Warning' })] });
  await second;
  context.pendingAlerts[0].resolve({ features: [warning()] });
  await first;
  assert.match(elements.get('#warningBanner').innerHTML, /Flash Flood Warning/);
  assert.doesNotMatch(elements.get('#warningBanner').innerHTML, /Tornado Warning/);
});

test('loading a new location starts alerts even when point metadata fails', async () => {
  const { api, context, elements } = loadAppForTesting();
  vm.runInContext("globalThis.alertCoordinates = []; refreshLocationAlerts = function() { alertCoordinates.push([state.lat, state.lon]); }; fetchJson = async function() { throw new Error('unavailable'); };", context);
  api.renderAlerts([warning()]);
  await api.loadForecast(35, -97);
  assert.equal(context.alertCoordinates.length, 1);
  assert.deepEqual(Array.from(context.alertCoordinates[0]), [35, -97]);
  assert.equal(elements.get('#warningBanner').classList.contains('hidden'), true);
});

// ---------------------------------------------------------------------------
// Forecast loading: progressive enhancement and stale-response protection
// ---------------------------------------------------------------------------

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

function quantity(value, unitCode, qualityControl = 'V') {
  return { qualityControl, unitCode, value };
}

function observationProperties(overrides = {}) {
  return {
    dewpoint: quantity(10, 'wmoUnit:degC'),
    relativeHumidity: quantity(55, 'wmoUnit:percent'),
    temperature: quantity(25, 'wmoUnit:degC'),
    textDescription: 'Clear',
    timestamp: minutesAgo(10),
    visibility: quantity(16093.44, 'wmoUnit:m'),
    windDirection: quantity(315, 'wmoUnit:degree_(angle)'),
    windGust: quantity(null, 'wmoUnit:km_h-1', 'Z'),
    windSpeed: quantity(18, 'wmoUnit:km_h-1'),
    ...overrides
  };
}

function hourlyPeriod(overrides = {}) {
  return {
    dewpoint: quantity(15, 'wmoUnit:degC'),
    icon: 'https://api.weather.gov/icons/land/day/skc?size=medium',
    probabilityOfPrecipitation: quantity(20, 'wmoUnit:percent'),
    relativeHumidity: quantity(50, 'wmoUnit:percent'),
    shortForecast: 'Mostly Sunny',
    startTime: '2026-10-09T12:00:00-04:00',
    temperature: 70,
    temperatureUnit: 'F',
    windDirection: 'SW',
    windSpeed: '5 to 10 mph',
    ...overrides
  };
}

// Location A is 35,-97 and location B is 36,-98. Hooks keyed "A:stations" and the
// like may supply a value, an { __status } failure, or a promise for either.
function installForecastFetch(context, hooks = {}) {
  const calls = [];
  const data = {
    A: { forecastTemp: 70, observedC: 25, observedF: 77 },
    B: { forecastTemp: 50, observedC: 5, observedF: 41 }
  };
  context.fetch = (rawUrl) => {
    const url = String(rawUrl);
    calls.push(url);
    let tag;
    let kind;
    let match;
    if ((match = /\/points\/(\d+),/.exec(url))) {
      tag = match[1] === '35' ? 'A' : 'B';
      kind = 'points';
    } else if ((match = /nws\.test\/(\w)\/(\w+)/.exec(url))) {
      tag = match[1];
      kind = match[2];
    } else if ((match = /stations\/K(\w)\1\1\/observations\/latest/.exec(url))) {
      tag = match[1];
      kind = 'observation';
    } else if (/alerts\/active/.test(url)) {
      tag = 'A';
      kind = 'alerts';
    }
    const unit = data[tag];
    const defaults = !unit ? null : {
      alerts: { features: [] },
      daily: { properties: { updated: '2026-10-09T12:00:00-04:00', periods: [{
        detailedForecast: 'Sunny.', icon: 'https://api.weather.gov/icons/land/day/skc?size=medium',
        isDaytime: true, startTime: '2026-10-09T06:00:00-04:00', temperature: 75 }] } },
      grid: { properties: { quantitativePrecipitation: { values: [
        { validTime: new Date().toISOString().slice(0, 19) + 'Z/PT48H', value: 25.4 }] } } },
      hourly: { properties: { generatedAt: '2026-10-09T12:00:00-04:00', periods: [
        hourlyPeriod({ temperature: unit.forecastTemp }), hourlyPeriod({ temperature: unit.forecastTemp + 1 })] } },
      observation: { properties: observationProperties({
        temperature: quantity(unit.observedC, 'wmoUnit:degC') }) },
      points: { properties: {
        cwa: 'OFF' + tag, forecast: 'https://nws.test/' + tag + '/daily',
        forecastGridData: 'https://nws.test/' + tag + '/grid',
        forecastHourly: 'https://nws.test/' + tag + '/hourly',
        observationStations: 'https://nws.test/' + tag + '/stations',
        radarStation: 'K' + tag + tag + tag, timeZone: 'America/New_York',
        relativeLocation: { properties: { city: 'City' + tag, state: 'NC' } } } },
      stations: { features: [{ properties: {
        name: 'Station ' + tag, stationIdentifier: 'K' + tag + tag + tag } }] }
    }[kind];
    const hook = hooks[tag + ':' + kind];
    const body = hook === undefined ? (defaults || { __status: 404 }) : hook;
    return Promise.resolve(body).then((value) => (value && value.__status
      ? { ok: false, status: value.__status }
      : { ok: true, json: async () => value }));
  };
  return calls;
}

test('a slow station observation does not delay hourly and daily rendering', async () => {
  const { api, context, elements } = loadAppForTesting();
  const stations = deferred();
  const grid = deferred();
  installForecastFetch(context, { 'A:grid': grid.promise, 'A:stations': stations.promise });

  await api.loadForecast(35, -97);

  assert.equal(elements.get('#hourlyCount').textContent, '2 hours');
  assert.equal(elements.get('#dailyOffice').textContent, 'OFFA office');
  assert.equal(String(elements.get('#currentTemp').textContent), '70');
  assert.match(elements.get('#currentSource').textContent, /^Forecast for this hour\./);
  assert.match(elements.get('#currentSource').textContent, /Checking nearby station observations/);
  assert.equal(elements.get('#precipTotal').textContent, 'Loading…');

  stations.resolve({ features: [{ properties: { name: 'Station A', stationIdentifier: 'KAAA' } }] });
  grid.resolve({ properties: { quantitativePrecipitation: { values: [
    { validTime: new Date().toISOString().slice(0, 19) + 'Z/PT48H', value: 50.8 }] } } });
  await api.state.forecastLoad.optional;

  assert.equal(String(elements.get('#currentTemp').textContent), '77');
  assert.match(elements.get('#currentSource').textContent, /^Observed 10 min ago at KAAA \(Station A\)/);
  assert.equal(elements.get('#precipTotal').textContent, '1.00 in');
  assert.equal(elements.get('#hourlyCount').textContent, '2 hours');
});

test('failed observation and precipitation requests still leave a rendered forecast', async () => {
  const { api, context, elements } = loadAppForTesting();
  installForecastFetch(context, { 'A:stations': { __status: 404 }, 'A:grid': { __status: 404 } });

  await api.loadForecast(35, -97);
  await api.state.forecastLoad.optional;

  assert.equal(elements.get('#hourlyCount').textContent, '2 hours');
  assert.equal(String(elements.get('#currentTemp').textContent), '70');
  assert.match(elements.get('#currentSource').textContent, /No recent station observation was available/);
  assert.equal(elements.get('#precipTotal').textContent, '--');
  assert.equal(elements.get('#currentSource').dataset.source, 'forecast');
});

test('a late response for location A cannot overwrite location B', async () => {
  const { api, context, elements } = loadAppForTesting();
  const hourlyA = deferred();
  const stationsA = deferred();
  const calls = installForecastFetch(context, {
    'A:hourly': hourlyA.promise,
    'A:stations': stationsA.promise
  });

  const loadA = api.loadForecast(35, -97);
  await flush();
  await api.loadForecast(36, -98);
  await api.state.forecastLoad.optional;
  assert.equal(String(elements.get('#currentTemp').textContent), '41');
  assert.equal(api.state.city, 'CityB, NC');
  assert.equal(api.state.office, 'OFFB');

  hourlyA.resolve({ properties: { generatedAt: '2026-10-09T12:00:00-04:00', periods: [
    hourlyPeriod({ temperature: 99 }), hourlyPeriod({ temperature: 99 }), hourlyPeriod({ temperature: 99 })] } });
  stationsA.resolve({ features: [{ properties: { name: 'Station A', stationIdentifier: 'KAAA' } }] });
  await loadA;
  await flush();

  assert.equal(String(elements.get('#currentTemp').textContent), '41');
  assert.equal(elements.get('#hourlyCount').textContent, '2 hours');
  assert.equal(api.state.city, 'CityB, NC');
  assert.match(elements.get('#currentSource').textContent, /KBBB/);
  assert.equal(calls.filter((url) => /observations\/latest/.test(url) && /KAAA/.test(url)).length, 0);
});

test('a slow point lookup for location A is ignored once B has loaded', async () => {
  const { api, context, elements } = loadAppForTesting();
  const pointsA = deferred();
  const calls = installForecastFetch(context, { 'A:points': pointsA.promise });

  const loadA = api.loadForecast(35, -97);
  await api.loadForecast(36, -98);
  await api.state.forecastLoad.optional;
  pointsA.resolve({ properties: { cwa: 'OFFA', forecast: 'https://nws.test/A/daily',
    forecastHourly: 'https://nws.test/A/hourly', observationStations: 'https://nws.test/A/stations' } });
  await loadA;

  assert.equal(api.state.office, 'OFFB');
  assert.equal(String(elements.get('#currentTemp').textContent), '41');
  assert.equal(calls.some((url) => url.includes('nws.test/A/hourly')), false);
});

// ---------------------------------------------------------------------------
// Current conditions: observed vs forecast values
// ---------------------------------------------------------------------------

test('unit conversions for observed values are exact', () => {
  const { api } = loadAppForTesting();
  assert.equal(api.toFahrenheit(0, 'wmoUnit:degC'), 32);
  assert.equal(api.toFahrenheit(100, 'wmoUnit:degC'), 212);
  assert.equal(api.toFahrenheit(273.15, 'wmoUnit:K'), 32);
  assert.equal(api.toFahrenheit(70, 'wmoUnit:degF'), 70);
  assert.ok(Number.isNaN(api.toFahrenheit(5, 'wmoUnit:mystery')));
  assert.ok(Math.abs(api.toMph(16.09344, 'wmoUnit:km_h-1') - 10) < 1e-9);
  assert.ok(Math.abs(api.toMph(10, 'wmoUnit:m_s-1') - 22.369363) < 1e-5);
  assert.ok(Math.abs(api.toMph(10, 'wmoUnit:kt') - 11.507794) < 1e-5);
  assert.ok(Number.isNaN(api.toMph(10, '')));
  assert.ok(Math.abs(api.distanceToMiles(16093.44, 'wmoUnit:m') - 10) < 1e-9);
  assert.ok(Math.abs(api.distanceToMiles(16.09344, 'wmoUnit:km') - 10) < 1e-9);
  assert.equal(api.formatDistance(16093.44, 'wmoUnit:m'), '10 mi');
  assert.equal(api.formatDistance(4828.032, 'wmoUnit:m'), '3.0 mi');
  assert.equal(api.formatTemperature(21.1, 'wmoUnit:degC'), '70°');
});

test('a recent complete observation supplies every measured field', () => {
  const { api } = loadAppForTesting();
  const observation = { properties: observationProperties({ windGust: quantity(40, 'wmoUnit:km_h-1') }),
    stationId: 'KRDU', stationName: 'Raleigh-Durham' };
  const c = api.resolveCurrentConditions(hourlyPeriod(), observation, Date.now());

  assert.equal(c.mode, 'observed');
  assert.equal(c.stationId, 'KRDU');
  assert.equal(c.temp.source, 'observed');
  assert.equal(Math.round(c.temp.value), 77);
  assert.equal(c.humidity.value, 55);
  assert.equal(c.humidity.source, 'observed');
  assert.equal(Math.round(c.dewPoint.value), 50);
  assert.equal(c.wind.text, 'NW 11 mph, gusts 25');
  assert.equal(c.wind.source, 'observed');
  assert.equal(c.visibility.value, 10);
  assert.equal(c.summary.text, 'Clear');
  assert.equal(c.summary.source, 'observed');
  assert.equal(c.feels.source, 'observed');
});

test('missing observations fall back to the forecast and are never labelled observed', () => {
  const { api, elements } = loadAppForTesting();
  const c = api.resolveCurrentConditions(hourlyPeriod(), null, Date.now());
  assert.equal(c.mode, 'forecast');
  assert.equal(c.reason, 'missing');
  assert.equal(c.temp.value, 70);
  assert.equal(c.temp.source, 'forecast');
  assert.equal(c.wind.text, 'SW 5 to 10 mph');
  assert.equal(c.visibility.source, '');

  api.updateCurrent(hourlyPeriod(), '', null, NaN);
  assert.doesNotMatch(elements.get('#currentSource').textContent, /Observed/);
  assert.match(elements.get('#currentSource').textContent, /^Forecast for this hour\./);
  assert.equal(elements.get('#visibility').textContent, '--');
});

test('an outdated observation is not shown as current', () => {
  const { api, elements } = loadAppForTesting();
  const stale = { properties: observationProperties({ timestamp: minutesAgo(180) }), stationId: 'KRDU' };
  const c = api.resolveCurrentConditions(hourlyPeriod(), stale, Date.now());
  assert.equal(c.mode, 'forecast');
  assert.equal(c.reason, 'outdated');
  assert.equal(c.temp.source, 'forecast');
  assert.equal(c.visibility.source, '');

  const edge = { properties: observationProperties({ timestamp: minutesAgo(89) }), stationId: 'KRDU' };
  assert.equal(api.resolveCurrentConditions(hourlyPeriod(), edge, Date.now()).mode, 'observed');
  const future = { properties: observationProperties({ timestamp: minutesAgo(-60) }), stationId: 'KRDU' };
  assert.equal(api.resolveCurrentConditions(hourlyPeriod(), future, Date.now()).mode, 'forecast');

  api.updateCurrent(hourlyPeriod(), '', stale, NaN);
  assert.match(elements.get('#currentSource').textContent, /KRDU \(3 h ago\) is too old to show as current/);
});

test('an incomplete observation falls back field by field', () => {
  const { api, elements } = loadAppForTesting();
  const partial = { properties: observationProperties({
    relativeHumidity: quantity(null, 'wmoUnit:percent', 'Z'),
    textDescription: '',
    windSpeed: quantity(null, 'wmoUnit:km_h-1', 'Z')
  }), stationId: 'KRDU', stationName: 'Raleigh-Durham' };
  const c = api.resolveCurrentConditions(hourlyPeriod(), partial, Date.now());

  assert.equal(c.mode, 'observed');
  assert.equal(c.temp.source, 'observed');
  assert.equal(c.humidity.source, 'forecast');
  assert.equal(c.humidity.value, 50);
  assert.equal(c.wind.source, 'forecast');
  assert.equal(c.summary.source, 'forecast');
  assert.equal(c.visibility.source, 'observed');
  assert.equal(c.feels.source, 'mixed');

  api.updateCurrent(hourlyPeriod(), '', partial, NaN);
  const note = elements.get('#currentSource').textContent;
  assert.match(note, /^Observed 10 min ago at KRDU \(Raleigh-Durham\)/);
  assert.match(note, /Forecast used for conditions, wind, humidity\./);
});

test('observations flagged by quality control are rejected', () => {
  const { api } = loadAppForTesting();
  assert.ok(Number.isNaN(api.getMeasuredValue(quantity(20, 'wmoUnit:degC', 'X'))));
  assert.ok(Number.isNaN(api.getMeasuredValue(quantity(20, 'wmoUnit:degC', 'Q'))));
  assert.ok(Number.isNaN(api.getMeasuredValue(quantity(20, 'wmoUnit:degC', 'B'))));
  for (const code of ['V', 'S', 'C', 'G', 'Z']) {
    assert.equal(api.getMeasuredValue(quantity(20, 'wmoUnit:degC', code)), 20);
  }

  const flagged = { properties: observationProperties({
    temperature: quantity(40, 'wmoUnit:degC', 'X'),
    windSpeed: quantity(90, 'wmoUnit:km_h-1', 'Q')
  }), stationId: 'KRDU' };
  const c = api.resolveCurrentConditions(hourlyPeriod(), flagged, Date.now());
  assert.equal(c.temp.source, 'forecast');
  assert.equal(c.temp.value, 70);
  assert.equal(c.wind.source, 'forecast');

  const allFlagged = { properties: { timestamp: minutesAgo(5), temperature: quantity(40, 'wmoUnit:degC', 'X') } };
  const none = api.resolveCurrentConditions(hourlyPeriod(), allFlagged, Date.now());
  assert.equal(none.mode, 'forecast');
  assert.equal(none.reason, 'unusable');
});

test('observed values display without an hourly forecast and say so', () => {
  const { api, elements } = loadAppForTesting();
  const observation = { properties: observationProperties(), stationId: 'KRDU' };
  api.setCurrentUnavailable(observation, NaN);
  assert.equal(String(elements.get('#currentTemp').textContent), '77');
  assert.equal(elements.get('#precipChance').textContent, '--');
  assert.match(elements.get('#currentSource').textContent, /^Observed 10 min ago at KRDU/);

  api.setCurrentUnavailable(null, NaN);
  assert.equal(elements.get('#currentTemp').textContent, '--');
  assert.match(elements.get('#currentSource').textContent, /^Hourly forecast unavailable\./);
});

test('station selection prefers a recent, more complete observation', async () => {
  const { api, context } = loadAppForTesting();
  const requested = [];
  context.fetchJson = async (url) => {
    requested.push(url);
    if (/stations$/.test(url)) {
      return { features: ['KAAA', 'KBBB', 'KCCC', 'KDDD'].map((id) => ({
        properties: { name: 'Name ' + id, stationIdentifier: id } })) };
    }
    if (/KAAA/.test(url)) return { properties: observationProperties({ timestamp: minutesAgo(240) }) };
    if (/KBBB/.test(url)) {
      return { properties: observationProperties({ visibility: quantity(null, 'wmoUnit:m', 'Z') }) };
    }
    return { properties: observationProperties() };
  };
  const result = await api.loadLatestObservation('https://nws.test/stations');
  assert.equal(result.stationId, 'KCCC');
  assert.equal(result.stationName, 'Name KCCC');
  assert.equal(requested.some((url) => /KDDD/.test(url)), false);
  assert.equal(api.readObservation(result, Date.now()).status, 'ok');
});

// ---------------------------------------------------------------------------
// Automatic radar refresh
// ---------------------------------------------------------------------------

const FRAME_BASE = Math.floor(Date.now() / 1000) - 3 * 3600;
const radarFrame = (minutes) => {
  const time = FRAME_BASE + minutes * 60;
  return { iso: new Date(time * 1000).toISOString(), time };
};
const radarData = (...minutes) => ({
  frames: minutes.map(radarFrame),
  layerName: 'kaaa_sr_bref',
  maxZoom: 11,
  source: 'nws',
  status: 'NWS KAAA super-res ready',
  wmsUrl: 'https://wms.test/kaaa/wms'
});

function setupRadar(minutes = [0, 10, 20, 30]) {
  const loaded = loadAppForTesting();
  const { api, context } = loaded;
  const removed = [];
  const makeLayer = () => ({
    added: false,
    opacity: 0,
    addTo() { this.added = true; return this; },
    bringToFront() {},
    on() { return this; },
    setOpacity(value) { this.opacity = value; }
  });
  const tileLayer = makeLayer;
  tileLayer.wms = makeLayer;
  context.L = { tileLayer };
  const map = {
    hasLayer(layer) { return layer.added; },
    removeLayer(layer) { layer.added = false; removed.push(layer); }
  };
  Object.assign(api.state, {
    map,
    radarFrames: radarData(...minutes).frames,
    radarLayerName: 'kaaa_sr_bref',
    radarSelectionMode: 'manual',
    radarSource: 'nws',
    radarStation: 'KAAA',
    radarWmsUrl: 'https://wms.test/kaaa/wms'
  });
  api.state.radarFrameIndex = api.state.radarFrames.length - 1;
  api.state.radarFrames.forEach((_frame, index) => api.ensureRadarLayer(index));
  api.renderRadarFrame(api.state.radarFrameIndex);
  const calls = { loadRadar: 0, nws: [] };
  context.loadRadar = () => { calls.loadRadar += 1; };
  context.loadNwsRadarData = async (station) => {
    calls.nws.push(station);
    return calls.next ? calls.next() : radarData(10, 20, 30, 40);
  };
  return { ...loaded, calls, map, removed };
}

const layerFor = (api, iso) => {
  const entry = api.state.radarLayers.get('nws:' + iso);
  return entry && entry.layer;
};

test('radar refresh keeps the selected station and the existing map', async () => {
  const { api, calls, map, elements } = setupRadar();
  await api.refreshRadarFrames();

  assert.deepEqual(calls.nws, ['KAAA']);
  assert.equal(calls.loadRadar, 0);
  assert.equal(api.state.radarStation, 'KAAA');
  assert.equal(api.state.radarSelectionMode, 'manual');
  assert.equal(api.state.radarSource, 'nws');
  assert.equal(api.state.map, map);
  assert.equal(api.state.radarFrames.length, 4);
  assert.equal(api.state.radarFrames[3].iso, radarFrame(40).iso);
  assert.ok(api.state.radarRefreshTimer, 'the next refresh should be scheduled');
});

test('the latest scan label uses the newest frame time, not the fetch time', async () => {
  const { api, elements } = setupRadar();
  await api.refreshRadarFrames();
  const expected = new Date(radarFrame(40).time * 1000)
    .toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' });
  const label = elements.get('#radarFreshness');
  assert.equal(label.textContent, 'Latest scan ' + expected);
  assert.equal(label.dataset.state, 'current');
  assert.equal(label.classList.contains('hidden'), false);
});

test('an overlapping radar refresh is a no-op', async () => {
  const { api, calls } = setupRadar();
  const pending = deferred();
  calls.next = () => pending.promise;
  const first = api.refreshRadarFrames();
  const second = api.refreshRadarFrames();
  assert.equal(calls.nws.length, 1);
  pending.resolve(radarData(10, 20, 30, 40));
  await Promise.all([first, second]);
  assert.equal(calls.nws.length, 1);
  assert.equal(api.state.radarRefreshController, null);
});

test('a hidden page clears the refresh timer and a visible one resumes it', async () => {
  const { api, calls, context } = setupRadar();
  api.scheduleRadarRefresh();
  assert.ok(api.state.radarRefreshTimer);

  context.document.hidden = true;
  api.handleVisibilityChange();
  assert.equal(api.state.radarRefreshTimer, 0);
  await api.refreshRadarFrames();
  assert.equal(calls.nws.length, 0, 'hidden pages must not poll');

  context.document.hidden = false;
  api.state.radarRefreshCheckedAt = Date.now();
  api.handleVisibilityChange();
  assert.ok(api.state.radarRefreshTimer, 'not due yet, so the timer is re-armed');
  assert.equal(calls.nws.length, 0);

  api.state.radarRefreshCheckedAt = Date.now() - 6 * 60 * 1000;
  context.document.hidden = true;
  api.handleVisibilityChange();
  context.document.hidden = false;
  api.handleVisibilityChange();
  assert.equal(calls.nws.length, 1, 'a due refresh runs immediately on return');
  await api.state.radarRefreshPromise;
});

test('offline pages do not refresh radar', async () => {
  const { api, calls, context } = setupRadar();
  context.navigator.onLine = false;
  api.scheduleRadarRefresh();
  assert.equal(api.state.radarRefreshTimer, 0);
  await api.refreshRadarFrames();
  assert.equal(calls.nws.length, 0);
});

test('frame reconciliation reuses cached layers, adds new ones, and removes dropped ones', () => {
  const { api, removed } = setupRadar([0, 10, 20, 30]);
  const [oldest, second, third, latest] = api.state.radarFrames.map((frame) => layerFor(api, frame.iso));
  assert.equal(api.state.radarLayers.size, 4);

  api.reconcileRadarFrames(radarData(10, 20, 30, 40));

  assert.equal(layerFor(api, radarFrame(10).iso), second);
  assert.equal(layerFor(api, radarFrame(20).iso), third);
  assert.equal(layerFor(api, radarFrame(30).iso), latest);
  assert.equal(layerFor(api, radarFrame(0).iso), undefined);
  assert.deepEqual(removed, [oldest]);
  assert.equal(oldest.added, false);
  const added = layerFor(api, radarFrame(40).iso);
  assert.ok(added && added.added);
  assert.equal(api.state.radarLayers.size, 4);
  assert.equal(api.state.radarLayer, added, 'paused on the latest frame follows the new latest');
  assert.equal(api.state.radarFrameIndex, 3);
  assert.equal(added.opacity > 0, true);
  assert.equal(latest.opacity, 0);
});

test('a radar paused on an older frame that still exists stays on it', () => {
  const { api } = setupRadar([0, 10, 20, 30]);
  api.renderRadarFrame(1);
  const kept = layerFor(api, radarFrame(10).iso);
  api.reconcileRadarFrames(radarData(10, 20, 30, 40));
  assert.equal(api.state.radarFrameIndex, 0);
  assert.equal(api.state.radarLayer, kept);
  assert.equal(api.isRadarAnimating(), false);
});

test('a paused frame that aged out moves to the oldest remaining frame', () => {
  const { api } = setupRadar([0, 10, 20, 30]);
  api.renderRadarFrame(0);
  api.reconcileRadarFrames(radarData(10, 20, 30, 40));
  assert.equal(api.state.radarFrameIndex, 0);
  assert.equal(api.state.radarFrames[0].iso, radarFrame(10).iso);
});

test('a playing radar keeps playing through a refresh', () => {
  const { api } = setupRadar([0, 10, 20, 30]);
  api.renderRadarFrame(2);
  api.startRadarAnimation();
  assert.equal(api.isRadarAnimating(), true);
  api.reconcileRadarFrames(radarData(10, 20, 30, 40));
  assert.equal(api.isRadarAnimating(), true);
  assert.equal(api.state.radarFrameIndex, 1, 'stays on the same scan, which moved one slot earlier');
});

test('unchanged frame lists leave layers untouched', () => {
  const { api, removed } = setupRadar([0, 10, 20, 30]);
  const before = Array.from(api.state.radarLayers.values()).map((entry) => entry.layer);
  api.reconcileRadarFrames(radarData(0, 10, 20, 30));
  assert.deepEqual(Array.from(api.state.radarLayers.values()).map((entry) => entry.layer), before);
  assert.equal(removed.length, 0);
});

test('a failed radar refresh keeps the frames, notes it, and does not fall back', async () => {
  const { api, calls, elements, removed } = setupRadar();
  const before = api.state.radarFrames.slice();
  calls.next = () => { throw new Error('upstream down'); };
  await api.refreshRadarFrames();

  assert.deepEqual(api.state.radarFrames, before);
  assert.equal(api.state.radarSource, 'nws');
  assert.equal(calls.loadRadar, 0);
  assert.equal(removed.length, 0);
  assert.equal(api.state.radarLayers.size, 4);
  const label = elements.get('#radarFreshness');
  assert.equal(label.dataset.state, 'stale');
  assert.match(label.textContent, /^Latest scan .*Radar update failed; showing the last loaded frames/);
  assert.ok(api.state.radarRefreshTimer, 'a later attempt stays scheduled');
});

test('a radar refresh that finishes after a full reload is discarded', async () => {
  const { api, calls } = setupRadar();
  const pending = deferred();
  calls.next = () => pending.promise;
  const refresh = api.refreshRadarFrames();
  api.state.radarLoadId += 1;
  pending.resolve(radarData(10, 20, 30, 40));
  await refresh;
  assert.equal(api.state.radarFrames[3].iso, radarFrame(30).iso);
});

const SAMPLE_AFD = `
000
FXUS62 KRAH 082340
AFDRAH

Area Forecast Discussion
National Weather Service Raleigh NC
740 PM EDT Thu Oct 8 2026

.WHAT HAS CHANGED...

* After Isaias weakens ...
\x20
&&

.KEY MESSAGES...
As of 255 PM Thursday...

1) Above normal temperatures ...

&&

.AVIATION /00Z Friday THROUGH Wednesday/...
  VFR expected.
&&

.RAH WATCHES/WARNINGS/ADVISORIES...
None.
&&

$$

SHORT TERM...Smith
`;

test('readDiscussionProduct accepts a complete product and rejects incomplete ones', () => {
  const { api } = loadAppForTesting();
  const product = {
    id: 'b-2',
    issuanceTime: '2026-10-08T23:40:00+00:00',
    issuingOffice: 'KRAH',
    productText: '\nAFDRAH\n.KEY MESSAGES...\nText\n&&\n'
  };
  const read = api.readDiscussionProduct(product);
  assert.equal(read.id, 'b-2');
  assert.equal(read.issuingOffice, 'KRAH');
  assert.equal(read.text, product.productText);
  assert.equal(api.readDiscussionProduct({ ...product, id: 'bad id!' }), null);
  assert.equal(api.readDiscussionProduct({ ...product, issuanceTime: 'not a date' }), null);
  assert.equal(api.readDiscussionProduct({ ...product, productText: '  ' }), null);
  assert.equal(api.readDiscussionProduct(null), null);
});

test('parseDiscussionSections splits on headers and ends at && or $$', () => {
  const { api } = loadAppForTesting();
  const sections = Array.from(api.parseDiscussionSections(SAMPLE_AFD));
  assert.deepEqual(sections.map((section) => section.title), [
    'WHAT HAS CHANGED',
    'KEY MESSAGES',
    'AVIATION /00Z Friday THROUGH Wednesday/',
    'RAH WATCHES/WARNINGS/ADVISORIES'
  ]);
  assert.equal(sections[0].body, '* After Isaias weakens ...');
  assert.equal(sections[1].body, 'As of 255 PM Thursday...\n\n1) Above normal temperatures ...');
  assert.equal(sections[2].body, '  VFR expected.');
  assert.equal(sections[3].body, 'None.');
  assert.ok(!sections.some((section) => /Smith/.test(section.body)), 'text after $$ is not part of a section');
});

test('parseDiscussionSections ends a section at $$ and returns [] without headers', () => {
  const { api } = loadAppForTesting();
  const sections = Array.from(api.parseDiscussionSections('.NEAR TERM...\nLine one\n\n$$\nTrailing'));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].body, 'Line one');
  assert.equal(api.parseDiscussionSections('Just some plain text\nwith no headers').length, 0);
  assert.equal(api.parseDiscussionSections('').length, 0);
});

test('discussionSourceUrl builds the official product link only for valid offices', () => {
  const { api } = loadAppForTesting();
  assert.equal(
    api.discussionSourceUrl('RAH'),
    'https://forecast.weather.gov/product.php?site=NWS&issuedby=RAH&product=AFD&format=txt&version=1&glossary=0'
  );
  assert.equal(api.discussionSourceUrl('rah').includes('issuedby=RAH'), true);
  assert.equal(api.discussionSourceUrl('RAH&x=1'), '');
  assert.equal(api.discussionSourceUrl(''), '');
});

// ---------------------------------------------------------------------------
// Source health
// ---------------------------------------------------------------------------

test('classifySourceError separates offline, provider, app errors and aborts', () => {
  const { api, context } = loadAppForTesting();
  const status = Object.assign(new Error('HTTP'), { status: 503 });
  assert.equal(api.classifySourceError(status), 'provider');
  assert.equal(api.classifySourceError(Object.assign(new Error('timeout'), { timedOut: true })), 'provider');
  assert.equal(api.classifySourceError(api.providerError('NWS did not return forecast endpoints.')), 'provider');
  assert.equal(api.classifySourceError(new Error('x is not a function')), 'app');
  // A bare TypeError is far more likely our own rendering bug than a network failure.
  assert.equal(api.classifySourceError(new TypeError('Cannot read properties of null')), 'app');
  assert.equal(api.classifySourceError(new DOMException('Aborted', 'AbortError')), '');
  context.navigator.onLine = false;
  assert.equal(api.classifySourceError(status), 'offline');
  assert.equal(api.classifySourceError(new Error('x')), 'offline');
});

test('fetchResource tags network, HTTP, timeout and parse failures as provider errors', async () => {
  const { api, context } = loadAppForTesting();
  context.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(api.fetchResource('https://api.weather.gov/x', {}, 'json'), (error) => {
    assert.equal(error.message, 'Failed to fetch');
    return api.classifySourceError(error) === 'provider' && error.url === 'https://api.weather.gov/x';
  });
  context.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(api.fetchJson('https://api.weather.gov/x'), (error) =>
    error.status === 503 && error.message === 'Request failed with status 503.' &&
    api.classifySourceError(error) === 'provider');
  context.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } });
  await assert.rejects(api.fetchJson('https://api.weather.gov/x'), (error) =>
    api.classifySourceError(error) === 'provider');
  context.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  await assert.rejects(api.fetchJson('https://api.weather.gov/x', { timeoutMs: 5 }), (error) =>
    error.message === 'The request timed out. Please try again.' &&
    api.classifySourceError(error) === 'provider');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.fetchJson('https://api.weather.gov/x', { signal: controller.signal }),
    (error) => api.classifySourceError(error) === '');
});

test('getSourceFreshness judges age, keeps failures failed, and reports pending and idle', () => {
  const { api } = loadAppForTesting();
  const now = 10 * 3600000;
  const record = (overrides) => ({ status: 'ok', dataTime: now - 60000, ...overrides });
  assert.equal(api.getSourceFreshness(record(), now, 3600000), 'ok');
  assert.equal(api.getSourceFreshness(record({ dataTime: now - 3600001 }), now, 3600000), 'stale');
  assert.equal(api.getSourceFreshness(record({ dataTime: now - 99 * 3600000 }), now, 0), 'ok');
  assert.equal(api.getSourceFreshness(record({ dataTime: NaN }), now, 3600000), 'ok');
  // A failure keeps its last good dataTime but is still a failure, however fresh that data is.
  assert.equal(api.getSourceFreshness(record({ status: 'failed' }), now, 3600000), 'failed');
  assert.equal(api.getSourceFreshness(record({ status: 'pending', dataTime: NaN }), now, 3600000), 'pending');
  assert.equal(api.getSourceFreshness(record({ status: 'idle' }), now, 3600000), 'idle');
  assert.equal(api.getSourceFreshness(record({ status: 'stale' }), now, 3600000), 'stale');
});

test('source records keep last good data on failure and never record aborts', () => {
  const { api, context } = loadAppForTesting();
  const health = api.state.sourceHealth;
  const dataTime = Date.now() - 20 * 60000;
  api.markSourceSuccess('forecast', dataTime, 'ok');
  api.markSourceFailure('forecast', Object.assign(new Error('x'), { status: 503, url: 'https://api.weather.gov/gridpoints' }), 'Context.');
  assert.equal(health.forecast.status, 'failed');
  assert.equal(health.forecast.failureKind, 'provider');
  assert.equal(health.forecast.dataTime, dataTime);
  assert.match(health.forecast.detail, /HTTP 503 from api\.weather\.gov \u2014 provider problem, not the app/);
  const row = Array.from(api.getSourceHealthRows(Date.now())).find((entry) => entry.key === 'forecast');
  assert.equal(row.statusText, 'Provider error');
  assert.match(row.ageText, /^Last good data: 20 min old/);

  api.markSourceFailure('alerts', new DOMException('Aborted', 'AbortError'), 'x');
  assert.equal(health.alerts.status, 'idle');
  api.markSourceFailure('alerts', new Error('boom'), 'x');
  assert.equal(health.alerts.failureKind, 'app');
  assert.match(health.alerts.detail, /Unexpected app error/);
  context.navigator.onLine = false;
  api.markSourceFailure('alerts', new Error('boom'), 'x');
  assert.equal(health.alerts.failureKind, 'offline');
  context.navigator.onLine = true;

  // Re-checking a source that already has data does not blank it; one without data shows Checking.
  api.markSourceSuccess('alerts', Date.now(), 'ok');
  api.markSourcePending('alerts');
  assert.equal(health.alerts.status, 'ok');
  api.markSourcePending('discussion');
  assert.equal(health.discussion.status, 'pending');
});

test('health summary counts issues and stale sources and hides unused optional ones', () => {
  const { api } = loadAppForTesting();
  assert.equal(api.summarizeSourceHealth(api.getSourceHealthRows(Date.now())).visible, false);
  assert.equal(
    Array.from(api.getSourceHealthRows(Date.now())).some((row) => row.key === 'zip' || row.key === 'basemap'),
    false
  );
  const now = Date.now();
  api.markSourceSuccess('forecast', now, '');
  api.markSourceSuccess('alerts', now - 6 * 60000, '');
  api.markSourceSuccess('radar', now - 5 * 60000, '');
  let summary = api.summarizeSourceHealth(api.getSourceHealthRows(now));
  assert.equal(summary.text, 'Data sources: 1 stale');
  assert.equal(summary.level, 'stale');
  api.markSourceFailure('discussion', Object.assign(new Error('x'), { status: 503 }), '');
  summary = api.summarizeSourceHealth(api.getSourceHealthRows(now));
  assert.equal(summary.text, 'Data sources: 1 issue, 1 stale');
  assert.equal(summary.level, 'issue');
  api.markSourceSuccess('alerts', now, '');
  api.markSourceSuccess('discussion', now, '');
  assert.equal(api.summarizeSourceHealth(api.getSourceHealthRows(now)).text, 'Data sources: all current');
});

test('an outdated observation is shown as stale with the forecast fallback explained', () => {
  const { api } = loadAppForTesting();
  api.recordObservationHealth({
    stationId: 'KRDU',
    properties: observationProperties({ timestamp: minutesAgo(130) })
  });
  const row = Array.from(api.getSourceHealthRows(Date.now())).find((entry) => entry.key === 'observations');
  assert.equal(row.statusText, 'Stale');
  assert.match(row.detail, /Showing forecast values; latest observation from KRDU is 2 h 10 min old/);
  api.recordObservationHealth(null);
  assert.equal(api.state.sourceHealth.observations.status, 'idle');
});

test('a loaded forecast marks its sources current with data times', async () => {
  const { api, context } = loadAppForTesting();
  installForecastFetch(context);
  await api.loadForecast(35, -97);
  await api.state.forecastLoad.optional;
  await flush();
  const health = api.state.sourceHealth;
  assert.equal(health.forecast.status, 'ok');
  assert.equal(health.forecast.dataTime, Date.parse('2026-10-09T12:00:00-04:00'));
  assert.equal(health.observations.status, 'ok');
  assert.equal(health.precip.status, 'ok');
  assert.equal(health.alerts.status, 'ok');
  assert.equal(health.discussion.status, 'idle', 'the stub has no AFD product (404): no discussion on file, not a failure');
});

test('provider failures and app failures are recorded differently during a load', async () => {
  const { api, context } = loadAppForTesting();
  installForecastFetch(context, { 'A:daily': { __status: 404 }, 'A:hourly': { __status: 404 }, 'A:stations': { __status: 404 } });
  await api.loadForecast(35, -97);
  await api.state.forecastLoad.optional;
  const health = api.state.sourceHealth;
  assert.equal(health.forecast.status, 'failed');
  assert.equal(health.forecast.failureKind, 'provider');
  assert.match(health.forecast.detail, /HTTP 404/);
  assert.equal(health.observations.failureKind, 'provider');
  assert.equal(health.precip.status, 'ok', 'one failing provider call does not mark the others failed');

  // An exception from our own rendering code is an app error and does not stop the other steps.
  const second = loadAppForTesting();
  installForecastFetch(second.context);
  vm.runInContext("renderHourly = function () { throw new Error('render bug'); };", second.context);
  await second.api.loadForecast(35, -97);
  assert.equal(second.api.state.sourceHealth.forecast.status, 'failed');
  assert.equal(second.api.state.sourceHealth.forecast.failureKind, 'app');
  assert.equal(second.elements.get('#dailyOffice').textContent, 'OFFA office');
});

test('a superseded forecast load cannot change the health registry', async () => {
  const { api, context } = loadAppForTesting();
  const pointsA = deferred();
  installForecastFetch(context, { 'A:points': pointsA.promise });
  const loadA = api.loadForecast(35, -97);
  await api.loadForecast(36, -98);
  await api.state.forecastLoad.optional;
  await flush();
  const before = JSON.stringify(api.state.sourceHealth);
  pointsA.resolve({ __status: 404 });
  await loadA;
  await flush();
  assert.equal(JSON.stringify(api.state.sourceHealth), before);
  assert.equal(api.state.sourceHealth.forecast.status, 'ok');
});

function severeFeature(overrides, id) {
  const now = Date.now();
  const url = 'https://api.weather.gov/alerts/' + id;
  return {
    id: url,
    properties: Object.assign({
      '@id': url, id, status: 'Actual', messageType: 'Alert', event: 'Tornado Warning', severity: 'Extreme',
      urgency: 'Immediate', certainty: 'Observed', areaDesc: 'Wake, NC', headline: 'Tornado Warning for Wake',
      effective: new Date(now - 60000).toISOString(), ends: new Date(now + 25 * 60000).toISOString(),
      expires: new Date(now + 25 * 60000).toISOString(), description: 'D', instruction: 'I'
    }, overrides)
  };
}

test('buildSevereFreshness reports check time, radar state and failing alert updates', () => {
  const { api } = loadAppForTesting();
  const now = Date.parse('2026-10-09T16:00:00Z');
  const fmt = () => '12:41 AM';
  const ok = { status: 'ok', lastSuccessAt: now - 30000, dataTime: now - 30000 };
  const radar = { status: 'ok', dataTime: now - 120000, lastSuccessAt: now - 120000 };
  const fresh = api.buildSevereFreshness(ok, radar, false, now, fmt);
  assert.equal(fresh.text, 'Alerts checked 12:41 AM · Latest radar scan 12:41 AM');
  assert.equal(fresh.notice, '');
  const failed = api.buildSevereFreshness({ ...ok, status: 'failed' }, { status: 'failed', dataTime: NaN }, false, now, fmt);
  assert.match(failed.text, /Radar unavailable/);
  assert.equal(failed.notice, 'Alert updates are failing — showing the last warnings received at 12:41 AM. Check weather.gov or local media.');
  assert.match(api.buildSevereFreshness(ok, radar, true, now, fmt).text, /Radar unavailable/);
  const old = api.buildSevereFreshness({ ...ok, dataTime: now - 6 * 60000 }, radar, false, now, fmt);
  assert.match(old.notice, /not been refreshed/);
});

test('severe panel follows active warnings and keeps minimized state per warning set', () => {
  const { api, elements } = loadAppForTesting();
  api.state.lat = 35.78;
  api.state.lon = -78.64;
  const panel = elements.get('#severePanel');
  api.state.warningFeatures = [severeFeature({ event: 'Flood Advisory' }, 'adv')];
  api.renderSevereMode();
  assert.equal(panel.classList.contains('hidden'), true, 'advisories alone do not open severe mode');
  api.state.warningFeatures = [severeFeature({}, 'a')];
  api.renderSevereMode();
  assert.equal(panel.classList.contains('hidden'), false);
  assert.match(elements.get('#severeAnnouncer').textContent, /Tornado Warning/);
  api.toggleSevereMinimized();
  assert.equal(panel.classList.contains('is-minimized'), true);
  api.state.warningFeatures = [severeFeature({}, 'a'), severeFeature({ event: 'Flash Flood Warning' }, 'b')];
  api.renderSevereMode();
  assert.equal(panel.classList.contains('is-minimized'), false, 'a new warning expands the panel again');
  api.state.warningFeatures = [];
  api.renderSevereMode();
  assert.equal(panel.classList.contains('hidden'), true);
  assert.equal(elements.get('#severeAnnouncer').textContent, '');
});

test('renderAlerts opens the severe panel and points the banner link at it', () => {
  const { api, elements } = loadAppForTesting();
  api.state.lat = 35.78;
  api.state.lon = -78.64;
  api.renderAlerts([severeFeature({}, 'a')]);
  assert.equal(elements.get('#severePanel').classList.contains('hidden'), false);
  assert.match(elements.get('#warningBanner').innerHTML, /href="#severeHeading"/);
  api.renderAlerts([severeFeature({ event: 'Special Marine Warning' }, 'm')]);
  assert.equal(elements.get('#severePanel').classList.contains('hidden'), false, 'any Warning opens severe mode');
});
