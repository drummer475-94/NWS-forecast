# NWS Forecast

Mobile-first static weather app using National Weather Service forecasts, observations, alerts, and quantitative precipitation data. It includes current conditions, the next 24-hour precipitation total, hourly and seven-day outlooks, and an animated RainViewer radar over a USGS basemap.

## Local use

Serve the repository with any static web server and open `index.html`. The app has no build step or server-side runtime.

## Data sources

- National Weather Service API
- RainViewer weather maps
- USGS National Map tiles
- Zippopotam.us ZIP lookup

The radar supports map zoom levels 2 through 18, automatically overzooming provider tiles beyond their native resolution. If HD tiles fail, it falls back to standard quality and exposes a manual retry control when the radar service is unavailable.
