import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  NCEM_POWER_URL,
  NWS_ALERTS_URL,
  countyCatalogFromGeoJson,
  parseNcem,
  parseNws,
  validateSnapshot,
} from "./nc-status.mjs";

const DEFAULT_OUTPUT_PATH = "data/nc-status.json";
const DEFAULT_GEOMETRY_PATH = "data/nc-counties.geojson";
const REQUEST_TIMEOUT_MS = 20_000;

async function fetchJson(fetchImpl, url, headers = {}) {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

export async function buildSnapshot({ fetchImpl = fetch, at = new Date(), countyCatalog } = {}) {
  if (!Array.isArray(countyCatalog) || countyCatalog.length !== 100) {
    throw new Error("A complete North Carolina county catalog is required.");
  }
  const generatedAt = at.toISOString();
  const [powerPayload, weatherPayload] = await Promise.all([
    fetchJson(fetchImpl, NCEM_POWER_URL),
    fetchJson(fetchImpl, NWS_ALERTS_URL, {
      Accept: "application/geo+json",
      "User-Agent": "NWS Local Weather (https://github.com/drummer475-94/NWS-forecast)",
    }),
  ]);
  const power = parseNcem(powerPayload, countyCatalog).sort((left, right) => left.countyName.localeCompare(right.countyName));
  const alerts = parseNws(weatherPayload, at.valueOf());
  const source = (name, sourceUrl) => ({
    name,
    sourceUrl,
    lastAttemptAt: generatedAt,
    lastSuccessAt: generatedAt,
    freshness: "fresh",
  });
  const snapshot = {
    schemaVersion: 1,
    generatedAt,
    state: "NC",
    sources: {
      power: source("NC Emergency Management", NCEM_POWER_URL),
      weather: source("National Weather Service", NWS_ALERTS_URL),
    },
    power,
    alerts,
  };
  return validateSnapshot(snapshot, countyCatalog, { requireComplete: true });
}

export async function refreshSnapshot({
  fetchImpl = fetch,
  at = new Date(),
  outputPath = process.env.NWS_NC_STATUS_OUTPUT_PATH || DEFAULT_OUTPUT_PATH,
  geometryPath = process.env.NWS_NC_GEOMETRY_PATH || DEFAULT_GEOMETRY_PATH,
} = {}) {
  const geometry = JSON.parse(await readFile(geometryPath, "utf8"));
  const countyCatalog = countyCatalogFromGeoJson(geometry);
  const snapshot = await buildSnapshot({ fetchImpl, at, countyCatalog });
  const resolvedOutput = resolve(outputPath);
  const temporaryOutput = `${resolvedOutput}.${process.pid}.tmp`;
  await mkdir(dirname(resolvedOutput), { recursive: true });
  try {
    await writeFile(temporaryOutput, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporaryOutput, resolvedOutput);
  } catch (error) {
    await rm(temporaryOutput, { force: true }).catch(() => {});
    throw error;
  }
  return snapshot;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const snapshot = await refreshSnapshot();
  console.log(`Wrote ${snapshot.power.length} counties and ${snapshot.alerts.length} active alerts to ${process.env.NWS_NC_STATUS_OUTPUT_PATH || DEFAULT_OUTPUT_PATH}.`);
}
