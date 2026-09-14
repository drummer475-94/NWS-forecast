import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NCEM_POWER_URL,
  NWS_ALERTS_URL,
  countyCatalogFromGeoJson,
  parseNcem,
  parseNws,
  unavailableSnapshot,
  validateSnapshot,
} from "../scripts/nc-status.mjs";
import { buildSnapshot } from "../scripts/refresh-nc-status.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");
const geometry = JSON.parse(await readFile(path.join(projectRoot, "data", "nc-counties.geojson"), "utf8"));
const countyCatalog = countyCatalogFromGeoJson(geometry);

function powerPayload() {
  return {
    features: countyCatalog.map((county, index) => ({
      attributes: { CountyName: county.name.toUpperCase(), Outages: index },
    })),
  };
}

function activeAlertPayload() {
  return {
    features: [{
      id: "alert-1",
      properties: {
        id: "alert-1",
        event: "Severe Thunderstorm Warning",
        headline: "A test warning",
        severity: "Severe",
        urgency: "Immediate",
        certainty: "Observed",
        status: "Actual",
        sent: "2026-09-13T11:00:00Z",
        expires: "2026-09-13T14:00:00Z",
        areaDesc: "Wake County",
        geocode: { SAME: ["037183"] },
        "@id": "https://api.weather.gov/alerts/alert-1",
      },
    }],
  };
}

test("county geometry provides all 100 unique NC identities", () => {
  assert.equal(countyCatalog.length, 100);
  assert.equal(new Set(countyCatalog.map((county) => county.fips)).size, 100);
  assert.ok(countyCatalog.some((county) => county.fips === "37183" && county.name === "Wake"));
});

test("NCEM normalization maps county names to FIPS and validates counts", () => {
  const result = parseNcem({ features: [{ attributes: { CountyName: "WAKE", Outages: 42 } }] }, countyCatalog);
  assert.deepEqual(result, [{ countyFips: "37183", countyName: "Wake", customersOut: 42 }]);
  assert.throws(() => parseNcem({ features: [{ attributes: { CountyName: "WAKE", Outages: -1 } }] }, countyCatalog), /power-schema/);
  assert.throws(() => parseNcem({ features: [{ attributes: { CountyName: "UNKNOWN", Outages: 1 } }] }, countyCatalog), /power-schema/);
});

test("NWS normalization retains active alerts and filters expired or cancelled records", () => {
  const payload = activeAlertPayload();
  payload.features.push({
    id: "cancelled",
    properties: { ...payload.features[0].properties, id: "cancelled", status: "Cancel" },
  });
  payload.features.push({
    id: "expired",
    properties: { ...payload.features[0].properties, id: "expired", expires: "2026-09-13T10:00:00Z" },
  });
  const alerts = parseNws(payload, Date.parse("2026-09-13T12:00:00Z"));
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].countyFips, ["37183"]);
  assert.equal(alerts[0].severity, "Severe");
});

test("snapshot builder sends identifying NWS headers and produces a complete contract", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async json() { return url === NCEM_POWER_URL ? powerPayload() : activeAlertPayload(); },
    };
  };
  const snapshot = await buildSnapshot({
    fetchImpl,
    at: new Date("2026-09-13T12:00:00Z"),
    countyCatalog,
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.power.length, 100);
  assert.equal(snapshot.alerts.length, 1);
  assert.equal(snapshot.sources.power.freshness, "fresh");
  const nwsRequest = requests.find((request) => request.url === NWS_ALERTS_URL);
  assert.equal(nwsRequest.options.headers.Accept, "application/geo+json");
  assert.match(nwsRequest.options.headers["User-Agent"], /NWS Local Weather/);
  assert.equal(validateSnapshot(snapshot, countyCatalog), snapshot);
});

test("deployment validation rejects incomplete or corrupt snapshots", async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    async json() { return url === NCEM_POWER_URL ? powerPayload() : { features: [] }; },
  });
  const snapshot = await buildSnapshot({
    fetchImpl,
    at: new Date("2026-09-13T12:00:00Z"),
    countyCatalog,
  });
  const duplicate = structuredClone(snapshot);
  duplicate.power[1].countyFips = duplicate.power[0].countyFips;
  assert.throws(() => validateSnapshot(duplicate, countyCatalog), /power-record-schema/);

  const negative = structuredClone(snapshot);
  negative.power[0].customersOut = -1;
  assert.throws(() => validateSnapshot(negative, countyCatalog), /power-record-schema/);

  const mismatchedCounty = structuredClone(snapshot);
  mismatchedCounty.power[0].countyName = "Wake";
  assert.throws(() => validateSnapshot(mismatchedCounty, countyCatalog), /power-record-county-name/);

  const malformedAlert = structuredClone(snapshot);
  malformedAlert.alerts = parseNws(activeAlertPayload(), Date.parse("2026-09-13T12:00:00Z"));
  malformedAlert.alerts[0].headline = "";
  assert.throws(() => validateSnapshot(malformedAlert, countyCatalog), /weather-record-schema/);

  const unsafeTimestamp = structuredClone(snapshot);
  unsafeTimestamp.generatedAt = "2099-01-01T00:00:00.000Z";
  assert.throws(
    () => validateSnapshot(unsafeTimestamp, countyCatalog, { nowMs: Date.parse("2026-09-13T12:00:00Z") }),
    /snapshot-schema/
  );

  const nonIsoTimestamp = structuredClone(snapshot);
  nonIsoTimestamp.sources.power.lastAttemptAt = 0;
  assert.throws(() => validateSnapshot(nonIsoTimestamp, countyCatalog), /power-source-schema/);

  const fallback = unavailableSnapshot("2026-09-13T12:00:00Z");
  assert.equal(validateSnapshot(fallback, countyCatalog, { requireComplete: false }), fallback);
  assert.throws(() => validateSnapshot(fallback, countyCatalog), /source-not-fresh/);
});
