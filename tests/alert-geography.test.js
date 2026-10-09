'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const geo = require('../alert-geography.js');

const COUNTY_FIPS = Array.from({ length: 100 }, (_, index) => '37' + String(index * 2 + 1).padStart(3, '0'));
const { deriveAlertGeography } = geo.createAlertGeography({ countyFips: COUNTY_FIPS });

const square = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const boundaries = {
  features: [
    { properties: { GEOID: '37001' }, geometry: { type: 'Polygon', coordinates: square(0, 0, 1, 1) } },
    { properties: { GEOID: '37003' }, geometry: { type: 'Polygon', coordinates: square(2, 0, 3, 1) } },
    { properties: { GEOID: '51001' }, geometry: { type: 'Polygon', coordinates: square(0, 0, 9, 9) } }
  ]
};

test('exposes the API on globalThis and CommonJS exports', () => {
  assert.equal(globalThis.NcAlertGeography, geo);
});

test('SAME codes win, with or without the 0 prefix', () => {
  const result = deriveAlertGeography({ geocode: { SAME: ['037183', '37001', '999999'], UGC: ['NCC003'] } }, null);
  assert.deepEqual(result, { geography: 'county', countyFips: ['37001', '37183'] });
});

test('UGC county codes map to counties', () => {
  assert.deepEqual(deriveAlertGeography({ geocode: { UGC: ['NCC001', 'NCC003', 'NCC002'] } }, null),
    { geography: 'county', countyFips: ['37001', '37003'] });
});

test('affectedZones county and forecast URLs are read', () => {
  const result = deriveAlertGeography({ affectedZones: ['https://api.weather.gov/zones/county/NCC005/'] }, null);
  assert.deepEqual(result, { geography: 'county', countyFips: ['37005'] });
  const zone = deriveAlertGeography({ affectedZones: ['https://api.weather.gov/zones/forecast/NCZ041'] }, null, null, { NCZ041: '37183' });
  assert.deepEqual(zone, { geography: 'county', countyFips: ['37183'] });
});

test('zone table can be injected per call or per factory; unmapped zones stay unknown', () => {
  const props = { geocode: { UGC: ['NCZ041'] } };
  assert.equal(deriveAlertGeography(props, null).geography, 'unknown');
  assert.deepEqual(deriveAlertGeography(props, null, null, { NCZ041: '37183' }).countyFips, ['37183']);
  assert.deepEqual(deriveAlertGeography(props, null, null, { NCZ041: '99999' }).countyFips, []);
  const custom = geo.createAlertGeography({ countyFips: COUNTY_FIPS, zoneTable: { NCZ041: '37001' } });
  assert.deepEqual(custom.deriveAlertGeography(props, null).countyFips, ['37001']);
});

test('polygon intersection is used when nothing is mapped or zones are unmapped', () => {
  const alertPolygon = { type: 'Polygon', coordinates: square(0.5, 0.5, 0.9, 0.9) };
  assert.deepEqual(deriveAlertGeography({}, alertPolygon, boundaries), { geography: 'county', countyFips: ['37001'] });
  const crossing = { type: 'Polygon', coordinates: square(0.5, 0.2, 2.5, 0.8) };
  assert.deepEqual(deriveAlertGeography({ geocode: { UGC: ['NCZ041'] } }, crossing, boundaries).countyFips, ['37001', '37003']);
  assert.equal(deriveAlertGeography({}, alertPolygon).geography, 'unknown');
  assert.deepEqual(deriveAlertGeography({}, { type: 'Polygon', coordinates: 'bad' }, boundaries), { geography: 'unknown', countyFips: [] });
});

test('all counties or areaDesc "North Carolina" is statewide; anything else is unknown', () => {
  const all = deriveAlertGeography({ geocode: { SAME: COUNTY_FIPS.map((f) => '0' + f) } }, null);
  assert.equal(all.geography, 'statewide');
  assert.equal(all.countyFips.length, 100);
  assert.deepEqual(deriveAlertGeography({ areaDesc: 'North Carolina' }, null), { geography: 'statewide', countyFips: [] });
  assert.equal(deriveAlertGeography({ areaDesc: 'Central North Carolina' }, null).geography, 'unknown');
  assert.deepEqual(deriveAlertGeography({}, null), { geography: 'unknown', countyFips: [] });
});

test('alertGeography normalizes legacy alerts', () => {
  assert.equal(geo.alertGeography({ countyFips: ['37001'] }), 'county');
  assert.equal(geo.alertGeography({}), 'unknown');
  assert.equal(geo.alertGeography({ geography: 'county' }), 'unknown');
  assert.equal(geo.alertGeography({ geography: 'statewide' }), 'statewide');
});

test('isAlertActive applies status, cancel, expiry and end rules', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const base = { status: 'Actual', expiresAt: '2026-10-09T13:00:00Z' };
  assert.equal(geo.isAlertActive(base, now), true);
  assert.equal(geo.isAlertActive({ expiresAt: base.expiresAt }, now), true);
  assert.equal(geo.isAlertActive({ ...base, status: 'Test' }, now), false);
  assert.equal(geo.isAlertActive({ ...base, status: 'Exercise' }, now), false);
  assert.equal(geo.isAlertActive({ ...base, messageType: 'Cancel' }, now), false);
  assert.equal(geo.isAlertActive({ ...base, expiresAt: '2026-10-09T11:00:00Z' }, now), false);
  assert.equal(geo.isAlertActive({ ...base, endsAt: '2026-10-09T11:30:00Z' }, now), false);
  assert.equal(geo.isAlertActive({ ...base, endsAt: '2026-10-09T12:30:00Z' }, now), true);
  assert.equal(geo.isAlertActive(null, now), false);
});

test('pointInPolygon respects holes', () => {
  const polygon = [square(0, 0, 4, 4)[0], square(1, 1, 2, 2)[0]];
  assert.equal(geo.pointInPolygon(3, 3, polygon), true);
  assert.equal(geo.pointInPolygon(1.5, 1.5, polygon), false);
  assert.equal(geo.pointInPolygon(9, 9, polygon), false);
});
