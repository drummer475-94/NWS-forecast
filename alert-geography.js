/* Shared NWS alert geography and activity logic.
 * Classic script usable as a browser global (window.NcAlertGeography), a CommonJS module, and (via
 * createRequire) from ESM scripts. It has no dependency on page globals: the NC county FIPS set is injected. */
(function (root) {
  'use strict';

  const ALERT_GEOGRAPHIES = ['county', 'statewide', 'unknown'];

  function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function geometryPolygons(geometry) {
    if (geometry && geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) return [geometry.coordinates];
    if (geometry && geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) return geometry.coordinates;
    return [];
  }

  function ringBounds(ring) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    ring.forEach(function (point) {
      if (point[0] < minX) minX = point[0];
      if (point[0] > maxX) maxX = point[0];
      if (point[1] < minY) minY = point[1];
      if (point[1] > maxY) maxY = point[1];
    });
    return [minX, minY, maxX, maxY];
  }

  function pointInRing(longitude, latitude, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const x = ring[index][0];
      const y = ring[index][1];
      const previousX = ring[previous][0];
      const previousY = ring[previous][1];
      if ((y > latitude) !== (previousY > latitude) &&
        longitude < (previousX - x) * (latitude - y) / (previousY - y) + x) {
        inside = !inside;
      }
    }
    return inside;
  }

  function pointInPolygon(longitude, latitude, polygon) {
    return Array.isArray(polygon) && polygon.length > 0 &&
      pointInRing(longitude, latitude, polygon[0]) &&
      !polygon.slice(1).some(function (hole) { return pointInRing(longitude, latitude, hole); });
  }

  function segmentOrientation(a, b, c) {
    const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
    return value === 0 ? 0 : value > 0 ? 1 : 2;
  }

  function pointOnSegment(a, b, c) {
    return b[0] <= Math.max(a[0], c[0]) && b[0] >= Math.min(a[0], c[0]) &&
      b[1] <= Math.max(a[1], c[1]) && b[1] >= Math.min(a[1], c[1]);
  }

  function segmentsIntersect(p1, q1, p2, q2) {
    const o1 = segmentOrientation(p1, q1, p2);
    const o2 = segmentOrientation(p1, q1, q2);
    const o3 = segmentOrientation(p2, q2, p1);
    const o4 = segmentOrientation(p2, q2, q1);
    if (o1 !== o2 && o3 !== o4) return true;
    return (o1 === 0 && pointOnSegment(p1, p2, q1)) || (o2 === 0 && pointOnSegment(p1, q2, q1)) ||
      (o3 === 0 && pointOnSegment(p2, p1, q2)) || (o4 === 0 && pointOnSegment(p2, q1, q2));
  }

  function ringsCross(first, second) {
    for (let index = 1; index < first.length; index++) {
      for (let other = 1; other < second.length; other++) {
        if (segmentsIntersect(first[index - 1], first[index], second[other - 1], second[other])) return true;
      }
    }
    return false;
  }

  function polygonsIntersect(first, second) {
    if (!first || !second || !first[0] || !second[0] || !first[0].length || !second[0].length) return false;
    const a = ringBounds(first[0]);
    const b = ringBounds(second[0]);
    if (a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]) return false;
    return ringsCross(first[0], second[0]) ||
      pointInPolygon(first[0][0][0], first[0][0][1], second) ||
      pointInPolygon(second[0][0][0], second[0][0][1], first);
  }

  // Legacy snapshots may lack `geography`: county IDs imply 'county'; nothing implies 'unknown', not statewide.
  function alertGeography(alert) {
    const hasCounties = Array.isArray(alert && alert.countyFips) && alert.countyFips.length > 0;
    const supplied = alert && alert.geography;
    if (ALERT_GEOGRAPHIES.indexOf(supplied) !== -1) {
      if (supplied === 'county' && !hasCounties) return 'unknown';
      return supplied;
    }
    return hasCounties ? 'county' : 'unknown';
  }

  function isAlertActive(alert, nowMs) {
    const currentTime = Number.isFinite(nowMs) ? nowMs : Date.now();
    // Only real (Actual) messages count; Test/Exercise/System/Draft and cancellations never display as active.
    if (!alert || (alert.status && alert.status !== 'Actual') || alert.messageType === 'Cancel') return false;
    if (!(Date.parse(alert.expiresAt) > currentTime)) return false;
    return !alert.endsAt || !(Date.parse(alert.endsAt) <= currentTime);
  }

  // Builds the FIPS-dependent functions for a given county FIPS set (Set or array of 'NNNNN' strings).
  // `zoneTable` is the default forecast-zone (NCZ###) to county FIPS lookup; it is intentionally empty in
  // production because zone-to-county mappings are never guessed.
  function createAlertGeography(config) {
    const options = config || {};
    const validFips = new Set(Array.from(options.countyFips || []).map(String));
    const defaultZoneTable = options.zoneTable || {};

    // FIPS values of counties whose boundary intersects the alert geometry (edge crossing or containment).
    function countyFipsIntersecting(alertGeometry, boundaries) {
      const alertPolygons = geometryPolygons(alertGeometry);
      if (!alertPolygons.length || !boundaries || !Array.isArray(boundaries.features)) return [];
      const result = [];
      try {
        boundaries.features.forEach(function (feature) {
          const fips = String(feature && feature.properties && feature.properties.GEOID || '');
          if (!validFips.has(fips)) return;
          const countyPolygons = geometryPolygons(feature.geometry);
          if (alertPolygons.some(function (polygon) {
            return countyPolygons.some(function (county) { return polygonsIntersect(polygon, county); });
          })) result.push(fips);
        });
      } catch (error) {
        return []; // Malformed alert geometry must not break parsing; the alert is matched by identifiers only.
      }
      return result;
    }

    // Maps an alert to counties without guessing: SAME, UGC county codes (NCC), affectedZones county/forecast
    // URLs, the zone table (NCZ), then polygon geometry when boundaries are supplied. Unmappable alerts are
    // 'unknown', never treated as applying everywhere.
    function deriveAlertGeography(properties, geometry, boundaries, zoneTable) {
      const props = properties || {};
      const table = zoneTable || defaultZoneTable;
      const ids = new Set();
      const geocode = props.geocode || {};
      (Array.isArray(geocode.SAME) ? geocode.SAME : []).forEach(function (code) {
        const value = String(code);
        const fips = /^037\d{3}$/.test(value) ? value.slice(1) : value;
        if (validFips.has(fips)) ids.add(fips);
      });
      let unmappedZones = 0;
      if (!ids.size) {
        const codes = new Set(Array.isArray(geocode.UGC) ? geocode.UGC.map(String) : []);
        (Array.isArray(props.affectedZones) ? props.affectedZones : []).forEach(function (url) {
          const match = /\/zones\/(?:county|forecast)\/(NC[CZ]\d{3})\/?$/.exec(String(url));
          if (match) codes.add(match[1]);
        });
        codes.forEach(function (code) {
          if (/^NCC\d{3}$/.test(code)) {
            const fips = '37' + code.slice(3);
            if (validFips.has(fips)) ids.add(fips);
          } else if (/^NCZ\d{3}$/.test(code)) {
            const fips = Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
            if (typeof fips === 'string' && validFips.has(fips)) ids.add(fips);
            else unmappedZones += 1;
          }
        });
        if ((!ids.size || unmappedZones) && boundaries) {
          countyFipsIntersecting(geometry, boundaries).forEach(function (fips) { ids.add(fips); });
        }
      }
      const countyFips = Array.from(ids).sort();
      if (countyFips.length === validFips.size) return { geography: 'statewide', countyFips: countyFips };
      if (countyFips.length) return { geography: 'county', countyFips: countyFips };
      if (/^north carolina$/i.test(cleanText(props.areaDesc))) return { geography: 'statewide', countyFips: [] };
      return { geography: 'unknown', countyFips: [] };
    }

    return {
      countyFipsIntersecting: countyFipsIntersecting,
      deriveAlertGeography: deriveAlertGeography
    };
  }

  const api = {
    ALERT_GEOGRAPHIES: ALERT_GEOGRAPHIES,
    alertGeography: alertGeography,
    createAlertGeography: createAlertGeography,
    geometryPolygons: geometryPolygons,
    isAlertActive: isAlertActive,
    pointInPolygon: pointInPolygon,
    polygonsIntersect: polygonsIntersect
  };

  root.NcAlertGeography = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
