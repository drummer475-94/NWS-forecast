'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const statusPath = path.join(projectRoot, 'status.js');
const alertGeographyPath = path.join(projectRoot, 'alert-geography.js');
const statusHtmlPath = path.join(projectRoot, 'status.html');

function createElement() {
  const classes = new Set();
  const attributes = new Map();
  return {
    addEventListener() {},
    append() {},
    checked: false,
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
    focus() {},
    querySelector() { return createElement(); },
    querySelectorAll() { return []; },
    replaceChildren() {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    style: {},
    textContent: '',
    value: ''
  };
}

function loadStatusForTesting(options = {}) {
  const elements = new Map();
  const documentElement = createElement();
  const timers = { cleared: [], set: [] };
  const document = {
    addEventListener() {},
    createDocumentFragment() { return createElement(); },
    createElement() { return createElement(); },
    createTextNode(value) { return { textContent: String(value) }; },
    documentElement,
    hidden: false,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createElement());
      return elements.get(selector);
    }
  };
  const storage = new Map();
  const window = {
    addEventListener() {},
    clearInterval(id) { timers.cleared.push(id); },
    clearTimeout,
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      removeItem(key) { storage.delete(key); },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    matchMedia() { return { addEventListener() {}, matches: false }; },
    setInterval(callback, delay) { timers.set.push({ callback, delay }); return timers.set.length; },
    setTimeout(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer; }
  };
  const sandbox = {
    AbortController,
    console: { error() {}, log() {}, warn() {} },
    document,
    fetch: options.fetch || (async () => { throw new Error('not mocked'); }),
    Intl,
    Map,
    navigator: options.navigator || {},
    Set,
    URL,
    window
  };
  const context = vm.createContext(sandbox);
  // Mirrors status.html: the shared geography script loads before status.js.
  vm.runInContext(fs.readFileSync(alertGeographyPath, 'utf8'), context, { filename: alertGeographyPath });
  const source = fs.readFileSync(statusPath, 'utf8') + `
    ;globalThis.__statusTestApi = {
      alertsForCounty,
      handleVisibilityChange,
      isSnapshotAcceptable,
      loadStatusSnapshot,
      refreshSourcesQuietly,
      startAutoRefresh,
      stopAutoRefresh,
      unmatchedAlerts,
      alertCountLabel,
      alertSummaryMessage,
      countyCatalog: NC_COUNTIES,
      countyFipsAt,
      deriveFreshness,
      handleDeviceLocation,
      isStatusSnapshot,
      metricSummary,
      mapBandForCounty,
      parseNwsAlerts,
      powerBand,
      powerDetailMessage,
      refreshWeatherAlerts,
      resolveZipPayload,
      safeUrl,
      state: statusState,
      weatherBand
    };
  `;
  vm.runInContext(source, context, { filename: statusPath });
  return { api: context.__statusTestApi, document, elements, timers };
}

test('status page keeps DOM hooks unique, present, and accessible', () => {
  const html = fs.readFileSync(statusHtmlPath, 'utf8');
  const source = fs.readFileSync(statusPath, 'utf8');
  const ids = Array.from(html.matchAll(/\bid=["']([^"']+)["']/g), (match) => match[1]);
  const selectorIds = Array.from(source.matchAll(/document\.querySelector\(["']#([^"']+)["']\)/g), (match) => match[1]);

  assert.equal(new Set(ids).size, ids.length, 'status.html contains a duplicate id');
  for (const id of selectorIds) assert.ok(ids.includes(id), `status.html is missing #${id}`);
  assert.equal(Array.from(html.matchAll(/<h1\b/gi)).length, 1, 'status.html should contain exactly one h1');
  assert.match(html, /<html\b[^>]*\blang=["'][^"']+["']/i);
  assert.match(html, /<main\b/i);

  for (const match of html.matchAll(/<label\b[^>]*\bfor=["']([^"']+)["'][^>]*>/gi)) {
    assert.ok(ids.includes(match[1]), `label points to missing #${match[1]}`);
  }
  for (const match of html.matchAll(/\baria-(?:controls|describedby|labelledby)=["']([^"']+)["']/gi)) {
    for (const id of match[1].trim().split(/\s+/)) {
      assert.ok(ids.includes(id), `ARIA relationship points to missing #${id}`);
    }
  }
  for (const match of html.matchAll(/<button\b[^>]*>/gi)) {
    assert.match(match[0], /\btype=["'](?:button|submit|reset)["']/i, 'button is missing an explicit type');
  }
  for (const match of html.matchAll(/<a\b[^>]*\btarget=["']_blank["'][^>]*>/gi)) {
    assert.match(match[0], /\brel=["'][^"']*\bnoreferrer\b[^"']*["']/i, 'external link is missing noreferrer');
  }
});

test('status page references local assets and pinned Leaflet resources', () => {
  const html = fs.readFileSync(statusHtmlPath, 'utf8');
  for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const reference = match[1].split('?')[0];
    if (/^(?:https?:|#)/.test(reference)) continue;
    assert.ok(fs.existsSync(path.join(projectRoot, reference)), `missing local asset ${reference}`);
  }
  assert.match(html, /leaflet@1\.9\.4\/dist\/leaflet\.css[^>]+integrity="sha256-p4NxAoJBhIIN\+hmNHrzRCf9tD\/miZyoHS5obTRR9BMY="/i);
  assert.match(html, /leaflet@1\.9\.4\/dist\/leaflet\.js[^>]+integrity="sha256-20nQCchB9co0qIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo="/i);
});

test('freshness windows transition at the documented boundaries', () => {
  const { api } = loadStatusForTesting();
  const now = Date.parse('2026-09-13T12:00:00Z');
  const sourceAt = (milliseconds) => ({ lastSuccessAt: new Date(now - milliseconds).toISOString() });

  assert.equal(api.deriveFreshness(sourceAt(45 * 60_000), 45 * 60_000, 60 * 60_000, now), 'fresh');
  assert.equal(api.deriveFreshness(sourceAt(45 * 60_000 + 1), 45 * 60_000, 60 * 60_000, now), 'stale');
  assert.equal(api.deriveFreshness(sourceAt(60 * 60_000 + 1), 45 * 60_000, 60 * 60_000, now), 'unavailable');
  assert.equal(api.deriveFreshness(null, 1, 2, now), 'unavailable');
});

test('fixed power and weather bands preserve stable map meaning', () => {
  const { api } = loadStatusForTesting();
  assert.equal(api.powerBand(0), 'none');
  assert.equal(api.powerBand(1), 'low');
  assert.equal(api.powerBand(99), 'low');
  assert.equal(api.powerBand(100), 'elevated');
  assert.equal(api.powerBand(999), 'elevated');
  assert.equal(api.powerBand(1000), 'major');
  assert.equal(api.powerBand(-1), 'unknown');
  assert.equal(api.weatherBand([]), 'none');
  assert.equal(api.weatherBand([{ severity: 'Minor' }]), 'low');
  assert.equal(api.weatherBand([{ severity: 'Moderate' }]), 'elevated');
  assert.equal(api.weatherBand([{ severity: 'Severe' }]), 'major');
});

test('expired map sources use the no-current-data band while stale sources remain labeled values', () => {
  const { api } = loadStatusForTesting();
  const sourceAt = (minutes) => ({ lastSuccessAt: new Date(Date.now() - minutes * 60_000).toISOString() });
  api.state.activeLayer = 'power';
  api.state.snapshot = {
    sources: { power: sourceAt(50), weather: sourceAt(1) },
    power: [{ countyFips: '37183', countyName: 'Wake', customersOut: 42 }],
    alerts: []
  };
  assert.equal(api.mapBandForCounty('37183'), 'low');
  api.state.snapshot.sources.power = sourceAt(61);
  assert.equal(api.mapBandForCounty('37183'), 'unknown');
});

test('county polygon matching handles inside, outside, and holes', () => {
  const { api } = loadStatusForTesting();
  const boundaries = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { GEOID: '37183' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[-80, 34], [-78, 34], [-78, 36], [-80, 36], [-80, 34]],
          [[-79.2, 34.8], [-78.8, 34.8], [-78.8, 35.2], [-79.2, 35.2], [-79.2, 34.8]]
        ]
      }
    }]
  };
  assert.equal(api.countyFipsAt(-79.5, 35, boundaries), '37183');
  assert.equal(api.countyFipsAt(-79, 35, boundaries), undefined);
  assert.equal(api.countyFipsAt(-77, 35, boundaries), undefined);
});

test('browser county identities match every bundled geometry feature', () => {
  const { api } = loadStatusForTesting();
  const geometry = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'nc-counties.geojson'), 'utf8'));
  const fromGeometry = geometry.features.map((feature) => ({
    fips: String(feature.properties.GEOID),
    name: String(feature.properties.NAME).replace(/\s+County$/i, '')
  })).sort((left, right) => left.fips.localeCompare(right.fips));
  const fromBrowser = Array.from(api.countyCatalog, (county) => ({
    fips: county.fips,
    name: county.name
  })).sort((left, right) => left.fips.localeCompare(right.fips));
  assert.deepEqual(fromBrowser, fromGeometry);
});

test('ZIP payload parsing accepts NC coordinates and rejects other states', () => {
  const { api } = loadStatusForTesting();
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.resolveZipPayload({ places: [{ 'state abbreviation': 'NC', latitude: '35.78', longitude: '-78.64', 'place name': 'Raleigh' }] }))),
    { status: 'matched', latitude: 35.78, longitude: -78.64, label: 'Raleigh' }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(api.resolveZipPayload({ places: [{ 'state abbreviation': 'VA' }] }))), { status: 'outside' });
  assert.deepEqual(JSON.parse(JSON.stringify(api.resolveZipPayload({ places: [] }))), { status: 'invalid' });
});

test('device location handles county matches, outside-NC coordinates, and denial locally', async () => {
  const boundaries = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { GEOID: '37183' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-79, 35], [-78, 35], [-78, 36], [-79, 36], [-79, 35]]]
      }
    }]
  };

  const matched = loadStatusForTesting({
    navigator: { geolocation: { getCurrentPosition(success) { success({ coords: { longitude: -78.6, latitude: 35.7 } }); } } }
  });
  matched.api.state.geometry = boundaries;
  await matched.api.handleDeviceLocation();
  assert.equal(matched.api.state.selectedFips, '37183');
  assert.match(matched.elements.get('#statusMessage').textContent, /matched Wake County/i);
  assert.equal(matched.elements.get('#deviceLocationButton').disabled, false);

  const outside = loadStatusForTesting({
    navigator: { geolocation: { getCurrentPosition(success) { success({ coords: { longitude: -77, latitude: 37 } }); } } }
  });
  outside.api.state.geometry = boundaries;
  await outside.api.handleDeviceLocation();
  assert.match(outside.elements.get('#statusMessage').textContent, /outside North Carolina/i);
  assert.equal(outside.elements.get('#deviceLocationButton').disabled, false);

  const denied = loadStatusForTesting({
    navigator: { geolocation: { getCurrentPosition(success, failure) { failure(); } } }
  });
  denied.api.state.geometry = boundaries;
  await denied.api.handleDeviceLocation();
  assert.match(denied.elements.get('#statusMessage').textContent, /permission was not granted/i);
  assert.equal(denied.elements.get('#deviceLocationButton').disabled, false);
});

test('NWS normalization filters expired and cancelled alerts and constrains URLs', () => {
  const { api } = loadStatusForTesting();
  const now = Date.parse('2026-09-13T12:00:00Z');
  const feature = (id, status, expires, sourceUrl = 'https://api.weather.gov/alerts/test') => ({
    id,
    properties: {
      id,
      event: 'Tornado Warning',
      headline: '<img src=x onerror=bad>',
      severity: 'Extreme',
      urgency: 'Immediate',
      status,
      sent: '2026-09-13T11:00:00Z',
      expires,
      areaDesc: 'Wake County',
      geocode: { SAME: ['037183'] },
      '@id': sourceUrl
    }
  });
  const alerts = api.parseNwsAlerts({ features: [
    feature('active', 'Actual', '2026-09-13T13:00:00Z', 'javascript:alert(1)'),
    feature('cancelled', 'Cancel', '2026-09-13T13:00:00Z'),
    feature('expired', 'Actual', '2026-09-13T11:00:00Z')
  ] }, now);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].countyFips[0], '37183');
  assert.match(alerts[0].sourceUrl, /^https:\/\/api\.weather\.gov\//);
  assert.equal(alerts[0].headline, '<img src=x onerror=bad>');
});

const NOW = Date.parse('2026-09-13T12:00:00Z');
const countyGeometry = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'nc-counties.geojson'), 'utf8'));

function nwsFeature(id, overrides = {}, geometry = null) {
  return {
    id,
    geometry,
    properties: {
      id,
      event: 'Flood Watch',
      severity: 'Moderate',
      urgency: 'Expected',
      status: 'Actual',
      messageType: 'Alert',
      sent: '2026-09-13T11:00:00Z',
      expires: '2026-09-13T13:00:00Z',
      areaDesc: 'Somewhere',
      geocode: {},
      affectedZones: [],
      '@id': 'https://api.weather.gov/alerts/' + id,
      ...overrides
    }
  };
}

function parseOne(api, feature, boundaries, zoneTable) {
  return Array.from(api.parseNwsAlerts({ features: [feature] }, NOW, boundaries, zoneTable))[0];
}

function ids(list) { return Array.from(list, (alert) => alert.id); }

test('SAME codes map an alert to specific counties', () => {
  const { api } = loadStatusForTesting();
  const alert = parseOne(api, nwsFeature('same', { geocode: { SAME: ['037183', '037063'] } }));
  assert.equal(alert.geography, 'county');
  assert.deepEqual(Array.from(alert.countyFips), ['37063', '37183']);
  assert.deepEqual(ids(api.alertsForCounty([alert], '37183', NOW)), ['same']);
  assert.deepEqual(ids(api.alertsForCounty([alert], '37001', NOW)), []);
});

test('UGC county codes map to FIPS and zone codes without a table do not guess', () => {
  const { api } = loadStatusForTesting();
  const ugc = parseOne(api, nwsFeature('ugc', { geocode: { UGC: ['NCC183', 'NCC063'] } }));
  assert.equal(ugc.geography, 'county');
  assert.deepEqual(Array.from(ugc.countyFips), ['37063', '37183']);

  const zoneOnly = parseOne(api, nwsFeature('zone-only', { geocode: { UGC: ['NCZ041'] }, affectedZones: ['https://api.weather.gov/zones/forecast/NCZ041'] }));
  assert.equal(zoneOnly.geography, 'unknown');
  assert.deepEqual(ids(api.alertsForCounty([zoneOnly], '37183', NOW)), []);
});

test('affectedZones county URLs and an explicit zone table map forecast zones', () => {
  const { api } = loadStatusForTesting();
  const county = parseOne(api, nwsFeature('affected', { affectedZones: ['https://api.weather.gov/zones/county/NCC183'] }));
  assert.equal(county.geography, 'county');
  assert.deepEqual(Array.from(county.countyFips), ['37183']);

  const zone = nwsFeature('zone', { geocode: { UGC: ['NCZ041'] }, affectedZones: ['https://api.weather.gov/zones/forecast/NCZ041'] });
  const mapped = parseOne(api, zone, null, { NCZ041: '37183' });
  assert.equal(mapped.geography, 'county');
  assert.deepEqual(Array.from(mapped.countyFips), ['37183']);
});

test('storm-based polygons map to the counties they intersect', () => {
  const { api } = loadStatusForTesting();
  const wake = countyGeometry.features.find((feature) => feature.properties.GEOID === '37183');
  const [lon, lat] = wake.geometry.type === 'Polygon' ? wake.geometry.coordinates[0][0] : wake.geometry.coordinates[0][0][0];
  const d = 0.01;
  const polygon = { type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] };
  const withGeometry = parseOne(api, nwsFeature('poly', { event: 'Tornado Warning', severity: 'Extreme', areaDesc: 'Storm area' }, polygon), countyGeometry);
  assert.equal(withGeometry.geography, 'county');
  assert.ok(withGeometry.countyFips.includes('37183'));
  assert.ok(withGeometry.countyFips.length < 10);
  assert.ok(!withGeometry.countyFips.includes('37155') || withGeometry.countyFips.length < 10);
  assert.deepEqual(ids(api.alertsForCounty([withGeometry], '37183', NOW)), ['poly']);

  const farCounty = countyGeometry.features.map((f) => f.properties.GEOID).find((fips) => !withGeometry.countyFips.includes(fips));
  assert.deepEqual(ids(api.alertsForCounty([withGeometry], farCounty, NOW)), []);

  const contained = { type: 'Polygon', coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] };
  assert.ok(Array.from(parseOne(api, nwsFeature('inside', {}, contained), countyGeometry).countyFips).includes('37183'));
  assert.equal(parseOne(api, nwsFeature('no-geometry', {}, polygon)).geography, 'unknown');
});

test('statewide alerts apply to every county', () => {
  const { api } = loadStatusForTesting();
  const all = Array.from({ length: 100 }, (_, index) => '037' + String(index * 2 + 1).padStart(3, '0'));
  const bySame = parseOne(api, nwsFeature('all-same', { geocode: { SAME: all } }));
  const byArea = parseOne(api, nwsFeature('by-area', { areaDesc: 'North Carolina' }));
  assert.equal(bySame.geography, 'statewide');
  assert.equal(byArea.geography, 'statewide');
  assert.deepEqual(ids(api.alertsForCounty([bySame, byArea], '37001', NOW)), ['all-same', 'by-area']);
  assert.deepEqual(ids(api.alertsForCounty([bySame, byArea], '37199', NOW)), ['all-same', 'by-area']);
});

test('unmappable alerts are unmatched, never shown in a county, and never counted or colored', () => {
  const { api } = loadStatusForTesting();
  const unknown = parseOne(api, nwsFeature('mystery', { event: 'Tornado Warning', severity: 'Extreme' }));
  assert.equal(unknown.geography, 'unknown');
  assert.deepEqual(Array.from(unknown.countyFips), []);
  assert.deepEqual(ids(api.alertsForCounty([unknown], '37183', NOW)), []);
  assert.deepEqual(ids(api.unmatchedAlerts([unknown], NOW)), ['mystery']);
  api.state.activeLayer = 'weather';
  api.state.liveAlerts = [{ ...unknown, expiresAt: new Date(Date.now() + 60_000).toISOString() }];
  api.state.weatherSource = { lastSuccessAt: new Date().toISOString() };
  assert.equal(api.mapBandForCounty('37183'), 'none');
});

test('cancelled and expired alerts are excluded by the parser and by county filtering', () => {
  const { api } = loadStatusForTesting();
  const same = { geocode: { SAME: ['037183'] } };
  const parsed = Array.from(api.parseNwsAlerts({ features: [
    nwsFeature('active', same),
    nwsFeature('status-cancel', { ...same, status: 'Cancel' }),
    nwsFeature('type-cancel', { ...same, messageType: 'Cancel' }),
    nwsFeature('expired', { ...same, expires: '2026-09-13T11:00:00Z' }),
    nwsFeature('ended', { ...same, ends: '2026-09-13T11:30:00Z' }),
    nwsFeature('test-message', { ...same, status: 'Test' }),
    nwsFeature('exercise', { ...same, status: 'Exercise' })
  ] }, NOW), (alert) => alert.id);
  assert.deepEqual(parsed, ['active']);

  const future = '2026-09-13T13:00:00Z';
  const base = { countyFips: ['37183'], geography: 'county', expiresAt: future, severity: 'Minor', urgency: 'Expected' };
  const list = [
    { ...base, id: 'ok', status: 'Actual' },
    { ...base, id: 'cancel-status', status: 'Cancel' },
    { ...base, id: 'cancel-type', status: 'Actual', messageType: 'Cancel' },
    { ...base, id: 'expired', status: 'Actual', expiresAt: '2026-09-13T11:00:00Z' },
    { ...base, id: 'ended', status: 'Actual', endsAt: '2026-09-13T11:00:00Z' },
    { ...base, id: 'test-message', status: 'Test' }
  ];
  assert.deepEqual(ids(api.alertsForCounty(list, '37183', NOW)), ['ok']);
  assert.deepEqual(ids(api.unmatchedAlerts([{ ...base, id: 'u', geography: 'unknown', countyFips: [], status: 'Cancel' }], NOW)), []);
});

test('legacy snapshot alerts without geography are county-scoped or unmatched, never statewide', () => {
  const { api } = loadStatusForTesting();
  const future = new Date(Date.now() + 60_000).toISOString();
  const alerts = [
    { id: 'wake', countyFips: ['37183'], expiresAt: future, status: 'Actual', severity: 'Severe', urgency: 'Immediate' },
    { id: 'legacy-empty', countyFips: [], expiresAt: future, status: 'Actual', severity: 'Minor', urgency: 'Expected' },
    { id: 'durham', countyFips: ['37063'], expiresAt: future, status: 'Actual', severity: 'Moderate', urgency: 'Expected' },
    { id: 'statewide', geography: 'statewide', countyFips: [], expiresAt: future, status: 'Actual', severity: 'Minor', urgency: 'Expected' }
  ];
  assert.deepEqual(ids(api.alertsForCounty(alerts, '37183')), ['wake', 'statewide']);
  assert.deepEqual(ids(api.unmatchedAlerts(alerts)), ['legacy-empty']);
});

test('the warning banner follows county-scoped alerts only', () => {
  const { api, elements } = loadStatusForTesting();
  const future = new Date(Date.now() + 60_000).toISOString();
  api.state.snapshot = {
    sources: { power: { lastSuccessAt: new Date().toISOString() }, weather: { lastSuccessAt: new Date().toISOString() } },
    power: [],
    alerts: [{ id: 'tor', event: 'Tornado Warning', headline: 'Wake only', status: 'Actual', geography: 'county', countyFips: ['37183'], expiresAt: future, severity: 'Extreme', urgency: 'Immediate', areaDescription: 'Wake' }]
  };
  api.state.selectedFips = '37063';
  assert.equal(ids(api.alertsForCounty(api.state.snapshot.alerts, api.state.selectedFips)).length, 0);
  assert.equal(ids(api.alertsForCounty(api.state.snapshot.alerts, '37183')).length, 1);
  assert.ok(elements);
});

test('stale zero values remain explicitly labeled as last known', () => {
  const { api } = loadStatusForTesting();
  const source = { lastSuccessAt: new Date(Date.now() - 50 * 60_000).toISOString() };
  assert.match(api.metricSummary(0, 'stale', source, 'reported'), /Last known/);
  assert.match(api.powerDetailMessage(0, 'unavailable', source), /last successful/i);
  assert.match(api.powerDetailMessage(null, 'unavailable', source), /does not mean there are no outages/i);
});

test('unavailable alert data is never rendered as a current zero or all-clear', () => {
  const { api } = loadStatusForTesting();
  assert.equal(api.alertCountLabel([], 'unavailable'), '—');
  assert.equal(api.alertCountLabel([{ id: 'known-warning' }], 'unavailable'), '1');
  assert.equal(api.alertCountLabel([], 'stale'), '0');
  assert.match(api.alertSummaryMessage([], 'unavailable', null), /no last-known alert set/i);
});

test('a failed live alert refresh retains the last successful source time and alert set', async () => {
  const { api } = loadStatusForTesting();
  const lastSuccessAt = new Date(Date.now() - 2 * 60_000).toISOString();
  api.state.snapshot = {
    sources: {
      power: { lastSuccessAt },
      weather: {
        name: 'National Weather Service',
        sourceUrl: 'https://api.weather.gov/alerts/active?area=NC',
        lastAttemptAt: lastSuccessAt,
        lastSuccessAt,
        freshness: 'fresh'
      }
    },
    power: [],
    alerts: [{
      id: 'last-known',
      event: 'Tornado Warning',
      headline: 'Last-known warning',
      severity: 'Extreme',
      urgency: 'Immediate',
      status: 'Actual',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      areaDescription: 'Wake County',
      countyFips: ['37183'],
      sourceUrl: 'https://api.weather.gov/alerts/last-known'
    }]
  };

  await assert.rejects(api.refreshWeatherAlerts({ quiet: true }), /not mocked/);
  assert.equal(api.state.liveAlerts, null);
  assert.equal(api.state.weatherSource.lastSuccessAt, lastSuccessAt);
  assert.equal(api.state.weatherSource.failureCategory, 'live-refresh-failed');
});

test('untrusted links and markup are constrained', () => {
  const { api } = loadStatusForTesting();
  const source = fs.readFileSync(statusPath, 'utf8');
  assert.equal(api.safeUrl('https://api.weather.gov/alerts/test'), 'https://api.weather.gov/alerts/test');
  assert.equal(api.safeUrl('http://example.com'), '');
  assert.equal(api.safeUrl('javascript:alert(1)'), '');
  assert.doesNotMatch(source, /\.innerHTML\s*=/, 'status rendering should keep upstream text out of HTML parsing');
});

function snapshotAt(generatedAt, powerAt = generatedAt, extra = {}) {
  return {
    schemaVersion: 1,
    state: 'NC',
    generatedAt,
    sources: { power: { lastSuccessAt: powerAt }, weather: { lastSuccessAt: generatedAt } },
    power: [{ countyFips: '37183', countyName: 'Wake', customersOut: 0 }],
    alerts: [],
    ...extra
  };
}

test('snapshot refresh failure retains previously loaded data', async () => {
  const good = snapshotAt('2026-09-13T12:00:00Z');
  const { api } = loadStatusForTesting({ fetch: async () => { throw new Error('offline'); } });
  api.state.snapshot = good;
  await assert.rejects(api.loadStatusSnapshot({ quiet: true }), /offline/);
  assert.equal(api.state.snapshot, good);
  assert.equal(api.state.snapshotError, true);
  const bad = loadStatusForTesting({ fetch: async () => ({ ok: true, json: async () => ({ schemaVersion: 2 }) }) });
  bad.api.state.snapshot = good;
  await assert.rejects(bad.api.loadStatusSnapshot({ quiet: true }), /unexpected format/);
  assert.equal(bad.api.state.snapshot, good);
});

test('an older or unavailable snapshot never replaces newer held data', async () => {
  const held = snapshotAt('2026-09-13T12:00:00Z');
  const older = snapshotAt('2026-09-13T11:00:00Z');
  const placeholder = snapshotAt('1970-01-01T00:00:00.000Z', undefined, { sources: { power: { freshness: 'unavailable' }, weather: { freshness: 'unavailable' } } });
  const newer = snapshotAt('2026-09-13T12:05:00Z');
  let response = older;
  const { api } = loadStatusForTesting({ fetch: async () => ({ ok: true, json: async () => response }) });
  api.state.snapshot = held;
  assert.equal(await api.loadStatusSnapshot({ quiet: true }), held);
  assert.equal(api.state.snapshot, held);
  response = placeholder;
  await api.loadStatusSnapshot({ quiet: true });
  assert.equal(api.state.snapshot, held);
  assert.ok(api.state.snapshotCheckedAt, 'last-checked time is recorded separately');
  response = newer;
  await api.loadStatusSnapshot({ quiet: true });
  assert.equal(api.state.snapshot, newer);
  assert.equal(api.isSnapshotAcceptable(snapshotAt('2026-09-13T12:10:00Z', '2026-09-13T11:00:00Z'), newer), false);
});

test('a second snapshot refresh while one is in flight is a no-op', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { api } = loadStatusForTesting({ fetch: async () => { calls += 1; await gate; return { ok: true, json: async () => snapshotAt('2026-09-13T12:00:00Z') }; } });
  const first = api.loadStatusSnapshot({ quiet: true });
  const second = api.loadStatusSnapshot({ quiet: true });
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 1);
  await api.loadStatusSnapshot({ quiet: true });
  assert.equal(calls, 2);
});

test('hidden tabs stop the single refresh timer and visible tabs restart it', () => {
  const { api, document, timers } = loadStatusForTesting({ fetch: async () => { throw new Error('offline'); } });
  api.startAutoRefresh();
  api.startAutoRefresh();
  assert.equal(timers.set.length, 2);
  assert.equal(timers.cleared.length, 1, 'restarting clears the previous timer');
  assert.equal(timers.set[1].delay, 5 * 60 * 1000);
  document.hidden = true;
  api.handleVisibilityChange();
  assert.equal(api.state.refreshTimer, 0);
  api.startAutoRefresh();
  assert.equal(timers.set.length, 2, 'no timer starts while hidden');
  document.hidden = false;
  api.state.snapshotLastAttemptMs = Date.now();
  api.state.weatherLastAttemptMs = Date.now();
  api.handleVisibilityChange();
  assert.equal(timers.set.length, 3);
});

test('refresh is skipped while the browser reports offline', async () => {
  let calls = 0;
  const { api } = loadStatusForTesting({ navigator: { onLine: false }, fetch: async () => { calls += 1; throw new Error('offline'); } });
  await api.refreshSourcesQuietly();
  assert.equal(calls, 0);
});

test('a stale or unavailable zero-outage county is last-known, not an all-clear', () => {
  const { api } = loadStatusForTesting();
  const source = { lastSuccessAt: new Date(Date.now() - 50 * 60_000).toISOString() };
  assert.match(api.metricSummary(0, 'stale', source, 'reported'), /^Last known: 0 reported as of .+ data is stale/);
  assert.match(api.metricSummary(0, 'unavailable', source, 'reported'), /^Last known: 0 reported as of /);
  api.state.activeLayer = 'power';
  api.state.snapshot = snapshotAt('2026-09-13T12:00:00Z');
  api.state.snapshot.sources.power = source;
  assert.equal(api.mapBandForCounty('37183'), 'unknown');
  api.state.snapshot.power[0].customersOut = 5;
  assert.equal(api.mapBandForCounty('37183'), 'low');
  api.state.snapshot.sources.power = { lastSuccessAt: new Date().toISOString() };
  api.state.snapshot.power[0].customersOut = 0;
  assert.equal(api.mapBandForCounty('37183'), 'none');
});
