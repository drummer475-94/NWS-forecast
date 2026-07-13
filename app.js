const NWS_HEADERS = { Accept: 'application/geo+json' };
const MAP_MIN_ZOOM = 2;
const BASEMAP_MAX_ZOOM = 16;
const RADAR_API = 'https://api.rainviewer.com/public/weather-maps.json';
const NWS_RADAR_BASE = 'https://opengeo.ncep.noaa.gov/geoserver/';
const RAINVIEWER_PROVIDER_MAX_ZOOM = 7;
const RAINVIEWER_TILE_SIZE = 512;
const RAINVIEWER_ZOOM_OFFSET = -1;
const RAINVIEWER_MAP_MAX_ZOOM = RAINVIEWER_PROVIDER_MAX_ZOOM - RAINVIEWER_ZOOM_OFFSET;
const NWS_RADAR_MAX_ZOOM = 11;
const RADAR_FRAME_LIMIT = 12;
const RADAR_FRAME_MS = 650;
const RADAR_OPACITY = 0.76;
const RADAR_CACHE_LIMIT = 4;
const RADAR_CHOICE_LIMIT = 6;
const RADAR_CHOICE_RADIUS_MILES = 250;
const RADAR_CHOICE_MINIMUM = 4;
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
  radarSource: 'rainviewer',
  radarStation: '',
  autoRadarStation: '',
  radarSelectionMode: 'auto',
  radarCatalog: [],
  radarChoices: [],
  radarStationMarkers: new Map(),
  radarChoicesController: null,
  radarChoicesLoadId: 0,
  radarHost: '',
  radarWmsUrl: '',
  radarLayerName: '',
  radarFrames: [],
  radarFrameIndex: 0,
  radarFallbackUsed: false,
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
  radarRetryButton: document.querySelector('#radarRetryButton'),
  radarPicker: document.querySelector('#radarPicker'),
  radarAutoButton: document.querySelector('#radarAutoButton'),
  radarChoiceStatus: document.querySelector('#radarChoiceStatus'),
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
el.radarRetryButton.addEventListener('click', function () { loadRadar(); });
el.radarAutoButton.addEventListener('click', useAutoRadarStation);
el.zoomOutButton.addEventListener('click', function () {
  if (state.map) state.map.zoomOut(1);
});
el.zoomInButton.addEventListener('click', function () {
  if (state.map) state.map.zoomIn(1);
});
el.centerMapButton.addEventListener('click', centerMap);

window.addEventListener('offline', function () {
  setRadarError('Offline - radar paused', false);
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

  const previousLocationKey = getLocationKey(state.lat, state.lon);
  if (state.requestController) state.requestController.abort();
  const controller = new AbortController();
  state.requestController = controller;
  const signal = controller.signal;
  setLoading(true);
  state.lat = roundCoord(Number(lat));
  state.lon = roundCoord(Number(lon));
  const isSameLocation = previousLocationKey === getLocationKey(state.lat, state.lon);
  if (!isSameLocation) {
    state.radarChoices = [];
    clearRadarStationMarkers();
    el.radarPicker.classList.add('hidden');
  }

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
    const previousRadarStation = state.radarStation;
    state.autoRadarStation = normalizeRadarStation(props.radarStation);
    const keepManualSelection = isSameLocation
      && state.radarSelectionMode === 'manual'
      && normalizeRadarStation(state.radarStation);
    if (!keepManualSelection) {
      state.radarSelectionMode = 'auto';
      state.radarStation = state.autoRadarStation;
    }
    if (state.radarStation !== previousRadarStation || state.radarSource !== 'nws') {
      loadRadar(state.radarStation ? 'nws' : 'rainviewer');
    }

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
    loadNearbyRadarChoices(!isSameLocation);
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
    ? Math.round(feels) + '\u00B0'
    : Math.round(period.temperature) + '\u00B0';
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
      '<div class="hour-temp">' + Math.round(period.temperature) + '\u00B0</div>' +
      '<div class="hour-feels">Feels ' +
      (Number.isFinite(feels) ? Math.round(feels) : Math.round(period.temperature)) +
      '\u00B0</div>';
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
      (heatAlert ? '<div class="heat-banner">Feels like up to ' + Math.round(heatAlert) + '\u00B0</div>' : '') +
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
    maxZoom: RAINVIEWER_MAP_MAX_ZOOM,
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
      maxZoom: BASEMAP_MAX_ZOOM,
      maxNativeZoom: BASEMAP_MAX_ZOOM,
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

async function loadNearbyRadarChoices(fitMap) {
  if (!hasLocation() || !state.map) return;
  const loadId = ++state.radarChoicesLoadId;
  if (state.radarChoicesController) state.radarChoicesController.abort();
  const controller = new AbortController();
  state.radarChoicesController = controller;
  setRadarPickerLoading();

  try {
    if (!state.radarCatalog.length) {
      const data = await fetchJson('https://api.weather.gov/radar/stations', {
        signal: controller.signal,
        retries: 1
      });
      state.radarCatalog = parseRadarCatalog(data);
    }
    if (loadId !== state.radarChoicesLoadId) return;
    state.radarChoices = findNearbyRadars(state.radarCatalog, state.lat, state.lon);
    renderRadarStationMarkers();
    updateRadarChoiceUi();
    if (fitMap) fitMapToRadarChoices();
  } catch (error) {
    if (isAbortError(error) || loadId !== state.radarChoicesLoadId) return;
    console.warn('Nearby NWS radar choices are unavailable.', error);
    state.radarChoices = [];
    clearRadarStationMarkers();
    el.radarPicker.classList.remove('hidden');
    el.radarChoiceStatus.textContent = 'Nearby radar choices are unavailable; auto-detect is still active.';
    el.radarAutoButton.disabled = state.radarSelectionMode === 'auto' || !state.autoRadarStation;
  } finally {
    if (state.radarChoicesController === controller) state.radarChoicesController = null;
  }
}

function parseRadarCatalog(data) {
  const features = data && Array.isArray(data.features) ? data.features : [];
  return features.map(function (feature) {
    const properties = feature && feature.properties;
    const coordinates = feature && feature.geometry && feature.geometry.coordinates;
    const id = normalizeRadarStation(properties && properties.id);
    const lon = Number(coordinates && coordinates[0]);
    const lat = Number(coordinates && coordinates[1]);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (properties && properties.stationType && properties.stationType !== 'WSR-88D') return null;
    return {
      id: id,
      name: String(properties && properties.name || id),
      lat: lat,
      lon: lon
    };
  }).filter(Boolean);
}

function findNearbyRadars(catalog, lat, lon) {
  const ranked = catalog.map(function (station) {
    return Object.assign({}, station, {
      distanceMiles: distanceMiles(lat, lon, station.lat, station.lon)
    });
  }).sort(function (a, b) { return a.distanceMiles - b.distanceMiles; });

  const nearby = ranked.filter(function (station) {
    return station.distanceMiles <= RADAR_CHOICE_RADIUS_MILES;
  }).slice(0, RADAR_CHOICE_LIMIT);
  const choices = nearby.length >= RADAR_CHOICE_MINIMUM
    ? nearby
    : ranked.slice(0, RADAR_CHOICE_MINIMUM);
  const autoStation = ranked.find(function (station) {
    return station.id === state.autoRadarStation;
  });
  if (autoStation && !choices.some(function (station) { return station.id === autoStation.id; })) {
    choices.push(autoStation);
  }
  return choices.sort(function (a, b) { return a.distanceMiles - b.distanceMiles; });
}

function renderRadarStationMarkers() {
  clearRadarStationMarkers();
  for (const station of state.radarChoices) {
    const marker = L.circleMarker([station.lat, station.lon], getRadarStationStyle(station.id))
      .addTo(state.map);
    const tooltip = document.createElement('span');
    tooltip.textContent = getRadarStationLabel(station);
    marker.bindTooltip(tooltip, {
      className: 'radar-site-tooltip',
      direction: 'top',
      offset: [0, -8]
    });
    marker.on('click', function () { selectRadarStation(station.id); });
    const node = marker.getElement();
    if (node) {
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', getRadarStationLabel(station));
      node.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectRadarStation(station.id);
      });
    }
    state.radarStationMarkers.set(station.id, marker);
  }
  if (state.marker) state.marker.bringToFront();
}

function clearRadarStationMarkers() {
  for (const marker of state.radarStationMarkers.values()) {
    if (state.map && state.map.hasLayer(marker)) state.map.removeLayer(marker);
  }
  state.radarStationMarkers.clear();
}

function selectRadarStation(stationId) {
  const station = state.radarChoices.find(function (choice) { return choice.id === stationId; });
  if (!station) return;
  const changed = state.radarStation !== station.id || state.radarSelectionMode !== 'manual';
  state.radarSelectionMode = 'manual';
  state.radarStation = station.id;
  updateRadarChoiceUi();
  if (changed || state.radarSource !== 'nws') loadRadar('nws');
  showToast('Using NWS ' + station.id + '. Try nearby radar dots to compare coverage.');
}

function useAutoRadarStation() {
  if (!state.autoRadarStation) return;
  const changed = state.radarStation !== state.autoRadarStation || state.radarSelectionMode !== 'auto';
  state.radarSelectionMode = 'auto';
  state.radarStation = state.autoRadarStation;
  updateRadarChoiceUi();
  if (changed || state.radarSource !== 'nws') loadRadar('nws');
  showToast('Radar auto-detect restored to NWS ' + state.autoRadarStation + '.');
}

function updateRadarChoiceUi() {
  el.radarPicker.classList.remove('hidden');
  el.radarAutoButton.disabled = state.radarSelectionMode === 'auto' || !state.autoRadarStation;
  const selected = state.radarChoices.find(function (station) {
    return station.id === state.radarStation;
  });
  const selectionLabel = state.radarSelectionMode === 'manual' ? 'Manual selection' : 'Auto-detect';
  el.radarChoiceStatus.textContent = selected
    ? selectionLabel + ': ' + selected.id + ' — ' + selected.name + ', ' +
      Math.round(selected.distanceMiles) + ' mi away. ' + state.radarChoices.length + ' nearby sites shown.'
    : selectionLabel + ': ' + (state.radarStation || 'unavailable') + '. ' +
      state.radarChoices.length + ' nearby sites shown.';

  for (const entry of state.radarStationMarkers.entries()) {
    const stationId = entry[0];
    const marker = entry[1];
    const style = getRadarStationStyle(stationId);
    marker.setStyle(style);
    marker.setRadius(style.radius);
    if (stationId === state.radarStation) marker.bringToFront();
    const station = state.radarChoices.find(function (choice) { return choice.id === stationId; });
    const node = marker.getElement();
    if (node && station) node.setAttribute('aria-label', getRadarStationLabel(station));
  }
  if (state.marker) state.marker.bringToFront();
}

function setRadarPickerLoading() {
  el.radarPicker.classList.remove('hidden');
  el.radarChoiceStatus.textContent = 'Finding nearby NWS radars for this location…';
  el.radarAutoButton.disabled = true;
}

function getRadarStationStyle(stationId) {
  if (stationId === state.radarStation) {
    return {
      radius: 9,
      color: '#ffffff',
      weight: 3,
      fillColor: '#38bdf8',
      fillOpacity: 1,
      className: 'radar-site-dot'
    };
  }
  if (stationId === state.autoRadarStation) {
    return {
      radius: 7,
      color: '#fde68a',
      weight: 3,
      fillColor: '#f59e0b',
      fillOpacity: 0.95,
      className: 'radar-site-dot'
    };
  }
  return {
    radius: 6,
    color: '#ffffff',
    weight: 2,
    fillColor: '#8bddff',
    fillOpacity: 0.92,
    className: 'radar-site-dot'
  };
}

function getRadarStationLabel(station) {
  let suffix = '';
  if (station.id === state.radarStation) suffix = ', selected';
  else if (station.id === state.autoRadarStation) suffix = ', auto-detect choice';
  return 'NWS ' + station.id + ', ' + station.name + ', ' +
    Math.round(station.distanceMiles) + ' miles away' + suffix;
}

function fitMapToRadarChoices() {
  if (!state.map || !state.radarChoices.length || !hasLocation()) return;
  const points = [[state.lat, state.lon]].concat(state.radarChoices.map(function (station) {
    return [station.lat, station.lon];
  }));
  state.map.fitBounds(L.latLngBounds(points), {
    padding: [28, 28],
    maxZoom: 7,
    animate: false
  });
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const toRadians = function (value) { return value * Math.PI / 180; };
  const latDelta = toRadians(lat2 - lat1);
  const lonDelta = toRadians(lon2 - lon1);
  const a = Math.sin(latDelta / 2) * Math.sin(latDelta / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(lonDelta / 2) * Math.sin(lonDelta / 2);
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function loadRadar(preferredSource) {
  if (!state.map) return;
  if (!navigator.onLine) {
    setRadarError('Offline - radar unavailable', false);
    return;
  }

  const loadId = ++state.radarLoadId;
  if (state.radarController) state.radarController.abort();
  const controller = new AbortController();
  state.radarController = controller;
  const requestedSource = preferredSource === 'rainviewer'
    ? 'rainviewer'
    : (state.radarStation ? 'nws' : 'rainviewer');
  const wasAnimating = isRadarAnimating();
  stopRadarAnimation();
  setRadarLoading(requestedSource);

  try {
    let radarData;
    let usedFallback = false;
    if (requestedSource === 'nws') {
      try {
        radarData = await loadNwsRadarData(state.radarStation, controller.signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn('NWS super-resolution radar unavailable; using RainViewer HD.', error);
        radarData = await loadRainViewerRadarData(controller.signal);
        usedFallback = true;
      }
    } else {
      radarData = await loadRainViewerRadarData(controller.signal);
    }
    if (loadId !== state.radarLoadId) return;

    state.radarSource = radarData.source;
    state.radarHost = radarData.host || '';
    state.radarWmsUrl = radarData.wmsUrl || '';
    state.radarLayerName = radarData.layerName || '';
    state.radarFrames = radarData.frames;
    state.radarFrameIndex = radarData.frames.length - 1;
    state.radarFallbackUsed = usedFallback;
    resetRadarLayers();
    setRadarZoomLimit(radarData.maxZoom);
    setRadarControls(true);
    setRadarStatus('ready', radarData.status);
    renderRadarFrame(state.radarFrameIndex);
    preloadRadarNeighbors();
    if (wasAnimating) startRadarAnimation();
    if (usedFallback) {
      showToast('NWS super-resolution radar is unavailable, so HD RainViewer is being used.');
    }
  } catch (error) {
    if (isAbortError(error) || loadId !== state.radarLoadId) return;
    console.error(error);
    resetRadarLayers();
    state.radarHost = '';
    state.radarWmsUrl = '';
    state.radarLayerName = '';
    state.radarFrames = [];
    state.radarFrameIndex = 0;
    setRadarError(
      navigator.onLine ? 'Radar service unavailable' : 'Offline - radar unavailable',
      true
    );
    showToast('Radar services are temporarily unavailable. Use Retry radar to try again.');
  } finally {
    if (state.radarController === controller) state.radarController = null;
  }
}

async function loadRainViewerRadarData(signal) {
  const data = await fetchJson(RADAR_API, {
    headers: {},
    signal: signal,
    timeoutMs: 10000,
    retries: 2
  });
  const host = safeHttpsOrigin(data && data.host);
  const frames = getRadarFrames(data);
  if (!host) throw new Error('RainViewer returned an invalid tile host.');
  if (!frames.length) throw new Error('RainViewer returned no radar frames.');
  return {
    source: 'rainviewer',
    host: host,
    frames: frames,
    maxZoom: RAINVIEWER_MAP_MAX_ZOOM,
    status: 'RainViewer HD ready'
  };
}

async function loadNwsRadarData(station, signal) {
  const stationId = normalizeRadarStation(station);
  if (!stationId) throw new Error('NWS returned no supported radar station.');
  const stationSlug = stationId.toLowerCase();
  const layerName = stationSlug + '_sr_bref';
  const capabilitiesUrl = NWS_RADAR_BASE + stationSlug +
    '/ows?service=WMS&version=1.3.0&request=GetCapabilities';
  const xmlText = await fetchText(capabilitiesUrl, {
    headers: {},
    signal: signal,
    timeoutMs: 10000,
    retries: 1
  });
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('NWS returned invalid radar metadata.');

  const layer = Array.from(xml.getElementsByTagNameNS('*', 'Layer')).find(function (candidate) {
    return getDirectChildText(candidate, 'Name') === layerName;
  });
  if (!layer) throw new Error('NWS super-resolution radar is unavailable for ' + stationId + '.');
  const dimension = Array.from(layer.children).find(function (child) {
    return child.localName === 'Dimension' && child.getAttribute('name') === 'time';
  });
  const frames = String(dimension && dimension.textContent || '')
    .split(',')
    .map(function (value) {
      const timeMs = Date.parse(value.trim());
      return Number.isFinite(timeMs)
        ? { time: Math.floor(timeMs / 1000), iso: new Date(timeMs).toISOString() }
        : null;
    })
    .filter(Boolean)
    .slice(-RADAR_FRAME_LIMIT);
  if (!frames.length) throw new Error('NWS returned no super-resolution radar frames.');

  return {
    source: 'nws',
    wmsUrl: NWS_RADAR_BASE + stationSlug + '/wms',
    layerName: layerName,
    frames: frames,
    maxZoom: NWS_RADAR_MAX_ZOOM,
    status: 'NWS ' + stationId + ' super-res ready'
  };
}

function getRadarFrames(data) {
  const past = data && data.radar && Array.isArray(data.radar.past) ? data.radar.past : [];
  return past
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
  el.radarTimestamp.textContent = state.radarSource === 'nws'
    ? 'Radar ' + formatUnix(frame.time) + ' NWS ' + state.radarStation + ' super-res'
    : 'Radar ' + formatUnix(frame.time) + ' HD';
  preloadRadarNeighbors();
  pruneRadarCache();
}

function ensureRadarLayer(index) {
  const frame = state.radarFrames[index];
  if (!frame || !state.map) return null;
  if (state.radarSource === 'nws' && (!state.radarWmsUrl || !state.radarLayerName)) return null;
  if (state.radarSource === 'rainviewer' && !state.radarHost) return null;
  const key = state.radarSource + ':' + (frame.iso || frame.path);
  const cached = state.radarLayers.get(key);
  if (cached) {
    cached.lastUsed = performance.now();
    return cached.layer;
  }

  const layer = state.radarSource === 'nws'
    ? L.tileLayer.wms(state.radarWmsUrl, {
      layers: state.radarLayerName,
      styles: 'radar_reflectivity',
      format: 'image/png',
      transparent: true,
      version: '1.1.1',
      time: frame.iso,
      tileSize: 512,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: NWS_RADAR_MAX_ZOOM,
      opacity: 0,
      updateWhenIdle: true,
      updateWhenZooming: false,
      updateInterval: 120,
      keepBuffer: 2,
      errorTileUrl: TRANSPARENT_TILE,
      className: 'rainviewer-tile',
      attribution: 'NOAA/NWS NEXRAD ' + state.radarStation
    })
    : L.tileLayer(
      state.radarHost + frame.path + '/' + RAINVIEWER_TILE_SIZE +
        '/{z}/{x}/{y}/2/1_1.png',
      {
        tileSize: RAINVIEWER_TILE_SIZE,
        zoomOffset: RAINVIEWER_ZOOM_OFFSET,
        minZoom: MAP_MIN_ZOOM,
        maxZoom: RAINVIEWER_MAP_MAX_ZOOM,
        minNativeZoom: MAP_MIN_ZOOM,
        maxNativeZoom: RAINVIEWER_MAP_MAX_ZOOM,
        opacity: 0,
        updateWhenIdle: true,
        updateWhenZooming: false,
        updateInterval: 120,
        keepBuffer: 2,
        errorTileUrl: TRANSPARENT_TILE,
        className: 'rainviewer-tile',
        attribution: 'RainViewer HD'
      }
    );

  const entry = { layer: layer, lastUsed: performance.now(), failures: 0, key: key };
  layer.on('tileload', function () {
    entry.failures = 0;
    if (layer === state.radarLayer) setRadarStatus('ready', getRadarReadyStatus());
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

  if (state.radarSource === 'nws' && !state.radarFallbackUsed) {
    state.radarFallbackUsed = true;
    showToast('NWS super-resolution tiles failed, so HD RainViewer is being used.');
    loadRadar('rainviewer');
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

function setRadarLoading(source) {
  el.radarTimestamp.textContent = 'Loading radar';
  setRadarStatus('loading', source === 'nws'
    ? 'Connecting to NWS super-res radar'
    : 'Connecting to RainViewer HD');
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

function getRadarReadyStatus() {
  return state.radarSource === 'nws'
    ? 'NWS ' + state.radarStation + ' super-res ready'
    : 'RainViewer HD ready';
}

function setRadarControls(enabled) {
  el.radarPlayButton.disabled = !enabled;
}

function updateRadarProgress() {
  const count = state.radarFrames.length;
  const progress = count ? (state.radarFrameIndex + 1) / count : 0;
  el.radarProgress.style.transform = 'scaleX(' + progress + ')';
}

function updateZoomControls() {
  if (!state.map) return;
  const zoom = state.map.getZoom();
  const maxZoom = state.map.getMaxZoom();
  el.zoomOutButton.disabled = zoom <= MAP_MIN_ZOOM;
  el.zoomInButton.disabled = zoom >= maxZoom;
  el.zoomLevel.value = zoom + ' / ' + maxZoom;
  el.zoomLevel.textContent = zoom + ' / ' + maxZoom;
  el.zoomLevel.setAttribute('aria-label', 'Map zoom ' + zoom + ' of ' + maxZoom);
}

function setRadarZoomLimit(maxZoom) {
  if (!state.map) return;
  state.map.setMaxZoom(maxZoom);
  if (state.map.getZoom() > maxZoom) state.map.setZoom(maxZoom, { animate: false });
  updateZoomControls();
}

function bringRadarForward() {
  if (state.radarLayer && state.map.hasLayer(state.radarLayer)) state.radarLayer.bringToFront();
  if (state.marker) state.marker.bringToFront();
}

function centerMap() {
  if (!state.map) return;
  const center = hasLocation() ? [state.lat, state.lon] : [39.8283, -98.5795];
  const zoom = hasLocation()
    ? Math.min(Math.max(state.map.getZoom(), 8), state.map.getMaxZoom())
    : 4;
  state.map.setView(center, zoom, { animate: true });
}

function updateMapPosition(lat, lon) {
  if (!state.map || !state.marker) return;
  state.marker.setLatLng([lat, lon]);
  state.map.setView([lat, lon], Math.min(8, state.map.getMaxZoom()), { animate: true });
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

function normalizeRadarStation(value) {
  const station = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{3}$/.test(station) ? station : '';
}

function getDirectChildText(element, localName) {
  const child = Array.from(element.children).find(function (candidate) {
    return candidate.localName === localName;
  });
  return String(child && child.textContent || '').trim();
}

async function fetchJson(url, options) {
  return fetchResource(url, options, 'json');
}

async function fetchText(url, options) {
  return fetchResource(url, options, 'text');
}

async function fetchResource(url, options, responseType) {
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
      return responseType === 'text' ? await response.text() : await response.json();
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

function getLocationKey(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    ? roundCoord(lat) + ',' + roundCoord(lon)
    : '';
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
  return Math.round(fahrenheit) + '\u00B0';
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
  const high = Number.isFinite(day.high) ? Math.round(day.high) + '\u00B0' : '--';
  const low = Number.isFinite(day.low) ? Math.round(day.low) + '\u00B0' : '--';
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
