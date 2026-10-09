# NWS Local Weather

NWS Local Weather is a mobile-first, two-page static app for U.S. forecasts and North Carolina county status. The forecast page uses National Weather Service forecasts, observations, alerts, quantitative precipitation data, and local NEXRAD imagery. The NC Status page adapts the current [NetPulse](https://github.com/drummer475-94/NetPulse) county dashboard to show reported power outages and active NWS alerts without changing the app's framework-free architecture or visual language.

## Pages

- `index.html` — current conditions, next-24-hour precipitation, hourly and seven-day forecasts, all active alerts for the point, and animated radar for a U.S. location.
- `status.html` — North Carolina county power totals, active county alerts, a real county map, ZIP and device-location lookup, source freshness, and last-known-data handling.

Both pages share the Local Weather header, Forecast / NC Status navigation, responsive styles, and the `theme` browser preference. Location state is intentionally separate. The status page stores only a county FIPS code, and only when “Remember this county” is selected.

## Local use

Serve the repository with any static web server; do not open the pages through `file://` because both pages fetch local data assets.

```sh
python -m http.server 8000
```

Open `http://localhost:8000/` for the forecast or `http://localhost:8000/status.html` for NC Status. There is no package install or build step.

Run the checks with Node.js 24:

```sh
node --check app.js
node --check status.js
node --check scripts/nc-status.mjs
node --check scripts/refresh-nc-status.mjs
node --check scripts/verify-nc-status.mjs
node --check scripts/check-nc-status.mjs
node --check alert-geography.js
node --test
```

Browser smoke tests (forecast and NC Status pages at 320, 375 and 1280 px, with every external provider stubbed) run in CI as the `browser-smoke` job. See [`tests/browser/README.md`](tests/browser/README.md) to run them locally.

## NC Status data flow

The Pages workflow requests refreshes twice hourly at minutes 17 and 47 UTC. GitHub Actions scheduling is best effort: executions may be delayed or dropped, and a cron expression does not guarantee updates every 30 minutes. See [GitHub's schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Snapshot preparation runs in a separate job before Pages publication. It replaces `data/nc-status.json` atomically only after both upstream responses produce a complete, validated snapshot. Validation requires all 100 NC counties, unique valid FIPS values, nonnegative integer outage totals, valid source timestamps, and structurally valid NWS alerts. The publication job downloads only this run's validated snapshot and rejects generation/source-success timestamps older than five minutes, regardless of stored freshness labels. If refresh, validation, or the age check fails, deployment stops and the previous valid Pages deployment remains available. Source-success times record retrieval, not an independently verified provider observation time.

Requests have a 20-second timeout per attempt and at most three attempts for network/body-read errors and HTTP 408, 429, or 5xx responses. Retries wait one then two seconds, honoring longer `Retry-After` delays up to 30 seconds. Longer provider delays stop the refresh rather than retrying early. Other HTTP errors and invalid weather/outage schemas fail immediately. Logs identify the URL, attempt count, and error; workflow failures include a preservation notice in the run summary.

Pages concurrency does not cancel an active run when another trigger arrives. GitHub may still replace a pending run, and concurrency does not promise a FIFO queue. Snapshot preparation and publication remain in one workflow because Pages publishes a complete site artifact; putting scheduled data in a separate store would require additional persistence and client behavior without fixing GitHub's scheduler.

To build and verify a snapshot locally:

```sh
node scripts/refresh-nc-status.mjs
node scripts/verify-nc-status.mjs
```

### Refresh monitoring and investigation

`monitor-status.yml` requests independent checks twice hourly at minutes 8 and 38 UTC and supports manual dispatch. The deployment also checks the previous published snapshot before refreshing and verifies the published snapshot afterward. A pre-refresh monitoring failure is reported but permits recovery; preparation failure blocks publication. A post-publication monitoring failure reports a verification problem and does not roll back a completed deployment.

The monitor fetches the actual Pages JSON with cache bypassing, validates its structure, and checks the oldest generation/source-success timestamp. More than 45 minutes is overdue, reported as a failed monitor run with an error annotation and summary. An HTTP, network, or validation failure is reported as unverifiable, never as a healthy update. Enable GitHub Actions failure notifications for this workflow. To check locally or from an independently scheduled external monitor, run:

```sh
node scripts/check-nc-status.mjs
# Set NWS_NC_STATUS_URL if Pages uses a different URL or custom domain.
```

Exit status is zero for a valid snapshot within the 45-minute window and nonzero for overdue or unverifiable data. Monitoring on GitHub is also best effort: it can detect a gap once it runs, but cannot guarantee a timely alert while GitHub scheduling is delayed. An external scheduler running this check is required for independently timed detection. No external monitoring service is configured by this change. The monitor's 45-minute threshold checks the intended snapshot cadence; the browser's stricter weather-alert freshness window still applies.

Investigation on 2026-10-08 inspected all 184 available repository workflow runs: 135 scheduled runs (122 successes, 13 failures), with no scheduled cancellations or skipped run conclusions. Eight canceled runs were push-triggered. There are no run records for many expected cron slots; the API cannot distinguish dropped triggers from uncreated/delayed triggers. For example, successful scheduled runs on October 5 were [09:01 UTC](https://github.com/drummer475-94/NWS-forecast/actions/runs/37287271804) and [18:25 UTC](https://github.com/drummer475-94/NWS-forecast/actions/runs/37355802179), a 9-hour 24-minute gap. On October 8, [the 15:34 UTC run](https://github.com/drummer475-94/NWS-forecast/actions/runs/37801888299) followed the 07:58 UTC run by 7 hours 36 minutes, yet its job started six seconds after creation and finished in 17 seconds. These sampled gaps occur before workflow execution, rather than within long-running deployments. The former `cancel-in-progress: true` setting can interrupt push deployments but does not explain these scheduled gaps. Sampled September failures stopped at refresh with `power-schema`; [the inspected failure log](https://github.com/drummer475-94/NWS-forecast/actions/runs/35124684237) predates the existing ReadyNC parser fix. Subsequent scheduled runs succeeded. GitHub's internal reason for each absent cron trigger remains unavailable.

The status page fetches the deployed snapshot without browser caching, then refreshes both the snapshot and statewide NWS alerts on load, every five minutes while the tab is visible and online, when the tab becomes visible again (if the last check is at least a minute old), and when the connection returns. One timer drives both sources, it stops while the tab is hidden, and a refresh already in flight is never duplicated. The two sources refresh independently: a failure in one does not block the other. A failed refresh keeps the last-known data, and a fetched snapshot that is older than the one already shown is ignored. The power section shows when the snapshot was last checked separately from the source's last successful update. The interface derives freshness from the last successful timestamp rather than trusting a stored label:

- Power is fresh through 45 minutes, stale through 60 minutes, then unavailable as a current reading.
- Weather alerts are fresh through 5 minutes, stale through 10 minutes, then unavailable as a current reading.

Last-known values remain visible with an explicit stale or unavailable label, for example “Last known: 0 reported as of … — data is stale.” A failed or stale source is never represented as current zero or “all clear,” and stale data never gets the all-clear map color. Power-map colors use fixed bands of 0, 1–99, 100–999, and 1,000+ customers reported without power.

### NWS alert geography

Each alert is matched to counties using its geographic identifiers, in this order:

1. SAME county codes, when present.
2. Otherwise, UGC county codes (`NCC###`), county and forecast-zone links in `affectedZones`, and a forecast-zone table. The zone table is intentionally empty until a verified NCZ-to-county mapping is added, because mappings are never guessed.
3. The alert's polygon, intersected with the bundled county boundaries, when no identifier matched or a zone could not be mapped.

An alert is *statewide* only when it covers all 100 counties or its area description is exactly “North Carolina.” An alert that cannot be matched to a county is never treated as statewide. It is excluded from county totals, the map and the warning banner, and is listed separately as “could not be matched to a county,” with a link to the official NWS details. Older snapshots without a `geography` field are read conservatively: county codes mean county-scoped, and no codes mean unmatched.

Both pages use the same active-alert rule. An alert is active only when it is an `Actual` message (not Test, Exercise, System or Draft), is not a cancellation, and has not passed its `expires` or `ends` time. Forecast-page alerts come from the NWS point query for the selected location, and each card links to its official NWS details.

The forecast page's "Active alerts" panel lists every active alert for the point, not only watches and warnings, ordered by significance (warnings, then watches, advisories, statements, and anything else) and by soonest expiry within each group. Each card carries a text badge (Warning, Watch, Advisory, Statement or Other) so the type never depends on color. At most six cards are shown; if more are active the panel says "Showing 6 of N" and links to the point's forecast page on weather.gov, which lists every hazard for the coordinates. Only Tornado and Flash Flood Warnings drive the red banner and only warnings open the severe weather panel; advisories, statements and watches never do.

### Location naming

A ZIP lookup labels the location with the ZIP's own place name and state (for example "Wilmington, NC" for 28401), because the nearest NWS named point can be a different town. That label is kept across refreshes of the same location and is dropped as soon as a different ZIP or a device location loads; device locations are labeled with the NWS `relativeLocation`. The location line, the severe weather panel and other text all use the same label.

### Forecast icons

Hourly and daily icons load straight from api.weather.gov with no extra requests. NWS occasionally answers an icon request with a non-image error body, which the browser blocks. When an icon fails, the app retries once with only the first condition if the icon path combines two (`.../rain_showers,20/tsra_hi,20` becomes `.../rain_showers,20`); if that also fails, or the icon had a single condition, the broken image is replaced by an emoji chosen from the period's short forecast. The replacement keeps the image's accessible name (decorative daily icons stay hidden from assistive technology). No inline `onerror` handlers are used.

## Data sources

- National Weather Service API
- North Carolina Department of Public Safety / Emergency Management ReadyNC power-outage service
- NOAA/NWS NEXRAD OGC web services
- RainViewer weather maps (nationwide radar fallback)
- USGS National Map tiles
- U.S. Census Bureau county boundaries
- Zippopotam.us ZIP lookup

A "Radar source" switch above the map chooses between **Local NWS radar** (the default) and **National (RainViewer)**. It is a pair of real radio buttons, so arrow keys and Space work. The choice is remembered per viewer in `localStorage` under `radarSource`; if storage is unavailable the app still works and defaults to Local. Choosing National loads RainViewer HD and keeps it: forecast loads, ZIP or location changes, the five-minute refresh and Retry never switch back to NWS, and it is not treated as a fallback (the data-source row reads "Active: RainViewer HD (national, selected)"). The nearby radar dots stay on the map in both modes; clicking or pressing Enter on one switches to Local and selects that station, and "Use auto-detect" also returns to Local. With Local, a failed NWS service or tile load falls back to RainViewer while the switch stays on Local, and a visible note says "NWS radar unavailable — showing RainViewer national radar as a fallback" with Retry radar available. Local without a known station (no location yet, or none for the point) shows a note and uses RainViewer. Switching sources keeps the map centre, clamps zoom to the new source's limit and restarts animation, refresh timer and layers cleanly; if RainViewer is already on screen no reload is made. Choosing a source never changes the manually selected station for the current location.

Radar is always high definition; there is no SD mode or SD fallback. After a forecast location is loaded, the app prefers the assigned NWS station's time-enabled Super Resolution Base Reflectivity layer. Nearby WSR-88D sites from the NWS radar-station API appear as clickable dots on the map so users can manually choose a site that may provide better coverage than auto-detect. If the selected NWS service or its tiles are unavailable, the app falls back to RainViewer's 512 px HD tiles. Radar frame metadata is refreshed about every five minutes while the page is visible and online, without recreating the map or changing the selected station, source or zoom limits. Cached frame layers are reused, frames that age out are removed, and animation state is kept. The radar panel shows the newest scan time from the provider metadata. A failed refresh keeps the existing frames with a notice and does not trigger the fallback.

Zoom is constrained to the active radar source. RainViewer's documented provider limit is zoom 7, exposed as map zoom 8 because its 512 px tiles use a `-1` Leaflet zoom offset. NWS super-resolution radar is capped at map zoom 11 to show its roughly 250 m range-gate detail without allowing extreme enlargement. The USGS basemap is never overzoomed beyond its native zoom 16.

### Current conditions and loading

The forecast page renders hourly and daily forecasts as soon as they arrive. Station observations and gridpoint precipitation load in parallel and update the current-conditions panel when ready; a slow or failed optional request never delays or blocks the forecast. Each location load has its own request context, so responses for a previous location are discarded instead of overwriting the newer one.

Current temperature, humidity, wind, visibility and feels-like use measured values from a nearby NWS station only when the observation is at most 90 minutes old and the individual value is present and not quality-control flagged (X, Q or B). The panel names the station and observation time. Each missing or rejected value falls back to the hourly forecast and is labeled “Forecast,” so a prediction is never presented as an observation. When no usable observation exists, the panel says it is showing the forecast for this hour and why.

Active Tornado Warnings and Flash Flood Warnings appear in a translucent red banner pinned to the top of either page for its selected location. The forecast banner refreshes every minute. The NC Status banner follows the five-minute statewide-alert refresh and county selection. Expired warnings are removed; if updates fail, unexpired last-known warnings remain with an update-unavailable notice.

### Forecast discussion

After a location resolves, the forecast page requests the latest Area Forecast Discussion (AFD) from the location's forecast office (`/products/types/AFD/locations/<office>/latest` on api.weather.gov, one request that includes the text). The product list endpoint is not used because it has been observed serving week-old entries whose products no longer exist. The section shows the issuing office, the issue time in the location's time zone and its age. The text is the forecasters' own technical writing shown verbatim: it is split into its `.HEADER...` sections for easier reading once the reader opens the section, the complete original product text is always available, and nothing is summarized, reworded or interpreted. A discussion more than 24 hours old is labeled as such. The section links to the official discussion on weather.gov. If the discussion cannot be loaded, the section says so (and keeps the official link) without affecting the rest of the forecast; the next refresh tries again.

### Severe weather mode

A "Severe weather" panel appears at the top of the forecast page whenever the selected point has an active NWS **Warning** of any type (`/alerts/active?point=`). Watches and advisories never open it. Active uses the same rule as the rest of the app: status `Actual`, not a `Cancel`, `ends` (or `expires`) in the future, and `effective`/`onset` not in the future. Warnings are ordered Tornado, Extreme Wind, Severe Thunderstorm, Flash Flood, Hurricane, Storm Surge, Tropical Storm, Blizzard, Ice Storm, Winter Storm, then all other warnings, and by soonest expiry within a type.

Each warning shows the NWS headline, area, sender, effective time, expiry (with minutes remaining, refreshed each minute), the detection, hail, wind-gust and damage-threat parameters when NWS supplies them, the full description and the "What to do" instruction. NWS text is shown exactly as published (inserted as text, never reworded or summarized) and links to the official `api.weather.gov` alert. The panel can be minimized to a one-line summary; it expands again only when a warning that was not present at minimize time appears. The freshness line gives the alerts check time and latest radar scan; if alert polling is failing, a notice says the warnings shown are the last received. "Show local radar" scrolls to and focuses the radar section without changing a manually selected radar.

Power outage counts are shown for North Carolina counties only, read from the same `data/nc-status.json` snapshot as the NC Status page (at most once every 5 minutes while the panel is shown). The county comes from the NWS point response. Freshness follows NC Status: data up to 45 minutes old is current, up to 60 minutes is stale, and older data is "current update unavailable"; stale or older values are always labeled "Last known ... as of ...". Other states see a note that outage data is NC-only. The snapshot appears in "Data sources" as "NC outage snapshot" once used.

### Data source health

A collapsed "Data sources" panel at the bottom of the forecast page (and a small "Data sources: all current / 1 stale / 2 issues" pill under the hero's updated label, which opens and focuses the panel) shows the state of each upstream provider: NWS forecast, station observation, gridpoint precipitation, alerts and forecast discussion, radar, the ZIP lookup (listed only after it has been used) and the USGS basemap (listed once its tiles have loaded or failed). Each row gives a status, the clock time of the last successful update in the location's time zone, how old the data is, and a short explanation. The radar row names the active provider and, when NWS super-resolution failed, says that the RainViewer HD fallback is active; National chosen with the radar source switch is reported as selected, not as a fallback.

Health is derived only from requests the app already makes. There is no extra polling and no separate probe request, and ages refresh once a minute only while the page is visible. A source that already has good data keeps showing it while it re-checks, and a failed refresh keeps the last good data's age ("Last good data: 20 min old"). Records for location-dependent sources go back to "Checking" when the location changes, and responses from superseded loads never update them.

Data is flagged stale when:

- the forecast's generation time is more than 3 hours old;
- the station observation is older than 90 minutes (the same limit that sends the hero panel back to the forecast values);
- the last successful alerts check (alerts are polled every minute) is more than 5 minutes old;
- the newest radar scan is more than 30 minutes old;
- the forecast discussion was issued more than 24 hours ago.

Errors are classified so a provider outage is not mistaken for a bug. A provider error is an HTTP error status, timeout, network failure, unparseable response, or an upstream response the app cannot use (for example NWS returning no forecast endpoints); an offline error means the device has no connection; an app error is an unexpected exception from this page's own code. App errors are caught per rendering step so the rest of the page keeps working, and the row tells the reader to reload and report the problem if it persists. Cancelled requests are never recorded as failures.

Scheduled monitoring for the NC Status data already exists in `monitor-status.yml` (see "Refresh monitoring and investigation"); the forecast page's health is derived from its real requests rather than from a scheduled check, so it reflects what the visitor is actually receiving.

## Privacy and scope

Forecast and ZIP requests go directly from the browser to their named providers. On NC Status, device coordinates are used only in memory to match the bundled county geometry and are neither transmitted nor saved. ZIP lookup sends the entered ZIP to Zippopotam.us. The optional remembered setting stores only the selected county FIPS code.

The NC Status page covers North Carolina only and is informational. It does not replace Wireless Emergency Alerts, utility reporting, official agency instructions, emergency services, or confirmation from an internet or electric provider.
