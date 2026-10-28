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
