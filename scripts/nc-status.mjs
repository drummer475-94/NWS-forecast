import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const NWS_ALERTS_URL = "https://api.weather.gov/alerts/active?area=NC";
export const NCEM_POWER_URL = "https://fusion.ncsparta.gov/ReadyNC_PowerOutageAPI/html";

const FRESHNESS_VALUES = new Set(["fresh", "stale", "unavailable"]);
const ALERT_SEVERITIES = new Set(["Extreme", "Severe", "Moderate", "Minor", "Unknown"]);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nonnegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function validIso(value) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const NC_COUNTY_FIPS = Array.from({ length: 100 }, (_, index) => `37${String(index * 2 + 1).padStart(3, "0")}`);
const ALERT_GEOGRAPHY_VALUES = new Set(["county", "statewide", "unknown"]);

// Forecast-zone (NCZ###) to county FIPS lookups are intentionally empty: the table could not be derived
// reliably from the NWS zones API at authoring time, and zone-to-county mappings are never guessed.
// Zone-only alerts resolve through SAME/UGC county codes, affectedZones county URLs, or polygon geometry.
export const NC_ZONE_TO_COUNTY_FIPS = Object.freeze({});

const geo = require("../alert-geography.js");
const { countyFipsIntersecting: intersectingCountyFips, deriveAlertGeography: deriveGeography } =
  geo.createAlertGeography({ countyFips: NC_COUNTY_FIPS, zoneTable: NC_ZONE_TO_COUNTY_FIPS });

// Returns FIPS values of counties whose boundary intersects the alert geometry.
export function countyFipsIntersecting(alertGeometry, boundaries) {
  return intersectingCountyFips(alertGeometry, boundaries);
}

// Maps an NWS alert to counties without guessing. Order: SAME, UGC county codes (NCC), affectedZones county
// URLs, configured zone table (NCZ), then polygon geometry when county boundaries are supplied.
export function deriveAlertGeography(properties, geometry, { boundaries, zoneTable = NC_ZONE_TO_COUNTY_FIPS } = {}) {
  return deriveGeography(properties, geometry, boundaries, zoneTable);
}

export const isAlertActive = geo.isAlertActive;

function normalizeCountyName(value) {
  return cleanText(value).replace(/\s+COUNTY$/i, "").toUpperCase();
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlText(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function parseOutageCount(value) {
  const normalized = htmlText(value).replace(/,/g, "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseNcemHtml(input, countyCatalog) {
  const countyByName = new Map(countyCatalog.map((county) => [normalizeCountyName(county.name), county]));
  const counts = new Map();
  let sawHeader = false;
  let statewideTotal;

  for (const rowMatch of input.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from(rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi), (match) => htmlText(match[1]));
    if (cells.length < 2) continue;

    const label = cells[0];
    const labelKey = normalizeCountyName(label);
    if (labelKey === "COUNTY") {
      sawHeader = true;
      continue;
    }
    if (/^STATEWIDE OUTAGES$/i.test(label)) {
      statewideTotal = parseOutageCount(cells[1]);
      if (statewideTotal === undefined) throw new Error("power-schema");
      continue;
    }

    const county = countyByName.get(labelKey);
    if (!county) continue;
    const customersOut = parseOutageCount(cells[1]);
    if (customersOut === undefined || counts.has(county.fips)) throw new Error("power-schema");
    counts.set(county.fips, customersOut);
  }

  if (!sawHeader || statewideTotal === undefined) throw new Error("power-schema");
  const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
  if (total !== statewideTotal) throw new Error("power-schema");

  return countyCatalog.map((county) => ({
    countyFips: county.fips,
    countyName: county.name,
    customersOut: counts.get(county.fips) ?? 0,
  }));
}

export function countyCatalogFromGeoJson(input) {
  if (!input || input.type !== "FeatureCollection" || !Array.isArray(input.features)) {
    throw new Error("county-geometry-schema");
  }

  const counties = input.features.map((feature) => {
    const fips = String(feature?.properties?.GEOID ?? "");
    const rawName = cleanText(feature?.properties?.NAME);
    const name = rawName.replace(/\s+County$/i, "");
    const geometryType = feature?.geometry?.type;
    if (!/^37\d{3}$/.test(fips) || !name || (geometryType !== "Polygon" && geometryType !== "MultiPolygon")) {
      throw new Error("county-geometry-schema");
    }
    return { fips, name };
  });

  const fipsValues = new Set(counties.map((county) => county.fips));
  const names = new Set(counties.map((county) => normalizeCountyName(county.name)));
  if (counties.length !== 100 || fipsValues.size !== 100 || names.size !== 100) {
    throw new Error("county-geometry-completeness");
  }
  return counties.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseNcem(input, countyCatalog) {
  if (!Array.isArray(countyCatalog) || !countyCatalog.length) throw new Error("county-catalog-missing");

  if (typeof input === "string") return parseNcemHtml(input, countyCatalog);

  const features = input?.features;
  if (!Array.isArray(features)) throw new Error("power-schema");

  const countyByName = new Map(countyCatalog.map((county) => [normalizeCountyName(county.name), county]));
  return features.map((feature) => {
    const attributes = feature?.attributes;
    if (!attributes || typeof attributes !== "object") throw new Error("power-schema");
    const suppliedName = cleanText(attributes.CountyName ?? attributes.name ?? attributes.NAME ?? attributes.county ?? attributes.COUNTY);
    const identity = countyByName.get(normalizeCountyName(suppliedName));
    const customersOut = nonnegativeNumber(attributes.Outages ?? attributes.customers_out ?? attributes.CUSTOMERS_OUT ?? attributes.outages);
    if (!identity || customersOut === undefined || !Number.isInteger(customersOut)) throw new Error("power-schema");

    const result = {
      countyFips: identity.fips,
      countyName: identity.name,
      customersOut,
    };
    const customersServed = nonnegativeNumber(attributes.total_customers ?? attributes.TOTAL_CUSTOMERS ?? attributes.customers_served);
    const suppliedPercent = nonnegativeNumber(attributes.perc_out ?? attributes.PERC_OUT ?? attributes.percent_out);
    const percentOut = suppliedPercent ?? (customersServed ? customersOut / customersServed * 100 : undefined);
    if (customersServed !== undefined) result.customersServed = customersServed;
    if (percentOut !== undefined) result.percentOut = percentOut;
    return result;
  });
}

export function parseNws(input, nowMs = Date.now(), options = {}) {
  const features = input?.features;
  if (!Array.isArray(features)) throw new Error("weather-schema");

  return features.map((feature) => {
    const properties = feature?.properties;
    if (!properties || typeof properties !== "object") throw new Error("weather-schema");
    const id = cleanText(properties.id) || cleanText(feature?.id);
    const event = cleanText(properties.event);
    const expiresAt = validIso(properties.expires);
    if (!id || !event || !expiresAt) throw new Error("weather-schema");

    const { geography, countyFips } = deriveAlertGeography(properties, feature?.geometry, options);
    const suppliedSeverity = cleanText(properties.severity);
    const severity = ALERT_SEVERITIES.has(suppliedSeverity) ? suppliedSeverity : "Unknown";
    const suppliedUrl = cleanText(properties["@id"]);
    const sourceUrl = isHttpsUrl(suppliedUrl) ? suppliedUrl : `https://api.weather.gov/alerts/${encodeURIComponent(id)}`;

    return {
      id,
      event,
      headline: cleanText(properties.headline) || event,
      severity,
      urgency: cleanText(properties.urgency) || "Unknown",
      certainty: cleanText(properties.certainty) || "Unknown",
      status: cleanText(properties.status) || "Actual",
      messageType: cleanText(properties.messageType) || undefined,
      sentAt: validIso(properties.sent) || expiresAt,
      effectiveAt: validIso(properties.effective),
      onsetAt: validIso(properties.onset),
      expiresAt,
      endsAt: validIso(properties.ends),
      areaDescription: cleanText(properties.areaDesc) || "North Carolina",
      geography,
      countyFips,
      description: cleanText(properties.description) || undefined,
      instruction: cleanText(properties.instruction) || undefined,
      senderName: cleanText(properties.senderName) || "National Weather Service",
      sourceUrl,
    };
  }).filter((alert) => isAlertActive(alert, nowMs));
}

export function unavailableSnapshot(at = new Date().toISOString()) {
  const source = (name, sourceUrl) => ({
    name,
    sourceUrl,
    lastAttemptAt: at,
    freshness: "unavailable",
    failureCategory: "no-valid-snapshot",
  });
  return {
    schemaVersion: 1,
    generatedAt: at,
    state: "NC",
    sources: {
      power: source("NC Emergency Management", NCEM_POWER_URL),
      weather: source("National Weather Service", NWS_ALERTS_URL),
    },
    power: [],
    alerts: [],
  };
}

export function isStatusSnapshot(value) {
  return Boolean(
    value &&
    value.schemaVersion === 1 &&
    value.state === "NC" &&
    value.sources?.power &&
    value.sources?.weather &&
    Array.isArray(value.power) &&
    Array.isArray(value.alerts)
  );
}

function validateSource(source, key, requireComplete, latestSafeTime) {
  if (!source || !cleanText(source.name) || !isHttpsUrl(source.sourceUrl) || !validIso(source.lastAttemptAt) ||
    Date.parse(source.lastAttemptAt) > latestSafeTime) {
    throw new Error(`${key}-source-schema`);
  }
  if (!FRESHNESS_VALUES.has(source.freshness)) throw new Error(`${key}-source-freshness`);
  if (source.lastSuccessAt && (!validIso(source.lastSuccessAt) || Date.parse(source.lastSuccessAt) > latestSafeTime)) {
    throw new Error(`${key}-source-success-time`);
  }
  if (source.observedAt !== undefined && (!validIso(source.observedAt) || Date.parse(source.observedAt) > latestSafeTime)) {
    throw new Error(`${key}-source-observed-time`);
  }
  if (source.failureCategory !== undefined && !cleanText(source.failureCategory)) throw new Error(`${key}-source-failure-category`);
  if (requireComplete && (source.freshness !== "fresh" || !source.lastSuccessAt)) {
    throw new Error(`${key}-source-not-fresh`);
  }
}

export function validateSnapshot(snapshot, countyCatalog, options = {}) {
  const requireComplete = options.requireComplete !== false;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const latestSafeTime = nowMs + MAX_CLOCK_SKEW_MS;
  if (!isStatusSnapshot(snapshot) || !validIso(snapshot.generatedAt) || Date.parse(snapshot.generatedAt) > latestSafeTime) {
    throw new Error("snapshot-schema");
  }
  validateSource(snapshot.sources.power, "power", requireComplete, latestSafeTime);
  validateSource(snapshot.sources.weather, "weather", requireComplete, latestSafeTime);
  if (Number.isFinite(options.maxSourceAgeMs)) {
    for (const key of ["power", "weather"]) {
      const timestamp = Date.parse(snapshot.sources[key].lastSuccessAt);
      if (!Number.isFinite(timestamp) || nowMs - timestamp > options.maxSourceAgeMs) {
        throw new Error(`${key}-source-too-old`);
      }
    }
    if (nowMs - Date.parse(snapshot.generatedAt) > options.maxSourceAgeMs) throw new Error("snapshot-too-old");
  }

  const expectedCounties = new Map((countyCatalog ?? []).map((county) => [county.fips, county.name]));
  const expectedFips = new Set(expectedCounties.keys());
  const seenFips = new Set();
  for (const record of snapshot.power) {
    if (!record || !/^37\d{3}$/.test(record.countyFips) || !cleanText(record.countyName) ||
      !Number.isInteger(record.customersOut) || record.customersOut < 0 || seenFips.has(record.countyFips)) {
      throw new Error("power-record-schema");
    }
    if (expectedFips.size && !expectedFips.has(record.countyFips)) throw new Error("power-record-county");
    if (expectedFips.size && normalizeCountyName(record.countyName) !== normalizeCountyName(expectedCounties.get(record.countyFips))) {
      throw new Error("power-record-county-name");
    }
    if (record.customersServed !== undefined && nonnegativeNumber(record.customersServed) === undefined) {
      throw new Error("power-record-customers-served");
    }
    if (record.percentOut !== undefined && nonnegativeNumber(record.percentOut) === undefined) {
      throw new Error("power-record-percent");
    }
    if (record.estimatedRestoration !== undefined && !cleanText(record.estimatedRestoration)) {
      throw new Error("power-record-restoration");
    }
    seenFips.add(record.countyFips);
  }
  if (requireComplete && (snapshot.power.length !== 100 || seenFips.size !== 100 || expectedFips.size !== 100)) {
    throw new Error("power-record-completeness");
  }

  for (const alert of snapshot.alerts) {
    if (!alert || !cleanText(alert.id) || !cleanText(alert.event) || !ALERT_SEVERITIES.has(alert.severity) ||
      !cleanText(alert.headline) || !cleanText(alert.urgency) || !cleanText(alert.certainty) || !cleanText(alert.status) ||
      !validIso(alert.sentAt) || !validIso(alert.expiresAt) || !cleanText(alert.areaDescription) || !cleanText(alert.senderName) ||
      (alert.effectiveAt !== undefined && !validIso(alert.effectiveAt)) ||
      (alert.onsetAt !== undefined && !validIso(alert.onsetAt)) ||
      (alert.endsAt !== undefined && !validIso(alert.endsAt)) ||
      (alert.description !== undefined && typeof alert.description !== "string") ||
      (alert.instruction !== undefined && typeof alert.instruction !== "string") ||
      (alert.messageType !== undefined && !cleanText(alert.messageType)) ||
      (alert.geography !== undefined && !ALERT_GEOGRAPHY_VALUES.has(alert.geography)) ||
      (alert.geography === "unknown" && Array.isArray(alert.countyFips) && alert.countyFips.length > 0) ||
      (alert.geography === "county" && Array.isArray(alert.countyFips) && alert.countyFips.length === 0) ||
      !Array.isArray(alert.countyFips) || new Set(alert.countyFips).size !== alert.countyFips.length || !isHttpsUrl(alert.sourceUrl) ||
      alert.countyFips.some((fips) => !/^37\d{3}$/.test(fips) || (expectedFips.size && !expectedFips.has(fips)))) {
      throw new Error("weather-record-schema");
    }
  }
  return snapshot;
}
