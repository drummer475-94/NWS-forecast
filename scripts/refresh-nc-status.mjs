import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
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

export async function fetchSource(fetchImpl, url, format, headers = {}, { wait = delay, report = console.warn } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let retryable = true;
    let waitMs = 1000 * 2 ** (attempt - 1);
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        retryable = response.status === 408 || response.status === 429 || (response.status >= 500 && response.status < 600);
        const retryAfter = response.headers?.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const requestedWait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(requestedWait)) waitMs = Math.max(waitMs, requestedWait);
          // Do not retry earlier than the provider requested or wait indefinitely.
          if (waitMs > 30_000) retryable = false;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      return await response[format]();
    } catch (error) {
      if (!retryable || attempt === 3) {
        throw new Error(`${url}: request failed after ${attempt} attempt(s): ${error.message}`, { cause: error });
      }
      report(`${url}: attempt ${attempt}/3 failed (${error.message}); retrying in ${waitMs} ms.`);
      await wait(waitMs);
    }
  }
}

export async function buildSnapshot({ fetchImpl = fetch, at = new Date(), countyCatalog, countyGeometry, retryOptions } = {}) {
  if (!Array.isArray(countyCatalog) || countyCatalog.length !== 100) {
    throw new Error("A complete North Carolina county catalog is required.");
  }
  const generatedAt = at.toISOString();
  const [powerPayload, weatherPayload] = await Promise.all([
    fetchSource(fetchImpl, NCEM_POWER_URL, "text", {}, retryOptions),
    fetchSource(fetchImpl, NWS_ALERTS_URL, "json", {
      Accept: "application/geo+json",
      "User-Agent": "NWS Local Weather (https://github.com/drummer475-94/NWS-forecast)",
    }, retryOptions),
  ]);
  const power = parseNcem(powerPayload, countyCatalog).sort((left, right) => left.countyName.localeCompare(right.countyName));
  const alerts = parseNws(weatherPayload, at.valueOf(), { boundaries: countyGeometry });
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
  retryOptions,
} = {}) {
  const geometry = JSON.parse(await readFile(geometryPath, "utf8"));
  const countyCatalog = countyCatalogFromGeoJson(geometry);
  const snapshot = await buildSnapshot({ fetchImpl, at, countyCatalog, countyGeometry: geometry, retryOptions });
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
  try {
    const snapshot = await refreshSnapshot();
    console.log(`Wrote ${snapshot.power.length} counties and ${snapshot.alerts.length} active alerts to ${process.env.NWS_NC_STATUS_OUTPUT_PATH || DEFAULT_OUTPUT_PATH}.`);
  } catch (error) {
    console.error(`NC status refresh failed: ${error.message}. No replacement snapshot was published; retain the last valid Pages deployment.`);
    process.exitCode = 1;
  }
}
