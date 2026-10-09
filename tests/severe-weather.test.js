'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sw = require('../severe-weather.js');

const NOW = Date.parse('2026-07-01T12:00:00Z');
const MIN = 60000;
const iso = (offsetMin) => new Date(NOW + offsetMin * MIN).toISOString();

function feature(overrides = {}, id = 'urn:oid:1') {
  const url = 'https://api.weather.gov/alerts/' + id;
  return {
    id: url,
    type: 'Feature',
    properties: Object.assign({
      '@id': url, id, areaDesc: 'Wake, NC', status: 'Actual', messageType: 'Alert',
      sent: iso(-10), effective: iso(-10), onset: iso(-10), expires: iso(45), ends: iso(45),
      event: 'Tornado Warning', severity: 'Extreme', urgency: 'Immediate', certainty: 'Observed',
      headline: 'Tornado Warning issued for Wake County', senderName: 'NWS Raleigh NC',
      description: 'A tornado was observed.\n\nTake cover now.', instruction: 'Move to an interior room.'
    }, overrides)
  };
}

test('exposes the API on globalThis and CommonJS exports', () => {
  assert.equal(globalThis.NwsSevereWeather, sw);
  assert.equal(typeof sw.selectSevereAlerts, 'function');
});

test('selects active warnings and normalizes fields verbatim', () => {
  const [alert] = sw.selectSevereAlerts([feature()], NOW);
  assert.equal(alert.id, 'https://api.weather.gov/alerts/urn:oid:1');
  assert.equal(alert.event, 'Tornado Warning');
  assert.equal(alert.description, 'A tornado was observed.\n\nTake cover now.');
  assert.equal(alert.instruction, 'Move to an interior room.');
  assert.equal(alert.endsAt, iso(45));
  assert.equal(alert.areaDesc, 'Wake, NC');
  assert.equal(alert.senderName, 'NWS Raleigh NC');
  assert.equal(alert.officialUrl, 'https://api.weather.gov/alerts/urn:oid:1');
});

test('excludes Test, Cancel, expired, future-effective, watches and advisories', () => {
  const features = [
    feature({ status: 'Test' }, 'a'),
    feature({ messageType: 'Cancel' }, 'b'),
    feature({ ends: iso(-1), expires: iso(-1) }, 'c'),
    feature({ effective: iso(30), onset: iso(30) }, 'd'),
    feature({ onset: iso(30) }, 'e'),
    feature({ event: 'Tornado Watch' }, 'f'),
    feature({ event: 'Flood Advisory' }, 'g'),
    feature({ ends: null, expires: null }, 'h'),
    feature({}, 'ok')
  ];
  const result = sw.selectSevereAlerts(features, NOW);
  assert.deepEqual(result.map((a) => a.id.split('/').pop()), ['ok']);
});

test('uses ends over expires, falls back to expires, and tolerates missing effective/onset', () => {
  const [a] = sw.selectSevereAlerts([feature({ ends: null, effective: undefined, onset: undefined, expires: iso(10) })], NOW);
  assert.equal(a.endsAt, iso(10));
  assert.equal(sw.selectSevereAlerts([feature({ ends: iso(-5), expires: iso(60) })], NOW).length, 0);
});

test('sorts by priority then soonest expiry, with other warnings last', () => {
  const features = [
    feature({ event: 'Special Marine Warning', ends: iso(5) }, 'marine'),
    feature({ event: 'Flash Flood Warning', ends: iso(50) }, 'ff-late'),
    feature({ event: 'Flash Flood Warning', ends: iso(20) }, 'ff-soon'),
    feature({ event: 'Severe Thunderstorm Warning', ends: iso(90) }, 'svr'),
    feature({ event: 'Tornado Warning', ends: iso(60) }, 'tor'),
    feature({ event: 'Winter Storm Warning', ends: iso(70) }, 'winter')
  ];
  const order = sw.selectSevereAlerts(features, NOW).map((a) => a.id.split('/').pop());
  assert.deepEqual(order, ['tor', 'svr', 'ff-soon', 'ff-late', 'winter', 'marine']);
});

test('officialUrl is only kept for https://api.weather.gov/ URLs', () => {
  const evil = (url) => {
    const f = feature({}, 'x');
    f.properties['@id'] = url;
    f.properties.id = 'plain-id';
    f.id = url;
    return sw.selectSevereAlerts([f], NOW)[0];
  };
  assert.equal(evil('https://api.weather.gov/alerts/x').officialUrl, 'https://api.weather.gov/alerts/x');
  assert.equal(evil('http://api.weather.gov/alerts/x').officialUrl, '');
  assert.equal(evil('https://api.weather.gov.evil.com/alerts/x').officialUrl, '');
  assert.equal(evil('https://evil.com/https://api.weather.gov/').officialUrl, '');
  assert.equal(evil('javascript:alert(1)').officialUrl, '');
  assert.equal(evil('https://user@api.weather.gov/alerts/x').officialUrl, '');
});

test('extracts plain-string parameters only', () => {
  const [a] = sw.selectSevereAlerts([feature({
    parameters: {
      tornadoDetection: ['OBSERVED'], maxHailSize: ['1.75'], maxWindGust: ['70 MPH'],
      thunderstormDamageThreat: [{ bad: true }, 'CONSIDERABLE'], flashFloodDamageThreat: 'CATASTROPHIC'
    }
  })], NOW);
  assert.equal(a.tornadoDetection, 'OBSERVED');
  assert.equal(a.maxHailSize, '1.75');
  assert.equal(a.maxWindGust, '70 MPH');
  assert.equal(a.thunderstormDamageThreat, 'CONSIDERABLE');
  assert.equal(a.flashFloodDamageThreat, '');
});

test('is defensive about missing fields and bad input', () => {
  assert.deepEqual(sw.selectSevereAlerts(null, NOW), []);
  assert.deepEqual(sw.selectSevereAlerts([null, {}, { properties: null }, { properties: { event: 5 } }], NOW), []);
  const [a] = sw.selectSevereAlerts([{ properties: { event: 'Tornado Warning', status: 'Actual', ends: iso(5), '@id': 7, id: 'only-id' } }], NOW);
  assert.equal(a.id, 'only-id');
  assert.equal(a.headline, '');
  assert.equal(a.description, '');
  assert.equal(a.instruction, '');
  assert.equal(a.officialUrl, '');
  assert.equal(a.tornadoDetection, '');
});

test('de-duplicates alerts by id', () => {
  assert.equal(sw.selectSevereAlerts([feature(), feature()], NOW).length, 1);
});

test('severeModeKey is stable regardless of order and empty-safe', () => {
  const a = { id: 'b' };
  const b = { id: 'a' };
  assert.equal(sw.severeModeKey([a, b]), sw.severeModeKey([b, a]));
  assert.equal(sw.severeModeKey([a, b]), 'a|b');
  assert.notEqual(sw.severeModeKey([a]), sw.severeModeKey([a, b]));
  assert.equal(sw.severeModeKey([]), '');
  assert.equal(sw.severeModeKey(null), '');
});

test('countyFipsFromPoint maps NWS county zones', () => {
  const point = (county) => ({ county });
  assert.equal(sw.countyFipsFromPoint(point('https://api.weather.gov/zones/county/NCC183')), '37183');
  assert.equal(sw.countyFipsFromPoint(point('https://api.weather.gov/zones/county/NCC001/')), '37001');
  assert.equal(sw.countyFipsFromPoint(point('https://api.weather.gov/zones/county/TXC201')), '48201');
  assert.equal(sw.countyFipsFromPoint(point('https://api.weather.gov/zones/county/ZZC001')), '');
  assert.equal(sw.countyFipsFromPoint(point('https://api.weather.gov/zones/forecast/NCZ041')), '');
  assert.equal(sw.countyFipsFromPoint(point('https://evil.example/zones/county/NCC183')), '');
  assert.equal(sw.countyFipsFromPoint(point('https://api.weather.gov/zones/county/NCC18')), '');
  assert.equal(sw.countyFipsFromPoint({ county: 5 }), '');
  assert.equal(sw.countyFipsFromPoint(null), '');
});

test('isNorthCarolinaFips', () => {
  assert.equal(sw.isNorthCarolinaFips('37183'), true);
  assert.equal(sw.isNorthCarolinaFips('48201'), false);
  assert.equal(sw.isNorthCarolinaFips('3718'), false);
  assert.equal(sw.isNorthCarolinaFips(37183), false);
});

function snapshot(ageMin, extra = {}) {
  return Object.assign({
    schemaVersion: 1,
    generatedAt: iso(-ageMin),
    state: 'NC',
    sources: {
      power: { name: 'NC Emergency Management', sourceUrl: 'https://fusion.ncsparta.gov/ReadyNC_PowerOutageAPI/html', lastAttemptAt: iso(-ageMin), lastSuccessAt: iso(-ageMin), freshness: 'fresh' },
      weather: { name: 'National Weather Service', sourceUrl: 'https://api.weather.gov/alerts/active?area=NC', lastSuccessAt: iso(-ageMin) }
    },
    power: [{ countyFips: '37183', countyName: 'Wake', customersOut: 1234, customersServed: 450000 }, { countyFips: '37001', countyName: 'Alamance', customersOut: 0 }],
    alerts: []
  }, extra);
}

test('countyOutageFromSnapshot: fresh', () => {
  const o = sw.countyOutageFromSnapshot(snapshot(2), '37183', NOW);
  assert.deepEqual(o, {
    supported: true, countyName: 'Wake County', customersOut: 1234, asOf: iso(-2), freshness: 'fresh',
    sourceName: 'NC Emergency Management', sourceUrl: 'https://fusion.ncsparta.gov/ReadyNC_PowerOutageAPI/html'
  });
});

test('countyOutageFromSnapshot: freshness thresholds match status.js (45 and 60 minutes)', () => {
  assert.equal(sw.POWER_FRESH_MS, 45 * 60 * 1000);
  assert.equal(sw.POWER_STALE_MS, 60 * 60 * 1000);
  assert.equal(sw.countyOutageFromSnapshot(snapshot(45), '37183', NOW).freshness, 'fresh');
  const stale = sw.countyOutageFromSnapshot(snapshot(46), '37183', NOW);
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.customersOut, 1234);
  assert.equal(sw.countyOutageFromSnapshot(snapshot(60), '37183', NOW).freshness, 'stale');
  const gone = sw.countyOutageFromSnapshot(snapshot(61), '37183', NOW);
  assert.equal(gone.freshness, 'unavailable');
  assert.equal(gone.customersOut, 1234);
  assert.equal(gone.asOf, iso(-61));
  const noTime = snapshot(2);
  delete noTime.sources.power.lastSuccessAt;
  assert.equal(sw.countyOutageFromSnapshot(noTime, '37183', NOW).customersOut, null);
});

test('countyOutageFromSnapshot: missing county, invalid snapshot, non-NC', () => {
  const missing = sw.countyOutageFromSnapshot(snapshot(2), '37999', NOW);
  assert.equal(missing.supported, true);
  assert.equal(missing.freshness, 'unavailable');
  assert.equal(missing.customersOut, null);
  for (const bad of [null, undefined, 'x', {}, { power: 'x', sources: null }, { power: [], sources: { power: {} } }]) {
    const o = sw.countyOutageFromSnapshot(bad, '37183', NOW);
    assert.equal(o.supported, true);
    assert.equal(o.freshness, 'unavailable');
    assert.equal(o.customersOut, null);
  }
  const bad = snapshot(2);
  bad.power[0].customersOut = -5;
  assert.equal(sw.countyOutageFromSnapshot(bad, '37183', NOW).customersOut, null);
  const tx = sw.countyOutageFromSnapshot(snapshot(2), '48201', NOW);
  assert.equal(tx.supported, false);
  assert.equal(tx.customersOut, null);
});

test('formatOutageSummary covers every branch', () => {
  const fmt = () => '12:38 AM';
  const base = sw.countyOutageFromSnapshot(snapshot(2), '37183', NOW);
  assert.equal(sw.formatOutageSummary(base, fmt), '1,234 customers without power in Wake County (NC Emergency Management, as of 12:38 AM)');
  assert.equal(sw.formatOutageSummary({ ...base, customersOut: 0 }, fmt), 'No reported outages in Wake County as of 12:38 AM');
  assert.equal(sw.formatOutageSummary({ ...base, freshness: 'stale' }, fmt), 'Last known: 1,234 customers without power in Wake County as of 12:38 AM — data is stale');
  assert.equal(sw.formatOutageSummary({ ...base, freshness: 'unavailable' }, fmt), 'Last known: 1,234 customers without power in Wake County as of 12:38 AM \u2014 current update unavailable');
  assert.equal(sw.formatOutageSummary({ ...base, freshness: 'unavailable', customersOut: null }, fmt), 'Outage data for Wake County is unavailable right now.');
  assert.equal(sw.formatOutageSummary({ supported: false }, fmt), 'Power outage data is available for North Carolina locations only.');
  assert.equal(sw.formatOutageSummary(null, fmt), 'Power outage data is available for North Carolina locations only.');
  assert.equal(sw.formatOutageSummary({ ...base, customersOut: 1 }, fmt), '1 customer without power in Wake County (NC Emergency Management, as of 12:38 AM)');
});

test('formatExpiry covers every branch', () => {
  const fmt = () => '3:45 PM';
  assert.equal(sw.formatExpiry(iso(25), NOW, fmt), 'Expires 3:45 PM (in 25 min)');
  assert.equal(sw.formatExpiry(iso(0.2), NOW, fmt), 'Expires 3:45 PM (in 1 min)');
  assert.equal(sw.formatExpiry(iso(60), NOW, fmt), 'Expires 3:45 PM (in 1 hr)');
  assert.equal(sw.formatExpiry(iso(135), NOW, fmt), 'Expires 3:45 PM (in 2 hr 15 min)');
  assert.equal(sw.formatExpiry(iso(-1), NOW, fmt), 'Expired');
  assert.equal(sw.formatExpiry(iso(0), NOW, fmt), 'Expired');
  assert.equal(sw.formatExpiry('', NOW, fmt), 'Expiry not specified');
  assert.equal(sw.formatExpiry(undefined, NOW, fmt), 'Expiry not specified');
  assert.equal(sw.formatExpiry('garbage', NOW, fmt), 'Expiry not specified');
});
