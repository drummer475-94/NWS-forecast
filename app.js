const NWS_HEADERS = { Accept: 'application/geo+json' };
const MAP_MIN_ZOOM = 2;
const MAP_MAX_ZOOM = 18;
const RADAR_API = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_NATIVE_ZOOM = 10;
const RADAR_FRAME_LIMIT = 12;
const RADAR_FRAME_MS = 650;
const RADAR_OPACITY = 0.76;
const RADAR_CACHE_LIMIT = 4;
const TRANSPARENT_TILE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

const state = {
  lat: null,
  lon: null,
  city: '',
  office: '',
  forecastUrl: '',
  hourlyUrl: '',
  gridDataUrl: '',
  requestController: null,
  map: null,
  marker: null,
  streetLayer: null,
  radarController: null,
  radarLoadId: 0,
  radarLayer: null,
  radarLayers: new Map(),
  radarHost: '',
  radarFrames: [],
  radarFrameIndex: 0,
  radarHd: true,
  radarHdFallbackUsed: false,
  radarAnimationFrame: 0,
  radarNextFrameAt: 0,
  radarPreloadTimer: 0,
  radarResumeOnVisible: false,
  lastBaseMapErrorAt: 0
};

const el = {
  refreshButton: document.querySelector('#refreshButton'),
  locationLabel: document.querySelector('#locationLabel'),
  updatedLabel: document.querySelector('#updatedLabel'),
  currentTemp: document.querySelector('#currentTemp'),
  currentSummary: document.querySelector('#currentSummary'),
  feelsLike: document.querySelector('#feelsLike'),
  wind: document.querySelector('#wind'),
  humidity: document.querySelector('#humidity'),
  zipLocationForm: document.querySelector('#zipLocationForm'),
  zipLocation: document.querySelector('#zipLocation'),
  precipChance: document.querySelector('#precipChance'),
  dewPoint: document.querySelector('#dewPoint'),
  visibility: document.querySelector('#visibility'),
  precipTotal: document.querySelector('#precipTotal'),
  hourlyForecast: document.querySelector('#hourlyForecast'),
  hourlyCount: document.querySelector('#hourlyCount'),
  dailyForecast: document.querySelector('#dailyForecast'),
  dailyOffice: document.querySelector('#dailyOffice'),
  alertsPanel: document.querySelector('#alertsPanel'),
  alertsCount: document.querySelector('#alertsCount'),
  alertsList: document.querySelector('#alertsList'),
  radarTimestamp: document.querySelector('#radarTimestamp'),
  radarStatus: document.querySelector('#radarStatus'),
  radarProgress: document.querySelector('#radarProgress'),
  radarPlayButton: document.querySelector('#radarPlayButton'),
  radarHdButton: document.querySelector('#radarHdButton'),
  radarRetryButton: document.querySelector('#radarRetryButton'),
  zoomOutButton: document.querySelector('#zoomOutButton'),
  zoomInButton: document.querySelector('#zoomInButton'),
  zoomLevel: document.querySelector('#zoomLevel'),
  centerMapButton: document.querySelector('#centerMapButton'),
  toast: document.querySelector('#toast')
};

document.addEventListener('DOMContentLoaded', init);
el.refreshButton.addEventListener('click', refreshAll);
el.zipLocationForm.addEventListener('submit', handleZipLocation);
el.radarPlayButton.addEventListener('click', toggleRadarAnimation);
el.radarHdButton.addEventListener('click', function () {
  switchRadarQuality(!state.radarHd);
});
el.radarRetryButton.addEventListener('click', loadRadar);
el.zoomOutButton.addEventListener('click', function () {
  if (state.map) state.map.zoomOut(1);
});
el.zoomInButton.addEventListener('click', function () {
  if (state.map) state.map.zoomIn(1);
});
el.centerMapButton.addEventListener('click', centerMap);

window.addEventListener('offline', function () {
  setRadarError('Offline â€” radar paused', false);
});
window.addEventListener('online', function () {
  loadRadar();
});
document.addEventListener('visibilitychange', handleVisibilityChange);

function init() {
  try {
    initMap(39.8283, -98.5795, 4);
    loadRadar();
  } catch (error) {
    console.error(error);
    setRadarError('Map could not start', false);
    showToast('The map library could not be loaded. Forecast data is still available.');
  }

  if (!navigator.geolocation) {
    showToast('Location is not available in this browser. Enter a ZIP code instead.');
    setManualLocationMessage();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function (position) {
      loadForecast(position.coords.latitude, position.coords.longitude);
    },
    function () {
      if (!hasLocation()) setManualLocationMessage();
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 10 * 60 * 1000 }
  );
}

function setManualLocationMessage() {
  showToast('Location permission was not granted. Enter a ZIP code instead.');
  el.locationLabel.textContent = 'Manual location needed';
  el.updatedLabel.textContent = 'Use a US ZIP code to load your local forecast.';
}

async function refreshAll() {
  const tasks = [loadRadar()];
  if (hasLocation()) {
    tasks.push(loadForecast(state.lat, state.lon));
  } else {
    showToast('Enter a location first.');
  }
  await Promise.allSettled(tasks);
}

async function handleZipLocation(event) {
  event.preventDefault();
  const zip = el.zipLocation.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    showToast('Enter a 5 digit US ZIP code.');
    return;
  }

  setLoading(true);
  try {
    const data = await fetchJson('https://api.zippopotam.us/us/' + zip, {
      headers: {},
      retries: 1
    });
    const place = data.places && data.places[0];
    const lat = Number.parseFloat(place && place.latitude);
    const lon = Number.parseFloat(place && place.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error('ZIP lookup returned no usable coordinates.');
    }

    state.city = place['place name'] + ', ' + place['state abbreviation'];
    await loadForecast(lat, lon);
  } catch (error) {
    if (error.status !== 404) console.error(error);
    showToast(error.status === 404
      ? 'ZIP code ' + zip + ' could not be found.'
      : 'ZIP lookup is unavailable. Check your connection and try again.');
  } finally {
    setLoading(false);
  }
}

async function loadForecast(lat, lon) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    showToast('The selected location is invalid.');
    return;
  }

  if (state.requestController) state.requestController.abort();
  const controller = new AbortController();
  state.requestController = controller;
  const signal = controller.signal;
  setLoading(true);
  state.lat = roundCoord(Number(lat));
  state.lon = roundCoord(Number(lon));

  try {
    const point = await fetchJson(
      'https://api.weather.gov/points/' + state.lat + ',' + state.lon,
      { signal: signal, retries: 1 }
    );
    const props = point && point.properties;
    if (!props || !props.forecast || !props.forecastHourly) {
      throw new Error('NWS did not return forecast endpoints for this location.');
    }

    state.forecastUrl = props.forecast;
    state.hourlyUrl = props.forecastHourly;
    state.gridDataUrl = props.forecastGridData || '';
    state.office = props.cwa || '';
    state.city = formatRelativeLocation(props.relativeLocation);

    const requests = await Promise.allSettled([
      fetchJson(state.forecastUrl, { signal: signal, retries: 1 }),
      fetchJson(state.hourlyUrl, { signal: signal, retries: 1 }),
      fetchJson('https://api.weather.gov/alerts/active?point=' + state.lat + ',' + state.lon, {
        signal: signal,
        retries: 1
      }),
      loadLatestObservation(props.observationStations, signal),
      state.gridDataUrl
        ? fetchJson(state.gridDataUrl, { signal: signal, retries: 1 })
        : Promise.resolve(null)
    ]);

    if (requests[0].status === 'rejected') throw requests[0].reason;
    if (requests[1].status === 'rejected') throw requests[1].reason;

    const daily = requests[0].value;
    const hourly = requests[1].value;
    const alerts = requests[2].status === 'fulfilled' ? requests[2].value : null;
    const observation = requests[3].status === 'fulfilled' ? requests[3].value : null;
    const gridData = requests[4].status === 'fulfilled' ? requests[4].value : null;
    const dailyPeriods = daily && daily.properties && daily.properties.periods;
    const hourlyPeriods = hourly && hourly.properties && hourly.properties.periods;
    if (!Array.isArray(dailyPeriods) || !Array.isArray(hourlyPeriods) || !hourlyPeriods.length) {
      throw new Error('NWS returned an incomplete forecast.');
    }

    const precipMm = calculate24HourPrecip(gridData && gridData.properties);
    updateCurrent(
      hourlyPeriods[0],
      hourly.properties.generatedAt,
      observation && observation.properties,
      precipMm
    );
    renderHourly(hourlyPeriods.slice(0, 24));
    renderDaily(dailyPeriods, hourlyPeriods);
    renderAlerts((alerts && alerts.features) || []);
    updateLocationLabels(daily.properties.updated);
    updateMapPosition(state.lat, state.lon);
  } catch (error) {
    if (isAbortError(error)) return;
    console.error(error);
    showToast(friendlyForecastError(error));
    el.updatedLabel.textContent = 'Forecast unavailable. Try again or choose a nearby ZIP code.';
  } finally {
    if (state.requestController === controller) {
      state.requestController = null;
      setLoading(false);
    }
  }
}

function friendlyForecastError(error) {
  if (!navigator.onLine) return 'You are offline. Forecast data will load after you reconnect.';
  if (error && error.status === 404) return 'NWS does not provide a forecast for this location.';
  if (error && error.status === 429) return 'NWS is busy. Please wait a moment and try again.';
  if (error && error.status >= 500) return 'NWS is temporarily unavailable. Please try again soon.';
  return (error && error.message) || 'NWS forecast data could not be loaded.';
}

function updateCurrent(period, generatedAt, observation, precipMm) {
  if (!period) return;
  const humidity = getQuantValue(period.relativeHumidity);
  const feels = calculateFeelsLike(period.temperature, humidity, period.windSpeed);

  el.currentTemp.textContent = Math.round(period.temperature);
  el.currentSummary.textContent = period.shortForecast || 'Forecast unavailable';
  el.feelsLike.textContent = Number.isFinite(feels)
    ? Math.round(feels) + 'Â°'
    : Math.round(period.temperature) + 'Â°';
  el.wind.textContent = compactWind(period.windSpeed, period.windDirection);
  el.humidity.textContent = Number.isFinite(humidity) ? Math.round(humidity) + '%' : '--';
  el.precipChance.textContent = formatPercent(getQuantValue(period.probabilityOfPrecipitation));
  el.dewPoint.textContent = formatTemperature(
    getQuantValue(period.dewpoint),
    period.dewpoint && period.dewpoint.unitCode
  );
  el.visibility.textContent = formatDistance(
    getQuantValue(observation && observation.visibility),
    observation && observation.visibility && observation.visibility.unitCode
  );
  el.precipTotal.textContent = formatPrecipTotal(precipMm);
  el.precipTotal.title = Number.isFinite(precipMm)
    ? 'Forecast liquid precipitation for the next 24 hours'
    : 'NWS quantitative precipitation data is unavailable';
  el.updatedLabel.textContent = generatedAt
    ? 'Updated ' + formatDateTime(generatedAt)
    : 'Updated by NWS';
}

async function loadLatestObservation(stationsUrl, signal) {
  if (!stationsUrl) return null;
  const stations = await fetchJson(stationsUrl, { signal: signal, retries: 1 });
  const first = stations && stations.features && stations.features[0];
  const stationId = first && first.properties && first.properties.stationIdentifier;
  if (!stationId) return null;
  return fetchJson('https://api.weather.gov/stations/' + stationId + '/observations/latest', {
    signal: signal,
    retries: 1
  });
}

function calculate24HourPrecip(gridProperties, startMs) {
  const values = gridProperties
    && gridProperties.quantitativePrecipitation
    && gridProperties.quantitativePrecipitation.values;
  if (!Array.isArray(values)) return NaN;

  const windowStart = Number.isFinite(startMs) ? startMs : Date.now();
  const windowEnd = windowStart + 24 * 60 * 60 * 1000;
  let totalMm = 0;
  let hasCoverage = false;

  for (const entry of values) {
    const interval = parseValidTime(entry && entry.validTime);
    const value = Number(entry && entry.value);
    if (!interval || !Number.isFinite(value)) continue;

    const overlap = Math.max(0, Math.min(interval.end, windowEnd) - Math.max(interval.start, windowStart));
    if (!overlap) continue;
    hasCoverage = true;
    totalMm += Math.max(0, value) * (overlap / (interval.end - interval.start));
  }

  return hasCoverage ? totalMm : NaN;
}

function parseValidTime(validTime) {
  if (typeof validTime !== 'string') return null;
  const parts = validTime.split('/');
  const start = Date.parse(parts[0]);
  const duration = parseIsoDuration(parts[1]);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return null;
  return { start: start, end: start + duration };
}

function parseIsoDuration(value) {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value || '');
  if (!match) return NaN;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function renderHourly(periods) {
  el.hourlyCount.textContent = periods.length + ' hours';
  el.hourlyForecast.replaceChildren();
  if (!periods.length) {
    el.hourlyForecast.innerHTML = '<div class="empty-state">No hourly forecast returned by NWS.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const period of periods) {
    const humidity = getQuantValue(period.relativeHumidity);
    const feels = calculateFeelsLike(period.temperature, humidity, period.windSpeed);
    const card = document.createElement('article');
    card.className = 'hour-card';
    card.innerHTML =
      '<div class="hour-time">' + formatHour(period.startTime) + '</div>' +
      '<img class="hour-icon" src="' + safeUrl(period.icon) + '" alt="">' +
      '<div class="hour-temp">' + Math.round(period.temperature) + 'Â°</div>' +
      '<div class="hour-feels">Feels ' +
      (Number.isFinite(feels) ? Math.round(feels) : Math.round(period.temperature)) +
      'Â°</div>';
    fragment.append(card);
  }
  el.hourlyForecast.append(fragment);
}

function renderAlerts(features) {
  const alerts = features
    .map(function (feature) { return feature.properties; })
    .filter(function (alert) { return /\b(watch|warning)\b/i.test((alert && alert.event) || ''); })
    .sort(function (a, b) {
      return new Date(a.ends || a.expires || 0) - new Date(b.ends || b.expires || 0);
    });

  el.alertsList.replaceChildren();
  el.alertsCount.textContent = alerts.length ? alerts.length + ' active' : 'None';
  el.alertsPanel.classList.remove('hidden');
  if (!alerts.length) {
    el.alertsList.innerHTML = '<div class="empty-state">No active watches or warnings for this location.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const alert of alerts.slice(0, 6)) {
    const card = document.createElement('article');
    card.className = 'alert-card ' + (alert.messageType === 'Alert' ? 'alert-card-hot' : '');
    card.innerHTML =
      '<div><div class="alert-title">' + escapeHtml(alert.event || 'Weather alert') + '</div>' +
      '<p class="alert-headline">' +
      escapeHtml(alert.headline || alert.areaDesc || 'NWS active alert') +
      '</p></div><div class="alert-meta"><span>' +
      escapeHtml(alert.severity || 'Alert') +
      '</span><span>' + formatAlertEnds(alert.ends || alert.expires) + '</span></div>';
    fragment.append(card);
  }
  el.alertsList.append(fragment);
}

function renderDaily(periods, hourlyPeriods) {
  el.dailyOffice.textContent = state.office ? state.office + ' office' : 'NWS';
  el.dailyForecast.replaceChildren();
  const days = mergeDailyPeriods(periods).slice(0, 7);
  const heatByDay = getHeatAlertsByDay(hourlyPeriods || []);
  if (!days.length) {
    el.dailyForecast.innerHTML = '<div class="empty-state">No 7 day forecast returned by NWS.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const day of days) {
    const heatAlert = heatByDay.get(day.dateKey);
    const card = document.createElement('article');
    card.className = 'day-card';
    card.innerHTML =
      '<img src="' + safeUrl(day.icon) + '" alt="">' +
      '<div><div class="day-name">' + escapeHtml(day.name) + '</div>' +
      (heatAlert ? '<div class="heat-banner">Feels like up to ' + Math.round(heatAlert) + 'Â°</div>' : '') +
      '<p class="day-summary">' + escapeHtml(day.summary) + '</p></div>' +
      '<div class="day-temp">' + formatHighLow(day) + '</div>';
    fragment.append(card);
  }
  el.dailyForecast.append(fragment);
}

function mergeDailyPeriods(periods) {
  const days = new Map();
  for (const period of periods) {
    const date = new Date(period.startTime);
    const key = date.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });
    const existing = days.get(key) || {
      name: key,
      dateKey: toDateKey(period.startTime),
      high: null,
      low: null,
      icon: period.icon,
      summary: period.detailedForecast || period.shortForecast || ''
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
    const feels = calculateFeelsLike(
      period.temperature,
      getQuantValue(period.relativeHumidity),
      period.windSpeed
    );
    if (!Number.isFinite(feels) || feels <= 90) continue;
    const key = toDateKey(period.startTime);
    heatByDay.set(key, Math.max(heatByDay.get(key) || -Infinity, feels));
  }
  return heatByDay;
}

function initMap(lat, lon, zoom) {
  if (typeof L === 'undefined') throw new Error('Leaflet failed to load.');
  state.map = L.map('radarMap', {
    zoomControl: false,
    tap: true,
    touchZoom: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: true,
    keyboard: true,
    minZoom: MAP_MIN_ZOOM,
    maxZoom: MAP_MAX_ZOOM,
    zoomSnap: 1,
    zoomDelta: 1,
    fadeAnimation: true,
    markerZoomAnimation: true,
    inertia: true,
    wheelDebounceTime: 40
  }).setView([lat, lon], zoom);

  state.streetLayer = L.tileLayer(
    'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    {
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      maxNativeZoom: 16,
      updateWhenIdle: true,
      keepBuffer: 3,
      attribution: 'USGS Topo'
    }
  ).addTo(state.map);

  state.streetLayer.on('tileerror', function () {
    const now = Date.now();
    if (now - state.lastBaseMapErrorAt > 15000) {
      state.lastBaseMapErrorAt = now;
      showToast('Some map tiles could not be loaded. Radar controls will keep working.');
    }
  });

  state.marker = L.circleMarker([lat, lon], {
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: '#22c55e',
    fillOpacity: 0.95
  }).addTo(state.map);

  state.map.on('zoomend', updateZoomControls);
  updateZoomControls();
}

async function loadRadar() {
  if (!state.map) return;
  if (!navigator.onLine) {
    setRadarError('Offline â€” radar unavailable', false);
    return;
  }

  const loadId = ++state.radarLoadId;
  if (state.radarController) state.radarController.abort();
  const controller = new AbortController();
  state.radarController = controller;
  const wasAnimating = isRadarAnimating();
  stopRadarAnimation();
  setRadarLoading();

  try {
    const data = await fetchJson(RADAR_API, {
      headers: {},
      signal: controller.signal,
      timeoutMs: 10000,
      retries: 2
    });
    if (loadId !== state.radarLoadId) return;

    const host = safeHttpsOrigin(data && data.host);
    const frames = getRadarFrames(data);
    if (!host) throw new Error('RainViewer returned an invalid tile host.');
    if (!frames.length) throw new Error('RainViewer returned no radar frames.');

    state.radarHost = host;
    state.radarFrames = frames;
    state.radarFrameIndex = frames.length - 1;
    state.radarHdFallbackUsed = false;
    resetRadarLayers();
    setRadarControls(true);
    setRadarStatus('ready', 'Radar ready');
    renderRadarFrame(state.radarFrameIndex);
    preloadRadarNeighbors();
    if (wasAnimating) startRadarAnimation();
  } catch (error) {
    if (isAbortError(error) || loadId !== state.radarLoadId) return;
    console.error(error);
    resetRadarLayers();
    state.radarHost = '';
    state.radarFrames = [];
    state.radarFrameIndex = 0;
    setRadarError(
      navigator.onLine ? 'Radar service unavailable' : 'Offline â€” radar unavailable',
      true
    );
    showToast('RainViewer radar is temporarily unavailable. Use Retry radar to try again.');
  } finally {
    if (state.radarController === controller) state.radarController = null;
  }
}

function getRadarFrames(data) {
  const past = data && data.radar && Array.isArray(data.radar.past) ? data.radar.past : [];
  const nowcast = data && data.radar && Array.isArray(data.radar.nowcast) ? data.radar.nowcast : [];
  return past.concat(nowcast)
    .filter(function (frame) {
      return frame && Number.isFinite(Number(frame.time)) && /^\/[A-Za-z0-9/_-]+$/.test(frame.path || '');
    })
    .slice(-RADAR_FRAME_LIMIT);
}

function safeHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

function renderRadarFrame(index) {
  const count = state.radarFrames.length;
  if (!count) return;
  state.radarFrameIndex = (index + count) % count;
  const next = ensureRadarLayer(state.radarFrameIndex);
  if (!next) return;

  for (const entry of state.radarLayers.values()) {
    entry.layer.setOpacity(entry.layer === next ? RADAR_OPACITY : 0);
  }
  state.radarLayer = next;
  bringRadarForward();
  updateRadarProgress();

  const frame = state.radarFrames[state.radarFrameIndex];
  el.radarTimestamp.textContent =
    'Radar ' + formatUnix(frame.time) + (state.radarHd ? ' HD' : ' SD');
  preloadRadarNeighbors();
  pruneRadarCache();
}

function ensureRadarLayer(index) {
  const frame = state.radarFrames[index];
  if (!frame || !state.radarHost || !state.map) return null;
  const key = (state.radarHd ? 'hd:' : 'sd:') + frame.path;
  const cached = state.radarLayers.get(key);
  if (cached) {
    cached.lastUsed = performance.now();
    return cached.layer;
  }

  const tileSize = state.radarHd ? 512 : 256;
  const layer = L.tileLayer(
    state.radarHost + frame.path + '/' + tileSize + '/{z}/{x}/{y}/2/1_1.png',
    {
      tileSize: tileSize,
      zoomOffset: tileSize === 512 ? -1 : 0,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      minNativeZoom: 0,
      maxNativeZoom: state.radarHd ? RADAR_NATIVE_ZOOM + 1 : RADAR_NATIVE_ZOOM,
      opacity: 0,
      updateWhenIdle: true,
      updateWhenZooming: false,
      updateInterval: 120,
      keepBuffer: 2,
      errorTileUrl: TRANSPARENT_TILE,
      className: 'rainviewer-tile',
      attribution: state.radarHd ? 'RainViewer HD' : 'RainViewer'
    }
  );

  const entry = { layer: layer, lastUsed: performance.now(), failures: 0, key: key };
  layer.on('tileload', function () {
    entry.failures = 0;
    if (layer === state.radarLayer) setRadarStatus('ready', 'Radar ready');
  });
  layer.on('tileerror', function () {
    handleRadarTileError(entry);
  });
  layer.addTo(state.map);
  layer.setOpacity(0);
  state.radarLayers.set(key, entry);
  return layer;
}

function handleRadarTileError(entry) {
  if (!entry || entry.layer !== state.radarLayer) return;
  entry.failures += 1;
  if (entry.failures < 4) {
    setRadarStatus('loading', 'Loading radar tiles');
    return;
  }

  if (state.radarHd && !state.radarHdFallbackUsed) {
    state.radarHdFallbackUsed = true;
    showToast('HD radar tiles failed, so the viewer switched to standard quality.');
    switchRadarQuality(false, false);
    return;
  }

  if (entry.failures >= 7) {
    stopRadarAnimation();
    setRadarError('Radar tiles unavailable', true);
  }
}

function preloadRadarNeighbors() {
  window.clearTimeout(state.radarPreloadTimer);
  if (state.radarFrames.length < 2) return;
  state.radarPreloadTimer = window.setTimeout(function () {
    state.radarPreloadTimer = 0;
    ensureRadarLayer((state.radarFrameIndex + 1) % state.radarFrames.length);
    ensureRadarLayer((state.radarFrameIndex - 1 + state.radarFrames.length) % state.radarFrames.length);
    pruneRadarCache();
    bringRadarForward();
  }, 80);
}

function pruneRadarCache() {
  if (state.radarLayers.size <= RADAR_CACHE_LIMIT) return;
  const removable = Array.from(state.radarLayers.values())
    .filter(function (entry) { return entry.layer !== state.radarLayer; })
    .sort(function (a, b) { return a.lastUsed - b.lastUsed; });

  while (state.radarLayers.size > RADAR_CACHE_LIMIT && removable.length) {
    const entry = removable.shift();
    if (state.map.hasLayer(entry.layer)) state.map.removeLayer(entry.layer);
    state.radarLayers.delete(entry.key);
  }
}

function resetRadarLayers() {
  window.clearTimeout(state.radarPreloadTimer);
  state.radarPreloadTimer = 0;
  for (const entry of state.radarLayers.values()) {
    if (state.map && state.map.hasLayer(entry.layer)) state.map.removeLayer(entry.layer);
  }
  state.radarLayers.clear();
  state.radarLayer = null;
}

function toggleRadarAnimation() {
  if (isRadarAnimating()) stopRadarAnimation();
  else startRadarAnimation();
}

function startRadarAnimation() {
  if (isRadarAnimating()) return;
  if (state.radarFrames.length < 2) {
    showToast('Radar animation is not available yet.');
    return;
  }
  el.radarPlayButton.textContent = 'Pause';
  el.radarPlayButton.classList.add('active');
  state.radarNextFrameAt = performance.now() + RADAR_FRAME_MS;
  state.radarAnimationFrame = window.requestAnimationFrame(runRadarAnimation);
}

function runRadarAnimation(now) {
  if (!isRadarAnimating()) return;
  if (now >= state.radarNextFrameAt) {
    const skipped = Math.floor((now - state.radarNextFrameAt) / RADAR_FRAME_MS);
    renderRadarFrame(state.radarFrameIndex + skipped + 1);
    state.radarNextFrameAt += (skipped + 1) * RADAR_FRAME_MS;
  }
  state.radarAnimationFrame = window.requestAnimationFrame(runRadarAnimation);
}

function stopRadarAnimation() {
  if (state.radarAnimationFrame) window.cancelAnimationFrame(state.radarAnimationFrame);
  state.radarAnimationFrame = 0;
  state.radarNextFrameAt = 0;
  el.radarPlayButton.textContent = 'Play';
  el.radarPlayButton.classList.remove('active');
}

function isRadarAnimating() {
  return Boolean(state.radarAnimationFrame);
}

function switchRadarQuality(useHd, notify) {
  if (!state.radarFrames.length || state.radarHd === useHd) return;
  const resume = isRadarAnimating();
  stopRadarAnimation();
  state.radarHd = useHd;
  el.radarHdButton.classList.toggle('active', useHd);
  el.radarHdButton.textContent = useHd ? 'HD' : 'SD';
  resetRadarLayers();
  renderRadarFrame(state.radarFrameIndex);
  if (resume) startRadarAnimation();
  if (notify !== false) showToast(useHd ? 'HD radar enabled.' : 'Standard radar enabled.');
}

function setRadarLoading() {
  el.radarTimestamp.textContent = 'Loading radar';
  setRadarStatus('loading', 'Connecting to RainViewer');
  el.radarRetryButton.classList.add('hidden');
  setRadarControls(false);
}

function setRadarError(message, canRetry) {
  stopRadarAnimation();
  el.radarTimestamp.textContent = message;
  setRadarStatus('error', message);
  el.radarRetryButton.classList.toggle('hidden', !canRetry);
  setRadarControls(false);
  updateRadarProgress();
}

function setRadarStatus(status, message) {
  el.radarStatus.dataset.state = status;
  el.radarStatus.textContent = message;
}

function setRadarControls(enabled) {
  el.radarPlayButton.disabled = !enabled;
  el.radarHdButton.disabled = !enabled;
}

function updateRadarProgress() {
  const count = state.radarFrames.length;
  const progress = count ? (state.radarFrameIndex + 1) / count : 0;
  el.radarProgress.style.transform = 'scaleX(' + progress + ')';
}

function updateZoomControls() {
  if (!state.map) return;
  const zoom = state.map.getZoom();
  el.zoomOutButton.disabled = zoom <= MAP_MIN_ZOOM;
  el.zoomInButton.disabled = zoom >= MAP_MAX_ZOOM;
  el.zoomLevel.value = zoom + ' / ' + MAP_MAX_ZOOM;
  el.zoomLevel.textContent = zoom + ' / ' + MAP_MAX_ZOOM;
  el.zoomLevel.setAttribute('aria-label', 'Map zoom ' + zoom + ' of ' + MAP_MAX_ZOOM);
}

function bringRadarForward() {
  if (state.radarLayer && state.map.hasLayer(state.radarLayer)) state.radarLayer.bringToFront();
  if (state.marker) state.marker.bringToFront();
}

function centerMap() {
  if (!state.map) return;
  const center = hasLocation() ? [state.lat, state.lon] : [39.8283, -98.5795];
  const zoom = hasLocation() ? Math.max(state.map.getZoom(), 8) : 4;
  state.map.setView(center, zoom, { animate: true });
}

function updateMapPosition(lat, lon) {
  if (!state.map || !state.marker) return;
  state.marker.setLatLng([lat, lon]);
  state.map.setView([lat, lon], 8, { animate: true });
  window.setTimeout(function () { state.map.invalidateSize(); }, 80);
}

function handleVisibilityChange() {
  if (document.hidden && isRadarAnimating()) {
    state.radarResumeOnVisible = true;
    stopRadarAnimation();
  } else if (!document.hidden && state.radarResumeOnVisible) {
    state.radarResumeOnVisible = false;
    startRadarAnimation();
  }
}

async function fetchJson(url, options) {
  const config = options || {};
  const headers = config.headers === undefined ? NWS_HEADERS : config.headers;
  const timeoutMs = config.timeoutMs || 12000;
  const retries = config.retries || 0;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = function () { controller.abort(); };
    if (config.signal) {
      if (config.signal.aborted) throw createAbortError();
      config.signal.addEventListener('abort', abortFromParent, { once: true });
    }
    const timeout = window.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, { headers: headers, signal: controller.signal });
      if (!response.ok) {
        const error = new Error('Request failed with status ' + response.status + '.');
        error.status = response.status;
        error.url = url;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (config.signal && config.signal.aborted) throw createAbortError();
      const retryable = timedOut
        || !error.status
        || error.status === 429
        || error.status >= 500;
      if (attempt < retries && retryable) {
        await wait(350 * Math.pow(2, attempt), config.signal);
        continue;
      }
      if (timedOut) throw new Error('The request timed out. Please try again.');
      throw error;
    } finally {
      window.clearTimeout(timeout);
      if (config.signal) config.signal.removeEventListener('abort', abortFromParent);
    }
  }
}

function wait(ms, signal) {
  return new Promise(function (resolve, reject) {
    if (signal && signal.aborted) {
      reject(createAbortError());
      return;
    }
    const finish = function () {
      if (signal) signal.removeEventListener('abort', abortWait);
      resolve();
    };
    const abortWait = function () {
      window.clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = window.setTimeout(finish, ms);
    if (signal) {
      signal.addEventListener('abort', abortWait, { once: true });
    }
  });
}

function createAbortError() {
  try {
    return new DOMException('Request aborted.', 'AbortError');
  } catch {
    const error = new Error('Request aborted.');
    error.name = 'AbortError';
    return error;
  }
}

function isAbortError(error) {
  return Boolean(error && error.name === 'AbortError');
}

function hasLocation() {
  return Number.isFinite(state.lat) && Number.isFinite(state.lon);
}

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function getQuantValue(value) {
  if (!value) return NaN;
  if (typeof value === 'number') return value;
  if (typeof value.value === 'number') return value.value;
  return NaN;
}

function formatPercent(value) {
  return Number.isFinite(value) ? Math.round(value) + '%' : '--';
}

function formatTemperature(value, unitCode) {
  if (!Number.isFinite(value)) return '--';
  const fahrenheit = (unitCode || '').endsWith('degC') ? value * 9 / 5 + 32 : value;
  return Math.round(fahrenheit) + 'Â°';
}

function formatDistance(value, unitCode) {
  if (!Number.isFinite(value)) return '--';
  const miles = (unitCode || '').endsWith('m') ? value / 1609.344 : value;
  return miles.toFixed(miles < 10 ? 1 : 0) + ' mi';
}

function formatPrecipTotal(mm) {
  if (!Number.isFinite(mm)) return '--';
  const inches = Math.max(0, mm) / 25.4;
  if (inches > 0 && inches < 0.01) return '<0.01 in';
  return inches.toFixed(2) + ' in';
}

function calculateFeelsLike(tempF, humidity, windSpeedText) {
  const windMph = parseWindMph(windSpeedText);
  if (tempF >= 80 && Number.isFinite(humidity) && humidity >= 40) {
    return heatIndex(tempF, humidity);
  }
  if (tempF <= 50 && windMph > 3) return windChill(tempF, windMph);
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
  return 35.74 + 0.6215 * tempF -
    35.75 * Math.pow(windMph, 0.16) +
    0.4275 * tempF * Math.pow(windMph, 0.16);
}

function parseWindMph(text) {
  const matches = String(text || '').match(/\d+/g);
  if (!matches) return 0;
  const values = matches.map(Number);
  return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
}

function compactWind(speed, direction) {
  if (!speed || speed.toLowerCase() === 'calm') return 'Calm';
  return direction ? direction + ' ' + speed : speed;
}

function formatHighLow(day) {
  const high = Number.isFinite(day.high) ? Math.round(day.high) + 'Â°' : '--';
  const low = Number.isFinite(day.low) ? Math.round(day.low) + 'Â°' : '--';
  return high + ' / ' + low;
}

function formatRelativeLocation(location) {
  const props = location && location.properties;
  if (!props || !props.city || !props.state) return state.lat + ', ' + state.lon;
  return props.city + ', ' + props.state;
}

function updateLocationLabels(updated) {
  el.locationLabel.textContent = state.city || state.lat + ', ' + state.lon;
  if (updated) el.updatedLabel.textContent = 'Updated ' + formatDateTime(updated);
}

function toDateKey(value) {
  const date = new Date(value);
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function formatAlertEnds(value) {
  if (!value) return 'Until further notice';
  return 'Until ' + new Date(value).toLocaleTimeString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatDateTime(value) {
  return new Date(value).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatHour(value) {
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric' });
}

function formatUnix(value) {
  return new Date(Number(value) * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, function (char) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char];
  });
}

function setLoading(isLoading) {
  el.refreshButton.disabled = isLoading;
  el.refreshButton.style.opacity = isLoading ? '0.55' : '1';
}

let toastTimer = 0;
function showToast(message) {
  window.clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('show');
  toastTimer = window.setTimeout(function () {
    el.toast.classList.remove('show');
  }, 5200);
}
