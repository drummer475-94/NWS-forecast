# NWS Local Weather

NWS Local Weather is a mobile-first, single-page static app for U.S. forecasts. It uses National Weather Service forecasts, observations, alerts, quantitative precipitation data, and local NEXRAD imagery, with no framework or build step.

## What it shows

`index.html` provides current conditions, next-24-hour precipitation, hourly and seven-day forecasts, all active alerts for the point, a severe weather panel when warnings are active, animated radar, the latest forecast discussion, and a data source health panel for a U.S. location. The `theme` browser preference stores the light/dark choice.

## Local use

Serve the repository with any static web server; do not open the page through `file://`.

```sh
python -m http.server 8000
```

Open `http://localhost:8000/`. There is no package install or build step.

Run the checks with Node.js 24:

```sh
node --check app.js
node --check severe-weather.js
node --test
```

Browser smoke tests (forecast page at 320, 375 and 1280 px, with every external provider stubbed) run in CI as the `browser-smoke` job. See [`tests/browser/README.md`](tests/browser/README.md) to run them locally.

## Alerts

An alert is active only when it is an `Actual` message (not Test, Exercise, System or Draft), is not a cancellation, and has not passed its `expires` or `ends` time. Alerts come from the NWS point query for the selected location, and each card links to its official NWS details.

The "Active alerts" panel lists every active alert for the point, not only watches and warnings, ordered by significance (warnings, then watches, advisories, statements, and anything else) and by soonest expiry within each group. Each card carries a text badge (Warning, Watch, Advisory, Statement or Other) so the type never depends on color. At most six cards are shown; if more are active the panel says "Showing 6 of N" and links to the point's forecast page on weather.gov, which lists every hazard for the coordinates. Only Tornado and Flash Flood Warnings drive the red banner and only warnings open the severe weather panel; advisories, statements and watches never do.

### Location naming

A ZIP lookup labels the location with the ZIP's own place name and state (for example "Wilmington, NC" for 28401), because the nearest NWS named point can be a different town. That label is kept across refreshes of the same location and is dropped as soon as a different ZIP or a device location loads; device locations are labeled with the NWS `relativeLocation`. The location line, the severe weather panel and other text all use the same label.

### Forecast icons

Hourly and daily icons load straight from api.weather.gov with no extra requests. NWS occasionally answers an icon request with a non-image error body, which the browser blocks. When an icon fails, the app retries once with only the first condition if the icon path combines two (`.../rain_showers,20/tsra_hi,20` becomes `.../rain_showers,20`); if that also fails, or the icon had a single condition, the broken image is replaced by an emoji chosen from the period's short forecast. The replacement keeps the image's accessible name (decorative daily icons stay hidden from assistive technology). No inline `onerror` handlers are used.

## Data sources

- National Weather Service API
- NOAA/NWS NEXRAD OGC web services
- RainViewer weather maps (nationwide radar fallback)
- USGS National Map tiles
- Zippopotam.us ZIP lookup

A "Radar source" switch above the map chooses between **Local NWS radar** (the default) and **National (RainViewer)**. It is a pair of real radio buttons, so arrow keys and Space work. The choice is remembered per viewer in `localStorage` under `radarSource`; if storage is unavailable the app still works and defaults to Local. Choosing National loads RainViewer HD and keeps it: forecast loads, ZIP or location changes, the five-minute refresh and Retry never switch back to NWS, and it is not treated as a fallback (the data-source row reads "Active: RainViewer HD (national, selected)"). The nearby radar dots stay on the map in both modes; clicking or pressing Enter on one switches to Local and selects that station, and "Use auto-detect" also returns to Local. With Local, a failed NWS service or tile load falls back to RainViewer while the switch stays on Local, and a visible note says "NWS radar unavailable — showing RainViewer national radar as a fallback" with Retry radar available. Local without a known station (no location yet, or none for the point) shows a note and uses RainViewer. Switching sources keeps the map centre, clamps zoom to the new source's limit and restarts animation, refresh timer and layers cleanly; if RainViewer is already on screen no reload is made. Choosing a source never changes the manually selected station for the current location.

Radar is always high definition; there is no SD mode or SD fallback. After a forecast location is loaded, the app prefers the assigned NWS station's time-enabled Super Resolution Base Reflectivity layer. Nearby WSR-88D sites from the NWS radar-station API appear as clickable dots on the map so users can manually choose a site that may provide better coverage than auto-detect. If the selected NWS service or its tiles are unavailable, the app falls back to RainViewer's 512 px HD tiles. Radar frame metadata is refreshed about every five minutes while the page is visible and online, without recreating the map or changing the selected station, source or zoom limits. Cached frame layers are reused, frames that age out are removed, and animation state is kept. The radar panel shows the newest scan time from the provider metadata. A failed refresh keeps the existing frames with a notice and does not trigger the fallback.

Zoom is constrained to the active radar source. RainViewer's documented provider limit is zoom 7, exposed as map zoom 8 because its 512 px tiles use a `-1` Leaflet zoom offset. NWS super-resolution radar is capped at map zoom 11 to show its roughly 250 m range-gate detail without allowing extreme enlargement. The USGS basemap is never overzoomed beyond its native zoom 16.

### Current conditions and loading

The forecast page renders hourly and daily forecasts as soon as they arrive. Station observations and gridpoint precipitation load in parallel and update the current-conditions panel when ready; a slow or failed optional request never delays or blocks the forecast. Each location load has its own request context, so responses for a previous location are discarded instead of overwriting the newer one.

Current temperature, humidity, wind, visibility and feels-like use measured values from a nearby NWS station only when the observation is at most 90 minutes old and the individual value is present and not quality-control flagged (X, Q or B). The panel names the station and observation time. Each missing or rejected value falls back to the hourly forecast and is labeled “Forecast,” so a prediction is never presented as an observation. When no usable observation exists, the panel says it is showing the forecast for this hour and why.

Active Tornado Warnings and Flash Flood Warnings appear in a translucent red banner pinned to the top of the page for the selected location. The banner refreshes every minute. Expired warnings are removed; if updates fail, unexpired last-known warnings remain with an update-unavailable notice.

### Forecast discussion

After a location resolves, the forecast page requests the latest Area Forecast Discussion (AFD) from the location's forecast office (`/products/types/AFD/locations/<office>/latest` on api.weather.gov, one request that includes the text). The product list endpoint is not used because it has been observed serving week-old entries whose products no longer exist. The section shows the issuing office, the issue time in the location's time zone and its age. The text is the forecasters' own technical writing shown verbatim: it is split into its `.HEADER...` sections for easier reading once the reader opens the section, the complete original product text is always available, and nothing is summarized, reworded or interpreted. A discussion more than 24 hours old is labeled as such. The section links to the official discussion on weather.gov. If the discussion cannot be loaded, the section says so (and keeps the official link) without affecting the rest of the forecast; the next refresh tries again.

### Severe weather mode

A "Severe weather" panel appears at the top of the forecast page whenever the selected point has an active NWS **Warning** of any type (`/alerts/active?point=`). Watches and advisories never open it. Active uses the same rule as the rest of the app: status `Actual`, not a `Cancel`, `ends` (or `expires`) in the future, and `effective`/`onset` not in the future. Warnings are ordered Tornado, Extreme Wind, Severe Thunderstorm, Flash Flood, Hurricane, Storm Surge, Tropical Storm, Blizzard, Ice Storm, Winter Storm, then all other warnings, and by soonest expiry within a type.

Each warning shows the NWS headline, area, sender, effective time, expiry (with minutes remaining, refreshed each minute), the detection, hail, wind-gust and damage-threat parameters when NWS supplies them, the full description and the "What to do" instruction. NWS text is shown exactly as published (inserted as text, never reworded or summarized) and links to the official `api.weather.gov` alert. The panel can be minimized to a one-line summary; it expands again only when a warning that was not present at minimize time appears. The freshness line gives the alerts check time and latest radar scan; if alert polling is failing, a notice says the warnings shown are the last received. "Show local radar" scrolls to and focuses the radar section without changing a manually selected radar.

### Data source health

A collapsed "Data sources" panel at the bottom of the forecast page (and a small "Data sources: all current / 1 stale / 2 issues" pill under the hero's updated label, which opens and focuses the panel) shows the state of each upstream provider: NWS forecast, station observation, gridpoint precipitation, alerts and forecast discussion, radar, the ZIP lookup (listed only after it has been used) and the USGS basemap (listed once its tiles have loaded or failed). Each row gives a status, the clock time of the last successful update in the location's time zone, how old the data is, and a short explanation. The radar row names the active provider and, when NWS super-resolution failed, says that the RainViewer HD fallback is active; National chosen with the radar source switch is reported as selected, not as a fallback.

Health is derived only from requests the app already makes. There is no extra polling and no separate probe request, and ages refresh once a minute only while the page is visible. A source that already has good data keeps showing it while it re-checks, and a failed refresh keeps the last good data's age ("Last good data: 20 min old"). Records for location-dependent sources go back to "Checking" when the location changes, and responses from superseded loads never update them.

Data is flagged stale when:

- the forecast's generation time is more than 3 hours old;
- the station observation is older than 90 minutes (the same limit that sends the hero panel back to the forecast values);
- the last successful alerts check (alerts are polled every minute) is more than 5 minutes old;
- the newest radar scan is more than 30 minutes old;
- the forecast discussion was issued more than 24 hours ago.

Errors are classified so a provider failure is not mistaken for a bug. A provider error is an HTTP error status, timeout, network failure, unparseable response, or an upstream response the app cannot use (for example NWS returning no forecast endpoints); an offline error means the device has no connection; an app error is an unexpected exception from this page's own code. App errors are caught per rendering step so the rest of the page keeps working, and the row tells the reader to reload and report the problem if it persists. Cancelled requests are never recorded as failures.

The page's health is derived from its real requests rather than from a scheduled check, so it reflects what the visitor is actually receiving.

## Privacy and scope

Forecast and ZIP requests go directly from the browser to their named providers. ZIP lookup sends the entered ZIP to Zippopotam.us. The app is informational and does not replace Wireless Emergency Alerts, official agency instructions, or emergency services.
