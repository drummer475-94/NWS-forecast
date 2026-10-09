# Browser smoke tests

`smoke.mjs` drives the forecast page (`index.html`) and the NC Status page (`status.html`) in headless Chromium at
320x640, 375x812 and 1280x900. It needs no network: it serves the repository from its own static server and answers
every external host (NWS, NOAA radar, RainViewer, USGS, Zippopotam.us, unpkg) from `fixtures/`. A request to any other
host is aborted and fails the run, as do uncaught page errors and console errors that are not on the specific allow-list
at the top of the script (the intentional NWS radar 503 and invalid-ZIP 404). The NWS radar stub always fails so the
RainViewer fallback is exercised. Fixture timestamps (`{{now-20m}}` and similar) are filled in when each request is
served, so the data stays fresh.

The repository has no `package.json`, so install the two dependencies outside it:

```sh
npm install --prefix /tmp/smoke --no-save playwright@1.64.0 leaflet@1.9.4
/tmp/smoke/node_modules/.bin/playwright install chromium

PLAYWRIGHT_MODULE_DIR=/tmp/smoke \
LEAFLET_DIR=/tmp/smoke/node_modules/leaflet/dist \
node tests/browser/smoke.mjs
```

Leaflet must be exactly 1.9.4 because the HTML pins its files with Subresource Integrity hashes; the suite serves the
real files from `LEAFLET_DIR` so those hashes are checked too.

| Variable | Purpose |
| --- | --- |
| `PLAYWRIGHT_MODULE_DIR` | Directory whose `node_modules` holds `playwright` (default: normal Node resolution). |
| `LEAFLET_DIR` | Leaflet 1.9.4 `dist` directory (default: resolved next to `playwright`). |
| `CHROMIUM_EXECUTABLE_PATH` | Use an existing Chromium binary instead of the one Playwright downloads. |
| `SMOKE_SCREENSHOTS=1` | Save full-page screenshots to `SMOKE_SCREENSHOT_DIR` (default: `<tmpdir>/nws-smoke`). |
| `SMOKE_VERBOSE=1` | Print every browser console message. |

The run prints one PASS/FAIL line per check and viewport, followed by forecast-page performance numbers (time from ZIP
submit to the first hourly card, request counts, repo-local bytes) measured against the stubs, and exits non-zero on any
failure. `node --test` does not pick this file up, and CI runs it in the separate `browser-smoke` job.
