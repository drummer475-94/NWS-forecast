export const NWS_ALERTS_URL = "https://api.weather.gov/alerts/active?area=NC";
export const NCEM_POWER_URL = "https://spartagis.ncem.org/arcgis/rest/services/Public/ReadyNC_PowerOutages/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json";

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

function normalizeCountyName(value) {
  return cleanText(value).replace(/\s+COUNTY$/i, "").toUpperCase();
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
  const features = input?.features;
  if (!Array.isArray(features)) throw new Error("power-schema");
  if (!Array.isArray(countyCatalog) || !countyCatalog.length) throw new Error("county-catalog-missing");

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

export function parseNws(input, nowMs = Date.now()) {
  const features = input?.features;
  if (!Array.isArray(features)) throw new Error("weather-schema");

  return features.map((feature) => {
    const properties = feature?.properties;
    if (!properties || typeof properties !== "object") throw new Error("weather-schema");
    const id = cleanText(properties.id) || cleanText(feature?.id);
    const event = cleanText(properties.event);
    const expiresAt = validIso(properties.expires);
    if (!id || !event || !expiresAt) throw new Error("weather-schema");

    const sameCodes = properties.geocode?.SAME;
    const countyFips = Array.isArray(sameCodes)
      ? Array.from(new Set(sameCodes.map(String).map((code) => /^037\d{3}$/.test(code) ? code.slice(1) : code).filter((code) => /^37\d{3}$/.test(code))))
      : [];
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
      sentAt: validIso(properties.sent) || expiresAt,
      effectiveAt: validIso(properties.effective),
      onsetAt: validIso(properties.onset),
      expiresAt,
      endsAt: validIso(properties.ends),
      areaDescription: cleanText(properties.areaDesc) || "North Carolina",
      countyFips,
      description: cleanText(properties.description) || undefined,
      instruction: cleanText(properties.instruction) || undefined,
      senderName: cleanText(properties.senderName) || "National Weather Service",
      sourceUrl,
    };
  }).filter((alert) => alert.status !== "Cancel" && Date.parse(alert.expiresAt) > nowMs);
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
      !Array.isArray(alert.countyFips) || new Set(alert.countyFips).size !== alert.countyFips.length || !isHttpsUrl(alert.sourceUrl) ||
      alert.countyFips.some((fips) => !/^37\d{3}$/.test(fips) || (expectedFips.size && !expectedFips.has(fips)))) {
      throw new Error("weather-record-schema");
    }
  }
  return snapshot;
}
