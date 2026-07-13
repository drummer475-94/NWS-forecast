# NWS Forecast

Mobile-first static weather app using National Weather Service forecasts, observations, alerts, quantitative precipitation data, and local NEXRAD imagery. It includes current conditions, the next 24-hour precipitation total, hourly and seven-day outlooks, and animated radar over a USGS basemap.

## Local use

Serve the repository with any static web server and open `index.html`. The app has no build step or server-side runtime.

## Data sources

- National Weather Service API
- NOAA/NWS NEXRAD OGC web services
- RainViewer weather maps (nationwide fallback)
- USGS National Map tiles
- Zippopotam.us ZIP lookup

Radar is always high definition; there is no SD mode or SD fallback. After a forecast location is loaded, the app prefers the assigned NWS station's time-enabled Super Resolution Base Reflectivity layer. Nearby WSR-88D sites from the NWS radar-station API appear as clickable dots on the map so users can manually choose a site that may provide better coverage than auto-detect. If the selected NWS service or its tiles are unavailable, the app falls back to RainViewer's 512 px HD tiles.

Zoom is constrained to the active radar source. RainViewer's documented provider limit is zoom 7, exposed as map zoom 8 because its 512 px tiles use a `-1` Leaflet zoom offset. NWS super-resolution radar is capped at map zoom 11 to show its roughly 250 m range-gate detail without allowing extreme enlargement. The USGS basemap is never overzoomed beyond its native zoom 16.
