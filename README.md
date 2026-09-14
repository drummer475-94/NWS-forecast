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
node --test
```

## NC Status data flow

The Pages deployment runs twice hourly and replaces `data/nc-status.json` only after both upstream responses produce a complete, validated snapshot. Validation requires all 100 NC counties, unique valid FIPS values, nonnegative integer outage totals, valid source timestamps, and structurally valid NWS alerts. If refresh or validation fails, deployment stops and the previous valid Pages deployment remains available.

To build and verify a snapshot locally:

```sh
node scripts/refresh-nc-status.mjs
node scripts/verify-nc-status.mjs
```

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
