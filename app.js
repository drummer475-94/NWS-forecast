const NWS_HEADERS = {
  "Accept": "application/geo+json"
};

const MAP_MAX_ZOOM = 18;
const RAINVIEWER_NATIVE_ZOOM = 10;
const RAINVIEWER_FRAME_LIMIT = 14;
const RAINVIEWER_FRAME_MS = 650;
const RAINVIEWER_OPACITY = 0.72;

const state = {
  lat: null,
  lon: null,
  city: "",
  office: "",
  forecastUrl: "",
  hourlyUrl: "",
  map: null,
  marker: null,
  streetLayer: null,
  satelliteLayer: null,
  rainviewerLayer: null,
  rainviewerLayers: new Map(),
  rainviewerHost: "",
  rainviewerFrames: [],
  rainviewerFrameIndex: 0,
  rainviewerHd: true,
  radarAnimationTimer: 0,
  activeBaseMap: "street"
};

const el = {
  refreshButton: document.querySelector("#refreshButton"),
  locationLabel: document.querySelector("#locationLabel"),
  updatedLabel: document.querySelector("#updatedLabel"),
  currentTemp: document.querySelector("#currentTemp"),
  currentSummary: document.querySelector("#currentSummary"),
  feelsLike: document.querySelector("#feelsLike"),
  wind: document.querySelector("#wind"),
  humidity: document.querySelector("#humidity"),
  zipLocationForm: document.querySelector("#zipLocationForm"),
  zipLocation: document.querySelector("#zipLocation"),
  manualLocationForm: document.querySelector("#manualLocationForm"),
  manualLocation: document.querySelector("#manualLocation"),
  hourlyForecast: document.querySelector("#hourlyForecast"),
  hourlyCount: document.querySelector("#hourlyCount"),
  dailyForecast: document.querySelector("#dailyForecast"),
  dailyOffice: document.querySelector("#dailyOffice"),
  alertsPanel: document.querySelector("#alertsPanel"),
  alertsCount: document.querySelector("#alertsCount"),
  alertsList: document.querySelector("#alertsList"),
  radarTimestamp: document.querySelector("#radarTimestamp"),
  radarPlayButton: document.querySelector("#radarPlayButton"),
  radarHdButton: document.querySelector("#radarHdButton"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  zoomInButton: document.querySelector("#zoomInButton"),
  streetMapButton: document.querySelector("#streetMapButton"),
  satelliteMapButton: document.querySelector("#satelliteMapButton"),
  centerMapButton: document.querySelector("#centerMapButton"),
  toast: document.querySelector("#toast")
};

document.addEventListener("DOMContentLoaded", init);
el.refreshButton.addEventListener("click", () => refreshForecast());
el.zipLocationForm.addEventListener("submit", handleZipLocation);
el.manualLocationForm.addEventListener("submit", handleManualLocation);
el.radarPlayButton.addEventListener("click", toggleRadarAnimation);
el.radarHdButton.addEventListener("click", toggleRadarHd);
el.zoomOutButton.addEventListener("click", () => state.map.zoomOut());
el.zoomInButton.addEventListener("click", () => state.map.zoomIn());
el.streetMapButton.addEventListener("click", () => setBaseMap("street"));
el.satelliteMapButton.addEventListener("click", () => setBaseMap("satellite"));
el.centerMapButton.addEventListener("click", centerMap);

function init() {
  initMap(39.8283, -98.5795, 4);
  loadRainViewerLayer();

  if (!navigator.geolocation) {
    showToast("Location is not available in this browser. Enter latitude and longitude manually.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude } = position.coords;
      loadForecast(latitude, longitude);
    },
    () => {
      showToast("Location permission was not granted. Enter latitude and longitude manually.");
      el.locationLabel.textContent = "Manual location needed";
      el.updatedLabel.textContent = "Use a ZIP code or latitude, longitude pair.";
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 10 * 60 * 1000 }
  );
}

async function refreshForecast() {
  if (!state.lat || !state.lon) {
    showToast("Enter a location first.");
    return;
  }
  await loadForecast(state.lat, state.lon);
  await loadRainViewerLayer();
}

async function handleZipLocation(event) {
  event.preventDefault();
  const zip = el.zipLocation.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    showToast("Enter a 5 digit US ZIP code.");
    return;
  }

  setLoading(true);
  try {
    const data = await fetchJson(`https://api.zippopotam.us/us/${zip}`, {});
    const place = data.places?.[0];
    const lat = Number.parseFloat(place?.latitude);
    const lon = Number.parseFloat(place?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`ZIP code ${zip} did not return usable coordinates.`);
    }

    state.city = `${place["place name"]}, ${place["state abbreviation"]}`;
    el.manualLocation.value = `${roundCoord(lat)}, ${roundCoord(lon)}`;
    await loadForecast(lat, lon);
  } catch (error) {
    console.error(error);
    showToast(`ZIP code ${zip} could not be found.`);
  } finally {
    setLoading(false);
  }
}

async function handleManualLocation(event) {
  event.preventDefault();
  const parsed = parseLatLon(el.manualLocation.value);
  if (!parsed) {
    showToast("Use decimal latitude and longitude, for example 38.8977, -77.0365.");
    return;
  }
  await loadForecast(parsed.lat, parsed.lon);
}

async function loadForecast(lat, lon) {
  setLoading(true);
  state.lat = roundCoord(lat);
  state.lon = roundCoord(lon);

  try {
    const point = await fetchJson(`https://api.weather.gov/points/${state.lat},${state.lon}`);
    const props = point.properties;
    state.forecastUrl = props.forecast;
    state.hourlyUrl = props.forecastHourly;
    state.office = props.cwa || "";
    state.city = formatRelativeLocation(props.relativeLocation);

    const [daily, hourly, alerts] = await Promise.all([
      fetchJson(state.forecastUrl),
      fetchJson(state.hourlyUrl),
      fetchJson(`https://api.weather.gov/alerts/active?point=${state.lat},${state.lon}`).catch(() => null)
    ]);

    updateCurrent(hourly.properties.periods[0], hourly.properties.generatedAt);
    renderHourly(hourly.properties.periods.slice(0, 24));
    renderDaily(daily.properties.periods, hourly.properties.periods);
    renderAlerts(alerts?.features || []);
    updateLocationLabels(daily.properties.updated);
    updateMapPosition(state.lat, state.lon);
  } catch (error) {
    console.error(error);
    showToast(error.message || "NWS forecast data could not be loaded.");
    el.updatedLabel.textContent = "Forecast unavailable. Try another nearby location.";
  } finally {
    setLoading(false);
  }
}

function updateCurrent(period, generatedAt) {
  if (!period) return;
  const humidityValue = getQuantValue(period.relativeHumidity);
  const feels = calculateFeelsLike(period.temperature, humidityValue, period.windSpeed);

  el.currentTemp.textContent = Math.round(period.temperature);
  el.currentSummary.textContent = period.shortForecast || "Forecast unavailable";
  el.feelsLike.textContent = Number.isFinite(feels) ? `${Math.round(feels)}°` : `${Math.round(period.temperature)}°`;
  el.wind.textContent = compactWind(period.windSpeed, period.windDirection);
  el.humidity.textContent = Number.isFinite(humidityValue) ? `${Math.round(humidityValue)}%` : "--";
  el.updatedLabel.textContent = generatedAt ? `Updated ${formatDateTime(generatedAt)}` : "Updated by NWS";
}

function renderHourly(periods) {
  el.hourlyCount.textContent = `${periods.length} hours`;
  el.hourlyForecast.innerHTML = "";

  if (!periods.length) {
    el.hourlyForecast.innerHTML = `<div class="empty-state">No hourly forecast returned by NWS.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const period of periods) {
    const humidityValue = getQuantValue(period.relativeHumidity);
    const feels = calculateFeelsLike(period.temperature, humidityValue, period.windSpeed);
    const card = document.createElement("article");
    card.className = "hour-card";
    card.innerHTML = `
      <div class="hour-time">${formatHour(period.startTime)}</div>
      <img class="hour-icon" src="${safeUrl(period.icon)}" alt="">
      <div class="hour-temp">${Math.round(period.temperature)}°</div>
      <div class="hour-feels">Feels ${Number.isFinite(feels) ? Math.round(feels) : Math.round(period.temperature)}°</div>
    `;
    fragment.append(card);
  }
  el.hourlyForecast.append(fragment);
}

function renderAlerts(features) {
  const alerts = features
    .map(feature => feature.properties)
    .filter(alert => /\b(watch|warning)\b/i.test(alert.event || ""))
    .sort((a, b) => new Date(a.ends || a.expires || 0) - new Date(b.ends || b.expires || 0));

  el.alertsList.innerHTML = "";
  el.alertsCount.textContent = alerts.length ? `${alerts.length} active` : "None";
  el.alertsPanel.classList.remove("hidden");

  if (!alerts.length) {
    el.alertsList.innerHTML = `<div class="empty-state">No active watches or warnings for this location.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const alert of alerts.slice(0, 6)) {
    const card = document.createElement("article");
    card.className = `alert-card ${alert.messageType === "Alert" ? "alert-card-hot" : ""}`;
    card.innerHTML = `
      <div>
        <div class="alert-title">${escapeHtml(alert.event || "Weather alert")}</div>
        <p class="alert-headline">${escapeHtml(alert.headline || alert.areaDesc || "NWS active alert")}</p>
      </div>
      <div class="alert-meta">
        <span>${escapeHtml(alert.severity || "Alert")}</span>
        <span>${formatAlertEnds(alert.ends || alert.expires)}</span>
      </div>
    `;
    fragment.append(card);
  }
  el.alertsList.append(fragment);
}

function renderDaily(periods, hourlyPeriods = []) {
  el.dailyOffice.textContent = state.office ? `${state.office} office` : "NWS";
  el.dailyForecast.innerHTML = "";

  const dayPeriods = mergeDailyPeriods(periods).slice(0, 7);
  const heatByDay = getHeatAlertsByDay(hourlyPeriods);
  if (!dayPeriods.length) {
    el.dailyForecast.innerHTML = `<div class="empty-state">No 7 day forecast returned by NWS.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const day of dayPeriods) {
    const card = document.createElement("article");
    card.className = "day-card";
    const heatAlert = heatByDay.get(day.dateKey);
    card.innerHTML = `
      <img src="${safeUrl(day.icon)}" alt="">
      <div>
        <div class="day-name">${escapeHtml(day.name)}</div>
        ${heatAlert ? `<div class="heat-banner">Feels like up to ${Math.round(heatAlert)}°</div>` : ""}
        <p class="day-summary">${escapeHtml(day.summary)}</p>
      </div>
      <div class="day-temp">${formatHighLow(day)}</div>
    `;
    fragment.append(card);
  }
  el.dailyForecast.append(fragment);
}

function mergeDailyPeriods(periods) {
  const days = new Map();
  for (const period of periods) {
    const date = new Date(period.startTime);
    const key = date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric"
    });
    const existing = days.get(key) || {
      name: key,
      dateKey: toDateKey(period.startTime),
      high: null,
      low: null,
      icon: period.icon,
      summary: period.detailedForecast || period.shortForecast || ""
    };

    if (period.isDaytime) {
      existing.high = period.temperature;
      existing.icon = period.icon || existing.icon;
      existing.summary = period.detailedForecast || period.shortForecast || existing.summary;
    } else {
      existing.low = period.temperature;
    }
    days.set(key, existing);
  }
  return Array.from(days.values());
}

function getHeatAlertsByDay(periods) {
  const heatByDay = new Map();
  for (const period of periods) {
    const humidity = getQuantValue(period.relativeHumidity);
    const feels = calculateFeelsLike(period.temperature, humidity, period.windSpeed);
    if (!Number.isFinite(feels) || feels <= 90) continue;

    const key = toDateKey(period.startTime);
    const existing = heatByDay.get(key) || -Infinity;
    heatByDay.set(key, Math.max(existing, feels));
  }
  return heatByDay;
}

function toDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatAlertEnds(value) {
  if (!value) return "Until further notice";
  return `Until ${new Date(value).toLocaleTimeString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  })}`;
}

function initMap(lat, lon, zoom) {
  state.map = L.map("radarMap", {
    zoomControl: false,
    tap: true,
    touchZoom: true,
    scrollWheelZoom: false,
    minZoom: 2,
    maxZoom: MAP_MAX_ZOOM,
    zoomSnap: 0.25,
    zoomDelta: 0.5
  }).setView([lat, lon], zoom);

  state.streetLayer = L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: MAP_MAX_ZOOM,
    maxNativeZoom: 16,
    updateWhenIdle: true,
    keepBuffer: 3,
    attribution: "USGS Topo"
  }).addTo(state.map);

  state.satelliteLayer = L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: MAP_MAX_ZOOM,
    maxNativeZoom: 16,
    updateWhenIdle: true,
    keepBuffer: 3,
    attribution: "USGS Imagery"
  });

  state.marker = L.circleMarker([lat, lon], {
    radius: 7,
    color: "#ffffff",
    weight: 2,
    fillColor: "#22c55e",
    fillOpacity: 0.95
  }).addTo(state.map);
}

async function loadRainViewerLayer() {
  const shouldResumeAnimation = Boolean(state.radarAnimationTimer);
  if (shouldResumeAnimation) {
    stopRadarAnimation();
  }

  try {
    const data = await fetchJson("https://api.rainviewer.com/public/weather-maps.json", {});
    state.rainviewerHost = data.host;
    state.rainviewerFrames = getRainViewerFrames(data);
    if (!state.rainviewerFrames.length) throw new Error("RainViewer returned no radar frames.");

    state.rainviewerFrameIndex = state.rainviewerFrames.length - 1;
    resetRainViewerLayers();
    renderRainViewerFrame(state.rainviewerFrameIndex);
    preloadRainViewerFrames(state.rainviewerFrameIndex);

    if (shouldResumeAnimation) {
      startRadarAnimation();
    }
  } catch (error) {
    console.error(error);
    resetRainViewerLayers();
    el.radarTimestamp.textContent = "RainViewer unavailable";
    showToast("RainViewer radar is temporarily unavailable.");
  }
}

function getRainViewerFrames(data) {
  return [
    ...(data?.radar?.past || []),
    ...(data?.radar?.nowcast || [])
  ].slice(-RAINVIEWER_FRAME_LIMIT);
}

function resetRainViewerLayers() {
  for (const layer of state.rainviewerLayers.values()) {
    if (state.map.hasLayer(layer)) {
      state.map.removeLayer(layer);
    }
  }
  state.rainviewerLayers.clear();
  state.rainviewerLayer = null;
}

function renderRainViewerFrame(index) {
  const frameCount = state.rainviewerFrames.length;
  if (!frameCount) return;

  state.rainviewerFrameIndex = (index + frameCount) % frameCount;
  const nextLayer = ensureRainViewerLayer(state.rainviewerFrameIndex);
  if (!nextLayer) return;

  for (const layer of state.rainviewerLayers.values()) {
    layer.setOpacity(layer === nextLayer ? RAINVIEWER_OPACITY : 0);
  }

  state.rainviewerLayer = nextLayer;
  bringRadarForward();

  const frame = state.rainviewerFrames[state.rainviewerFrameIndex];
  el.radarTimestamp.textContent = `Radar ${formatUnix(frame.time)}${state.rainviewerHd ? " HD" : ""}`;
}

function ensureRainViewerLayer(index) {
  const frame = state.rainviewerFrames[index];
  if (!frame || !state.rainviewerHost) return null;

  const key = `${state.rainviewerHd ? "hd" : "sd"}:${frame.path}`;
  const existing = state.rainviewerLayers.get(key);
  if (existing) return existing;

  const size = state.rainviewerHd ? 512 : 256;
  const maxNativeZoom = state.rainviewerHd ? RAINVIEWER_NATIVE_ZOOM + 1 : RAINVIEWER_NATIVE_ZOOM;
  const layer = L.tileLayer(`${state.rainviewerHost}${frame.path}/${size}/{z}/{x}/{y}/2/1_1.png`, {
    tileSize: size,
    zoomOffset: size === 512 ? -1 : 0,
    minZoom: 0,
    maxZoom: MAP_MAX_ZOOM,
    minNativeZoom: 0,
    maxNativeZoom,
    opacity: 0,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 3,
    className: "rainviewer-tile",
    attribution: state.rainviewerHd ? "RainViewer HD" : "RainViewer"
  });

  layer.addTo(state.map);
  layer.setOpacity(0);
  state.rainviewerLayers.set(key, layer);
  return layer;
}

function preloadRainViewerFrames(activeIndex) {
  const frameCount = state.rainviewerFrames.length;
  if (!frameCount) return;

  window.requestAnimationFrame(() => {
    for (let offset = 1; offset < frameCount; offset += 1) {
      ensureRainViewerLayer((activeIndex + offset) % frameCount);
    }
    bringRadarForward();
  });
}

function toggleRadarAnimation() {
  if (state.radarAnimationTimer) {
    stopRadarAnimation();
    return;
  }
  startRadarAnimation();
}

function startRadarAnimation() {
  if (state.radarAnimationTimer) return;
  if (state.rainviewerFrames.length < 2) {
    showToast("Radar animation is not available yet.");
    return;
  }

  preloadRainViewerFrames(state.rainviewerFrameIndex);
  el.radarPlayButton.textContent = "Pause";
  el.radarPlayButton.classList.add("active");
  state.radarAnimationTimer = window.setInterval(() => {
    renderRainViewerFrame(state.rainviewerFrameIndex + 1);
  }, RAINVIEWER_FRAME_MS);
}

function stopRadarAnimation() {
  if (!state.radarAnimationTimer) return;
  window.clearInterval(state.radarAnimationTimer);
  state.radarAnimationTimer = 0;
  el.radarPlayButton.textContent = "Play";
  el.radarPlayButton.classList.remove("active");
}

function toggleRadarHd() {
  const shouldResumeAnimation = Boolean(state.radarAnimationTimer);
  if (shouldResumeAnimation) {
    stopRadarAnimation();
  }

  state.rainviewerHd = !state.rainviewerHd;
  el.radarHdButton.classList.toggle("active", state.rainviewerHd);
  el.radarHdButton.textContent = state.rainviewerHd ? "HD" : "SD";
  resetRainViewerLayers();
  renderRainViewerFrame(state.rainviewerFrameIndex);
  preloadRainViewerFrames(state.rainviewerFrameIndex);

  if (shouldResumeAnimation) {
    startRadarAnimation();
  }
}

function setBaseMap(source) {
  state.activeBaseMap = source;
  el.streetMapButton.classList.toggle("active", source === "street");
  el.satelliteMapButton.classList.toggle("active", source === "satellite");

  if (state.streetLayer && state.map.hasLayer(state.streetLayer)) {
    state.map.removeLayer(state.streetLayer);
  }
  if (state.satelliteLayer && state.map.hasLayer(state.satelliteLayer)) {
    state.map.removeLayer(state.satelliteLayer);
  }

  if (source === "satellite") {
    state.satelliteLayer.addTo(state.map);
  } else {
    state.streetLayer.addTo(state.map);
  }
  bringRadarForward();
}

function bringRadarForward() {
  for (const layer of state.rainviewerLayers.values()) {
    if (layer !== state.rainviewerLayer && state.map.hasLayer(layer)) {
      layer.bringToFront();
    }
  }
  if (state.rainviewerLayer && state.map.hasLayer(state.rainviewerLayer)) {
    state.rainviewerLayer.bringToFront();
  }
  if (state.marker) {
    state.marker.bringToFront();
  }
}

function centerMap() {
  if (!state.lat || !state.lon) return;
  state.map.setView([state.lat, state.lon], Math.max(state.map.getZoom(), 8), { animate: true });
}

function updateMapPosition(lat, lon) {
  state.marker.setLatLng([lat, lon]);
  state.map.setView([lat, lon], 8, { animate: true });
  window.setTimeout(() => state.map.invalidateSize(), 80);
}

async function fetchJson(url, headers = NWS_HEADERS) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`);
  }
  return response.json();
}

function parseLatLon(value) {
  const parts = value.split(",").map(part => Number.parseFloat(part.trim()));
  if (parts.length !== 2 || parts.some(part => Number.isNaN(part))) return null;
  const [lat, lon] = parts;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function getQuantValue(value) {
  if (!value) return NaN;
  if (typeof value === "number") return value;
  if (typeof value.value === "number") return value.value;
  return NaN;
}

function calculateFeelsLike(tempF, humidity, windSpeedText) {
  const windMph = parseWindMph(windSpeedText);
  if (tempF >= 80 && Number.isFinite(humidity) && humidity >= 40) {
    return heatIndex(tempF, humidity);
  }
  if (tempF <= 50 && windMph > 3) {
    return windChill(tempF, windMph);
  }
  return tempF;
}

function heatIndex(tempF, humidity) {
  return -42.379 +
    2.04901523 * tempF +
    10.14333127 * humidity -
    0.22475541 * tempF * humidity -
    0.00683783 * tempF * tempF -
    0.05481717 * humidity * humidity +
    0.00122874 * tempF * tempF * humidity +
    0.00085282 * tempF * humidity * humidity -
    0.00000199 * tempF * tempF * humidity * humidity;
}

function windChill(tempF, windMph) {
  return 35.74 + 0.6215 * tempF - 35.75 * Math.pow(windMph, 0.16) + 0.4275 * tempF * Math.pow(windMph, 0.16);
}

function parseWindMph(text = "") {
  const matches = text.match(/\d+/g);
  if (!matches) return 0;
  const values = matches.map(Number);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compactWind(speed, direction) {
  if (!speed || speed.toLowerCase() === "calm") return "Calm";
  return direction ? `${direction} ${speed}` : speed;
}

function formatHighLow(day) {
  const high = Number.isFinite(day.high) ? `${Math.round(day.high)}°` : "--";
  const low = Number.isFinite(day.low) ? `${Math.round(day.low)}°` : "--";
  return `${high} / ${low}`;
}

function formatRelativeLocation(location) {
  const props = location?.properties;
  if (!props?.city || !props?.state) return `${state.lat}, ${state.lon}`;
  return `${props.city}, ${props.state}`;
}

function updateLocationLabels(updated) {
  el.locationLabel.textContent = state.city || `${state.lat}, ${state.lon}`;
  if (updated) {
    el.updatedLabel.textContent = `Updated ${formatDateTime(updated)}`;
  }
}

function formatDateTime(value) {
  return new Date(value).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatHour(value) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric"
  });
}

function formatUnix(value) {
  return new Date(value * 1000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function setLoading(isLoading) {
  el.refreshButton.disabled = isLoading;
  el.refreshButton.style.opacity = isLoading ? "0.55" : "1";
}

let toastTimer = 0;
function showToast(message) {
  window.clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add("show");
  toastTimer = window.setTimeout(() => el.toast.classList.remove("show"), 5200);
}
