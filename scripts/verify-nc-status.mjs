import { readFile } from "node:fs/promises";
import { countyCatalogFromGeoJson, validateSnapshot } from "./nc-status.mjs";

const snapshotPath = process.env.NWS_NC_STATUS_OUTPUT_PATH || "data/nc-status.json";
const geometryPath = process.env.NWS_NC_GEOMETRY_PATH || "data/nc-counties.geojson";
const [snapshotText, geometryText] = await Promise.all([
  readFile(snapshotPath, "utf8"),
  readFile(geometryPath, "utf8"),
]);
const snapshot = JSON.parse(snapshotText);
const countyCatalog = countyCatalogFromGeoJson(JSON.parse(geometryText));
validateSnapshot(snapshot, countyCatalog, { requireComplete: true });

console.log(`Verified ${snapshot.power.length} counties and ${snapshot.alerts.length} active alerts in ${snapshotPath}.`);
