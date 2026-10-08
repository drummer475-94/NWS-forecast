import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { countyCatalogFromGeoJson, validateSnapshot } from "./nc-status.mjs";

export const DEFAULT_SNAPSHOT_URL = "https://drummer475-94.github.io/NWS-forecast/data/nc-status.json";
export const MAX_UPDATE_AGE_MS = 45 * 60_000;

export async function checkPublishedSnapshot({
  fetchImpl = fetch,
  url = DEFAULT_SNAPSHOT_URL,
  countyCatalog,
  nowMs = Date.now(),
} = {}) {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("monitor", String(nowMs));
  const response = await fetchImpl(requestUrl.href, {
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Published snapshot returned HTTP ${response.status}`);
  const snapshot = await response.json();
  validateSnapshot(snapshot, countyCatalog, { requireComplete: true, nowMs });
  const oldestTime = Math.min(Date.parse(snapshot.generatedAt), ...["power", "weather"].map((key) => Date.parse(snapshot.sources[key].lastSuccessAt)));
  const ageMs = Math.max(0, nowMs - oldestTime);
  return {
    overdue: ageMs > MAX_UPDATE_AGE_MS,
    message: `Published snapshot ${ageMs > MAX_UPDATE_AGE_MS ? "OVERDUE" : "within refresh window"}: oldest update ${new Date(oldestTime).toISOString()} (${Math.floor(ageMs / 60_000)} minutes old; limit 45 minutes).`,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  let message;
  try {
    const geometry = JSON.parse(await readFile(process.env.NWS_NC_GEOMETRY_PATH || "data/nc-counties.geojson", "utf8"));
    const result = await checkPublishedSnapshot({
      url: process.env.NWS_NC_STATUS_URL || DEFAULT_SNAPSHOT_URL,
      countyCatalog: countyCatalogFromGeoJson(geometry),
    });
    message = result.message;
    if (result.overdue) process.exitCode = 1;
  } catch (error) {
    message = `Published snapshot could not be verified: ${error.message}`;
    process.exitCode = 1;
  }
  console.log(message);
  if (process.env.GITHUB_ACTIONS === "true" && process.exitCode) {
    const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.error(`::error title=NC status refresh monitor::${escaped}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
