import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
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
import { buildSnapshot, fetchSource, refreshSnapshot } from "../scripts/refresh-nc-status.mjs";
import { checkPublishedSnapshot, MAX_UPDATE_AGE_MS } from "../scripts/check-nc-status.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");
const geometry = JSON.parse(await readFile(path.join(projectRoot, "data", "nc-counties.geojson"), "utf8"));
const countyCatalog = countyCatalogFromGeoJson(geometry);
const noDelay = { wait: async () => {}, report: () => {} };

function validFetch() {
  return Promise.resolve({ ok: true, text: async () => powerHtml(), json: async () => ({ features: [] }) });
}

function powerPayload() {
  return {
    features: countyCatalog.map((county, index) => ({
      attributes: { CountyName: county.name.toUpperCase(), Outages: index },
    })),
  };
}

function powerHtml() {
  return `
    <table>
      <tbody class="tableCountyLabel"><tr><td>County</td><td># Outages</td></tr></tbody>
      <tbody class="tableCountyContent">
        <tr><td>Wake County</td><td><div>42</div></td></tr>
        <tr><td>New Hanover</td><td><div>1,503</div></td></tr>
      </tbody>
      <tbody class="tableCountyLabel"><tr><td>Statewide Outages</td><td><div>1,545</div></td></tr></tbody>
    </table>`;
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

test("NCEM HTML normalization fills omitted zero-outage counties", () => {
  const result = parseNcem(powerHtml(), countyCatalog);
  assert.equal(result.length, 100);
  assert.deepEqual(result.find((county) => county.countyName === "Wake"), {
    countyFips: "37183",
    countyName: "Wake",
    customersOut: 42,
  });
  assert.deepEqual(result.find((county) => county.countyName === "Alamance"), {
    countyFips: "37001",
    countyName: "Alamance",
    customersOut: 0,
  });
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
      async text() { return url === NCEM_POWER_URL ? powerHtml() : JSON.stringify(activeAlertPayload()); },
      async json() { return activeAlertPayload(); },
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
    async text() { return url === NCEM_POWER_URL ? powerHtml() : JSON.stringify({ features: [] }); },
    async json() { return { features: [] }; },
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

test("source retries recover transient failures and preserve headers and timeouts", async () => {
  const waits = [];
  const reports = [];
  const requests = [];
  let count = 0;
  const result = await fetchSource(async (url, options) => {
    requests.push(options);
    count++;
    if (count === 1) throw new TypeError("network unavailable");
    if (count === 2) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ features: [] }) };
  }, NWS_ALERTS_URL, "json", { Accept: "application/geo+json" }, {
    wait: async (ms) => waits.push(ms), report: (message) => reports.push(message),
  });
  assert.deepEqual(result, { features: [] });
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(reports.length, 2);
  assert.ok(requests.every((options) => options.signal instanceof AbortSignal && options.headers.Accept === "application/geo+json"));
});

test("source retries are bounded and do not retry permanent HTTP errors", async () => {
  for (const [status, expectedCalls] of [[404, 1], [408, 3], [429, 3], [500, 3]]) {
    let calls = 0;
    await assert.rejects(fetchSource(async () => {
      calls++;
      return { ok: false, status };
    }, NWS_ALERTS_URL, "json", {}, noDelay), new RegExp(`HTTP ${status}`));
    assert.equal(calls, expectedCalls);
  }
});

test("rate limiting respects Retry-After and stops when the requested delay exceeds the bound", async () => {
  let calls = 0;
  const waits = [];
  await fetchSource(async () => ++calls === 1
    ? { ok: false, status: 429, headers: { get: () => "5" } }
    : { ok: true, text: async () => "recovered" }, NCEM_POWER_URL, "text", {}, {
    wait: async (ms) => waits.push(ms), report: () => {},
  });
  assert.deepEqual(waits, [5000]);
  calls = 0;
  await assert.rejects(fetchSource(async () => {
    calls++;
    return { ok: false, status: 429, headers: { get: () => "120" } };
  }, NCEM_POWER_URL, "text", {}, noDelay), /after 1 attempt/);
  assert.equal(calls, 1);
});

test("failed fetches and invalid source data leave the existing snapshot byte-for-byte intact", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nc-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "snapshot.json");
  const previous = await buildSnapshot({ fetchImpl: validFetch, countyCatalog });
  const original = JSON.stringify(previous);
  await writeFile(outputPath, original);
  for (const failedUrl of [NCEM_POWER_URL, NWS_ALERTS_URL]) {
    await assert.rejects(refreshSnapshot({
      outputPath, geometryPath: path.join(projectRoot, "data/nc-counties.geojson"), retryOptions: noDelay,
      fetchImpl: async (url) => url === failedUrl ? { ok: false, status: 503 } : validFetch(url),
    }), /HTTP 503/);
    assert.equal(await readFile(outputPath, "utf8"), original);
  }
  await assert.rejects(refreshSnapshot({
    outputPath, geometryPath: path.join(projectRoot, "data/nc-counties.geojson"), retryOptions: noDelay,
    fetchImpl: async () => ({ ok: true, text: async () => "invalid power data", json: async () => ({ features: [] }) }),
  }), /power-schema/);
  assert.equal(await readFile(outputPath, "utf8"), original);
  assert.deepEqual(await readdir(directory), ["snapshot.json"]);
  const replacement = await refreshSnapshot({
    outputPath, geometryPath: path.join(projectRoot, "data/nc-counties.geojson"), fetchImpl: validFetch,
  });
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), replacement);
});

test("publication rejects aged timestamps even when stored freshness says fresh", async () => {
  const at = new Date("2026-09-13T12:00:00Z");
  const snapshot = await buildSnapshot({ fetchImpl: validFetch, countyCatalog, at });
  const options = { nowMs: at.valueOf() + 5 * 60_000, maxSourceAgeMs: 5 * 60_000 };
  assert.equal(validateSnapshot(snapshot, countyCatalog, options), snapshot);
  assert.throws(() => validateSnapshot(snapshot, countyCatalog, { ...options, nowMs: options.nowMs + 1 }), /source-too-old/);
  for (const key of ["power", "weather"]) {
    const changed = structuredClone(snapshot);
    changed.sources[key].lastSuccessAt = "2026-09-13T11:00:00Z";
    assert.throws(() => validateSnapshot(changed, countyCatalog, options), new RegExp(`${key}-source-too-old`));
  }
  const changed = structuredClone(snapshot);
  changed.generatedAt = "2026-09-13T11:00:00Z";
  assert.throws(() => validateSnapshot(changed, countyCatalog, options), /snapshot-too-old/);
});

test("publication CLI accepts a newly retrieved snapshot and rejects an old one", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nc-verify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "snapshot.json");
  const env = { ...process.env, NWS_NC_STATUS_OUTPUT_PATH: outputPath };
  const snapshot = await buildSnapshot({ fetchImpl: validFetch, countyCatalog });
  await writeFile(outputPath, JSON.stringify(snapshot));
  assert.match(execFileSync(process.execPath, ["scripts/verify-nc-status.mjs"], { cwd: projectRoot, env, encoding: "utf8" }), /Verified 100 counties/);
  snapshot.sources.power.lastSuccessAt = new Date(Date.now() - 6 * 60_000).toISOString();
  await writeFile(outputPath, JSON.stringify(snapshot));
  assert.throws(() => execFileSync(process.execPath, ["scripts/verify-nc-status.mjs"], { cwd: projectRoot, env, stdio: "pipe" }), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr.toString(), /power-source-too-old/);
    return true;
  });
});

test("deployment keeps refresh failure blocking and uses only this run's snapshot artifact", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github/workflows/deploy.yml"), "utf8");
  assert.match(workflow, /group: "pages"\n  cancel-in-progress: false/);
  const [refresh, deploy] = workflow.split("\n  deploy:\n");
  assert.match(refresh, /Check previous published update\n        continue-on-error: true/);
  assert.match(refresh, /Refresh North Carolina status snapshot\n        run: node scripts\/refresh-nc-status.mjs/);
  assert.match(refresh, /Validate North Carolina status snapshot\n        run: node scripts\/verify-nc-status.mjs/);
  assert.match(refresh, /uses: actions\/upload-artifact@v4[\s\S]*name: nc-status-snapshot/);
  assert.match(deploy, /needs: refresh/);
  assert.match(deploy, /uses: actions\/download-artifact@v4[\s\S]*name: nc-status-snapshot\n          path: data/);
  assert.match(deploy, /Recheck snapshot age before publication\n        run: node scripts\/verify-nc-status.mjs/);
  assert.doesNotMatch(deploy, /continue-on-error|if: always|if: failure/);
  const monitor = await readFile(path.join(projectRoot, ".github/workflows/monitor-status.yml"), "utf8");
  assert.match(monitor, /workflow_dispatch:/);
  assert.match(monitor, /cron: "8,38 \* \* \* \*"/);
  assert.match(monitor, /group: nc-status-monitor/);
  assert.match(monitor, /run: node scripts\/check-nc-status.mjs/);
  assert.doesNotMatch(monitor, /pages: write|id-token: write|continue-on-error/);
});

test("monitor detects overdue publication from the oldest timestamp and bypasses caching", async () => {
  const at = new Date("2026-09-13T12:00:00Z");
  const snapshot = await buildSnapshot({ fetchImpl: validFetch, countyCatalog, at });
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => snapshot };
  };
  const nowMs = at.valueOf() + MAX_UPDATE_AGE_MS;
  assert.equal((await checkPublishedSnapshot({ fetchImpl, countyCatalog, nowMs })).overdue, false);
  const overdue = await checkPublishedSnapshot({ fetchImpl, countyCatalog, nowMs: nowMs + 1 });
  assert.equal(overdue.overdue, true);
  assert.match(overdue.message, /OVERDUE/);
  assert.equal(requests[0].options.cache, "no-store");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(new URL(requests[0].url).searchParams.get("monitor"), String(nowMs));
  snapshot.generatedAt = new Date(nowMs).toISOString();
  assert.equal((await checkPublishedSnapshot({ fetchImpl, countyCatalog, nowMs: nowMs + 1 })).overdue, true);
});

test("monitor fails closed on unreachable, malformed, incomplete, and future-dated snapshots", async () => {
  await assert.rejects(checkPublishedSnapshot({ countyCatalog, fetchImpl: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
  await assert.rejects(checkPublishedSnapshot({ countyCatalog, fetchImpl: async () => { throw new Error("offline"); } }), /offline/);
  const snapshot = await buildSnapshot({ fetchImpl: validFetch, countyCatalog });
  for (const changed of [{}, { ...snapshot, power: [] }, { ...snapshot, generatedAt: "2099-01-01T00:00:00Z" }]) {
    await assert.rejects(checkPublishedSnapshot({ countyCatalog, fetchImpl: async () => ({ ok: true, json: async () => changed }) }));
  }
});

test("monitor CLI reports overdue and unverifiable updates with failure exit codes and summaries", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nc-monitor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let payload = await buildSnapshot({ fetchImpl: validFetch, countyCatalog });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const summary = path.join(directory, "summary.txt");
  const env = {
    ...process.env,
    NWS_NC_STATUS_URL: `http://127.0.0.1:${server.address().port}/snapshot.json`,
    GITHUB_ACTIONS: "true",
    GITHUB_STEP_SUMMARY: summary,
  };
  const execute = () => promisify(execFile)(process.execPath, ["scripts/check-nc-status.mjs"], { cwd: projectRoot, env });
  assert.match((await execute()).stdout, /within refresh window/);
  payload.sources.power.lastSuccessAt = new Date(Date.now() - 46 * 60_000).toISOString();
  await assert.rejects(execute(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /OVERDUE/);
    assert.match(error.stderr, /::error title=NC status refresh monitor::/);
    return true;
  });
  payload = {};
  await assert.rejects(execute(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /could not be verified/);
    return true;
  });
  const written = await readFile(summary, "utf8");
  assert.match(written, /within refresh window/);
  assert.match(written, /OVERDUE/);
  assert.match(written, /could not be verified/);
});

const alertAt = (id, overrides = {}, geometry = null) => ({
  id,
  geometry,
  properties: { ...activeAlertPayload().features[0].properties, id, areaDesc: "Somewhere", geocode: {}, ...overrides },
});
const parseWith = (features, options) => parseNws({ features }, Date.parse("2026-09-13T12:00:00Z"), options);

test("NWS county mapping uses SAME, UGC county codes, and affectedZones county URLs", () => {
  const [same, ugc, affected] = parseWith([
    alertAt("same", { geocode: { SAME: ["037183", "037063"] } }),
    alertAt("ugc", { geocode: { UGC: ["NCC183"] } }),
    alertAt("affected", { affectedZones: ["https://api.weather.gov/zones/county/NCC063"] }),
  ]);
  assert.deepEqual([same.geography, same.countyFips], ["county", ["37063", "37183"]]);
  assert.deepEqual([ugc.geography, ugc.countyFips], ["county", ["37183"]]);
  assert.deepEqual([affected.geography, affected.countyFips], ["county", ["37063"]]);
});

test("NWS forecast zones map only through an explicit table and are otherwise unmatched", () => {
  const feature = alertAt("zone", { geocode: { UGC: ["NCZ041"] }, affectedZones: ["https://api.weather.gov/zones/forecast/NCZ041"] });
  const [unmapped] = parseWith([feature]);
  assert.deepEqual([unmapped.geography, unmapped.countyFips], ["unknown", []]);
  const [mapped] = parseWith([feature], { zoneTable: { NCZ041: "37183" } });
  assert.deepEqual([mapped.geography, mapped.countyFips], ["county", ["37183"]]);
});

test("NWS storm polygons map to intersecting counties when boundaries are supplied", () => {
  const wake = geometry.features.find((feature) => feature.properties.GEOID === "37183");
  const [lon, lat] = wake.geometry.type === "Polygon" ? wake.geometry.coordinates[0][0] : wake.geometry.coordinates[0][0][0];
  const d = 0.01;
  const polygon = { type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] };
  const [mapped] = parseWith([alertAt("poly", { event: "Tornado Warning" }, polygon)], { boundaries: geometry });
  assert.equal(mapped.geography, "county");
  assert.ok(mapped.countyFips.includes("37183"));
  assert.ok(mapped.countyFips.length < 10);
  const [unmapped] = parseWith([alertAt("poly-no-boundaries", {}, polygon)]);
  assert.equal(unmapped.geography, "unknown");
  const inside = { type: "Polygon", coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] };
  assert.ok(parseWith([alertAt("inside", {}, inside)], { boundaries: geometry })[0].countyFips.includes("37183"));
});

test("NWS statewide and unmatched alerts are labeled explicitly", () => {
  const all = countyCatalog.map((county) => `0${county.fips}`);
  const [bySame, byArea, unknown] = parseWith([
    alertAt("all", { geocode: { SAME: all } }),
    alertAt("area", { areaDesc: "North Carolina" }),
    alertAt("unknown", {}),
  ]);
  assert.equal(bySame.geography, "statewide");
  assert.equal(byArea.geography, "statewide");
  assert.deepEqual([unknown.geography, unknown.countyFips], ["unknown", []]);
});

test("NWS parsing drops cancelled (status or messageType), expired, and ended alerts", () => {
  const same = { geocode: { SAME: ["037183"] } };
  const alerts = parseWith([
    alertAt("ok", same),
    alertAt("status", { ...same, status: "Cancel" }),
    alertAt("type", { ...same, messageType: "Cancel" }),
    alertAt("expired", { ...same, expires: "2026-09-13T10:00:00Z" }),
    alertAt("ended", { ...same, ends: "2026-09-13T11:00:00Z" }),
  ]);
  assert.deepEqual(alerts.map((alert) => alert.id), ["ok"]);
});

test("snapshot validation accepts legacy alerts without geography and rejects invalid geography", () => {
  const snapshot = (alert) => {
    const base = unavailableSnapshot("2026-09-13T12:00:00Z");
    return { ...base, alerts: [alert] };
  };
  const legacy = {
    id: "a", event: "Flood Watch", severity: "Minor", headline: "h", urgency: "Expected", certainty: "Likely", status: "Actual",
    sentAt: "2026-09-13T11:00:00Z", expiresAt: "2026-09-13T13:00:00Z", areaDescription: "Wake", senderName: "NWS",
    countyFips: ["37183"], sourceUrl: "https://api.weather.gov/alerts/a",
  };
  const options = { requireComplete: false, nowMs: Date.parse("2026-09-13T12:00:00Z") };
  assert.doesNotThrow(() => validateSnapshot(snapshot(legacy), countyCatalog, options));
  assert.doesNotThrow(() => validateSnapshot(snapshot({ ...legacy, countyFips: [] }), countyCatalog, options));
  assert.doesNotThrow(() => validateSnapshot(snapshot({ ...legacy, geography: "county" }), countyCatalog, options));
  assert.doesNotThrow(() => validateSnapshot(snapshot({ ...legacy, geography: "statewide", countyFips: [] }), countyCatalog, options));
  assert.doesNotThrow(() => validateSnapshot(snapshot({ ...legacy, geography: "unknown", countyFips: [] }), countyCatalog, options));
  assert.throws(() => validateSnapshot(snapshot({ ...legacy, geography: "everywhere" }), countyCatalog, options), /weather-record-schema/);
  assert.throws(() => validateSnapshot(snapshot({ ...legacy, geography: "unknown" }), countyCatalog, options), /weather-record-schema/);
  assert.throws(() => validateSnapshot(snapshot({ ...legacy, geography: "county", countyFips: [] }), countyCatalog, options), /weather-record-schema/);
});

test("snapshot builder maps polygon alerts with county boundaries and malformed geometry is tolerated", async () => {
  const wake = geometry.features.find((feature) => feature.properties.GEOID === "37183");
  const [lon, lat] = wake.geometry.type === "Polygon" ? wake.geometry.coordinates[0][0] : wake.geometry.coordinates[0][0][0];
  const d = 0.01;
  const polygon = { type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] };
  const payload = { features: [alertAt("tor", { event: "Tornado Warning" }, polygon), alertAt("bad", {}, { type: "Polygon", coordinates: [5] })] };
  const fetchImpl = async () => ({ ok: true, async text() { return powerHtml(); }, async json() { return payload; } });
  const snapshot = await buildSnapshot({ fetchImpl, at: new Date("2026-09-13T12:00:00Z"), countyCatalog, countyGeometry: geometry, retryOptions: noDelay });
  assert.equal(snapshot.alerts[0].geography, "county");
  assert.ok(snapshot.alerts[0].countyFips.includes("37183"));
  assert.equal(snapshot.alerts[1].geography, "unknown");
});
