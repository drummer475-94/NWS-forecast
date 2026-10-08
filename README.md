# NWS Local Weather

NWS Local Weather is a mobile-first, two-page static app for U.S. forecasts and North Carolina county status. The forecast page uses National Weather Service forecasts, observations, alerts, quantitative precipitation data, and local NEXRAD imagery. The NC Status page adapts the current [NetPulse](https://github.com/drummer475-94/NetPulse) county dashboard to show reported power outages and active NWS alerts without changing the app's framework-free architecture or visual language.

## Pages

- `index.html` — current conditions, next-24-hour precipitation, hourly and seven-day forecasts, active alerts, and animated radar for a U.S. location.
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
node --test
```

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

The status page fetches the deployed snapshot without browser caching, then refreshes statewide NWS alerts directly on load, every five minutes while visible, and when the tab becomes visible again. A failed live refresh retains last-known alerts. The interface derives freshness from the last successful timestamp rather than trusting a stored label:

- Power is fresh through 45 minutes, stale through 60 minutes, then unavailable as a current reading.
- Weather alerts are fresh through 5 minutes, stale through 10 minutes, then unavailable as a current reading.

Last-known values remain visible with an explicit stale or unavailable label. A failed source is never represented as zero or “all clear.” Power-map colors use fixed bands of 0, 1–99, 100–999, and 1,000+ customers reported without power.

## Data sources

- National Weather Service API
- North Carolina Department of Public Safety / Emergency Management ReadyNC power-outage service
- NOAA/NWS NEXRAD OGC web services
- RainViewer weather maps (nationwide radar fallback)
- USGS National Map tiles
- U.S. Census Bureau county boundaries
- Zippopotam.us ZIP lookup

Radar is always high definition; there is no SD mode or SD fallback. After a forecast location is loaded, the app prefers the assigned NWS station's time-enabled Super Resolution Base Reflectivity layer. Nearby WSR-88D sites from the NWS radar-station API appear as clickable dots on the map so users can manually choose a site that may provide better coverage than auto-detect. If the selected NWS service or its tiles are unavailable, the app falls back to RainViewer's 512 px HD tiles.

Zoom is constrained to the active radar source. RainViewer's documented provider limit is zoom 7, exposed as map zoom 8 because its 512 px tiles use a `-1` Leaflet zoom offset. NWS super-resolution radar is capped at map zoom 11 to show its roughly 250 m range-gate detail without allowing extreme enlargement. The USGS basemap is never overzoomed beyond its native zoom 16.

Active Tornado Warnings and Flash Flood Warnings appear in a translucent red banner pinned to the top of either page for its selected location. The forecast banner refreshes every minute. The NC Status banner follows the five-minute statewide-alert refresh and county selection. Expired warnings are removed; if updates fail, unexpired last-known warnings remain with an update-unavailable notice.

## Privacy and scope

Forecast and ZIP requests go directly from the browser to their named providers. On NC Status, device coordinates are used only in memory to match the bundled county geometry and are neither transmitted nor saved. ZIP lookup sends the entered ZIP to Zippopotam.us. The optional remembered setting stores only the selected county FIPS code.

The NC Status page covers North Carolina only and is informational. It does not replace Wireless Emergency Alerts, utility reporting, official agency instructions, emergency services, or confirmation from an internet or electric provider.
