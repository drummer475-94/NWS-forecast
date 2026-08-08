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

// Tick text for the radar intensity legend. NWS super-resolution base reflectivity
// stops are read directly off that layer's WMS GetLegendGraphic (verified against
// https://opengeo.ncep.noaa.gov/geoserver/<station>/ows?service=WMS&request=GetLegendGraphic
// &format=image/png&layer=<station>_sr_bref&style=radar_reflectivity), so dBZ numbers
// are safe to print. RainViewer's HD fallback tiles (color scheme "2" in the tile URL)
// have no published numeric dBZ scale, so that legend stays qualitative on purpose.
const RADAR_LEGEND_CONTENT = {
  nws: {
    caption: 'NWS base reflectivity (dBZ)',
    ticks: ['-20', '0', '20', '40', '60+'],
    // The tick marks alone read as bare numbers to a screen reader, so state what
    // the scale means and which direction is heavier.
    description: 'Color scale from -20 to over 60 dBZ. Higher values mean heavier precipitation: ' +
      'around 20 dBZ is light rain, 40 is moderate to heavy rain, and 60 or more indicates ' +
      'intense storms or hail.'
  },
  rainviewer: {
    caption: 'RainViewer HD intensity (qualitative)',
    ticks: ['Light', 'Moderate', 'Heavy', 'Extreme'],
    description: 'Color scale running from light through moderate and heavy to extreme ' +
      'precipitation. RainViewer does not publish numeric dBZ thresholds for this palette, ' +
      'so the scale is relative rather than measured.'
  }
};

const state = {
  lat: null,
  lon: null,
  city: '',
  office: '',
  forecastUrl: '',
  hourlyUrl: '',
  gridDataUrl: '',
  requestController: null,
  zipController: null,
  zipLoadId: 0,
  manualLocationRequested: false,
  timeZone: '',
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
  lastBaseMapErrorAt: 0,
  hourlyPeriods: []
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
  sunTimes: document.querySelector('#sunTimes'),
  hourlyTrend: document.querySelector('#hourlyTrend'),
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
  radarLegend: document.querySelector('#radarLegend'),
  radarLegendCaption: document.querySelector('#radarLegendCaption'),
  radarLegendTicks: document.querySelector('#radarLegendTicks'),
  radarLegendDescription: document.querySelector('#radarLegendDescription'),
  radarPicker: document.querySelector('#radarPicker'),
  radarAutoButton: document.querySelector('#radarAutoButton'),
  radarChoiceStatus: document.querySelector('#radarChoiceStatus'),
  zoomOutButton: document.querySelector('#zoomOutButton'),
  zoomInButton: document.querySelector('#zoomInButton'),
  zoomLevel: document.querySelector('#zoomLevel'),
  centerMapButton: document.querySelector('#centerMapButton'),
  themeToggleButton: document.querySelector('#themeToggleButton'),
  toast: document.querySelector('#toast')
};

document.addEventListener('DOMContentLoaded', init);
el.refreshButton.addEventListener('click', refreshAll);
el.themeToggleButton.addEventListener('click', toggleTheme);
el.zipLocationForm.addEventListener('submit', handleZipLocation);
el.locationLabel.addEventListener('click', toggleLocationDisclosure);
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
  if (state.radarController) state.radarController.abort();
  setRadarError('Offline - radar paused', false);
});
window.addEventListener('online', function () {
  loadRadar();
  if (hasLocation()) loadForecast(state.lat, state.lon);
});
document.addEventListener('visibilitychange', handleVisibilityChange);

const THEME_STORAGE_KEY = 'theme';

function getStoredTheme() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch (error) {
    return null;
  }
}

function getSystemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function getActiveTheme() {
  return document.documentElement.getAttribute('data-theme') || getStoredTheme() || getSystemTheme();
}

function syncThemeButton(theme) {
  const isLight = theme === 'light';
  el.themeToggleButton.setAttribute('aria-pressed', String(isLight));
  el.themeToggleButton.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
  const icon = el.themeToggleButton.querySelector('.theme-icon');
  if (icon) icon.textContent = isLight ? '☾' : '☀';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  syncThemeButton(theme);
}

// Only pin data-theme when the user has actually chosen one. Left unpinned, the
// prefers-color-scheme rules stay live, so the page still follows the OS if it
// flips while the tab is open.
function initTheme() {
  const stored = getStoredTheme();
  if (stored) {
    applyTheme(stored);
    return;
  }

  document.documentElement.removeAttribute('data-theme');
  syncThemeButton(getSystemTheme());

  if (!window.matchMedia) return;
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const onSystemThemeChange = function () {
    if (!getStoredTheme()) syncThemeButton(getSystemTheme());
  };
  if (query.addEventListener) query.addEventListener('change', onSystemThemeChange);
  else if (query.addListener) query.addListener(onSystemThemeChange);
}

function toggleTheme() {
  const next = getActiveTheme() === 'light' ? 'dark' : 'light';
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (error) {
    // Storage may be unavailable (private browsing, quota); theme still applies for this session.
  }
  applyTheme(next);
}

function init() {
  initTheme();
  observeHourlyTrendWidth();

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
      if (!state.manualLocationRequested) {
        loadForecast(position.coords.latitude, position.coords.longitude);
      }
    },
    function () {
      if (!state.manualLocationRequested && !hasLocation()) setManualLocationMessage();
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 10 * 60 * 1000 }
  );
}

function setLocationDisclosure(expanded) {
  el.locationLabel.setAttribute('aria-expanded', String(expanded));
  el.zipLocationForm.classList.toggle('hidden', !expanded);
}

function toggleLocationDisclosure() {
  setLocationDisclosure(el.locationLabel.getAttribute('aria-expanded') !== 'true');
}

function setManualLocationMessage() {
  showToast('Location permission was not granted. Enter a ZIP code instead.');
  el.locationLabel.textContent = 'Manual location needed';
  el.updatedLabel.textContent = 'Use a US ZIP code to load your local forecast.';
  setLocationDisclosure(true);
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

  state.manualLocationRequested = true;
  const loadId = ++state.zipLoadId;
  if (state.zipController) state.zipController.abort();
  if (state.requestController) state.requestController.abort();
  const controller = new AbortController();
  state.zipController = controller;
  setLoading(true);
  try {
    const data = await fetchJson('https://api.zippopotam.us/us/' + zip, {
      headers: {},
      signal: controller.signal,
      retries: 1
    });
    if (loadId !== state.zipLoadId) return;
    const place = data.places && data.places[0];
    const lat = Number.parseFloat(place && place.latitude);
    const lon = Number.parseFloat(place && place.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error('ZIP lookup returned no usable coordinates.');
    }

    state.city = place['place name'] + ', ' + place['state abbreviation'];
    await loadForecast(lat, lon);
  } catch (error) {
    if (isAbortError(error) || loadId !== state.zipLoadId) return;
    if (error.status !== 404) console.error(error);
    showToast(error.status === 404
      ? 'ZIP code ' + zip + ' could not be found.'
      : 'ZIP lookup is unavailable. Check your connection and try again.');
    setLocationDisclosure(true);
  } finally {
    if (state.zipController === controller) state.zipController = null;
    if (loadId === state.zipLoadId) setLoading(false);
  }
}

async function loadForecast(lat, lon) {
  if (!isValidCoordinates(lat, lon)) {
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
    state.timeZone = normalizeTimeZone(props.timeZone);
    state.city = formatRelativeLocation(props.relativeLocation);
    renderSunTimes(state.lat, state.lon);
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

    if (signal.aborted) throw createAbortError();
    const daily = requests[0].status === 'fulfilled' ? requests[0].value : null;
    const hourly = requests[1].status === 'fulfilled' ? requests[1].value : null;
    const alerts = requests[2].status === 'fulfilled' ? requests[2].value : null;
    const observation = requests[3].status === 'fulfilled' ? requests[3].value : null;
    const gridData = requests[4].status === 'fulfilled' ? requests[4].value : null;
    const dailyPeriods = daily && daily.properties && Array.isArray(daily.properties.periods)
      ? daily.properties.periods
      : [];
    const hourlyPeriods = hourly && hourly.properties && Array.isArray(hourly.properties.periods)
      ? hourly.properties.periods
      : [];
    const alertFeatures = alerts && Array.isArray(alerts.features) ? alerts.features : null;

    renderAlerts(alertFeatures);
    if (!dailyPeriods.length && !hourlyPeriods.length) {
      setCurrentUnavailable(null, NaN);
      renderHourly([]);
      renderDaily([], []);
      updateLocationLabels();
      updateMapPosition(state.lat, state.lon);
      loadNearbyRadarChoices(!isSameLocation);
      throw requests[0].status === 'rejected'
        ? requests[0].reason
        : (requests[1].status === 'rejected'
            ? requests[1].reason
            : new Error('NWS returned an incomplete forecast.'));
    }

    const precipMm = calculate24HourPrecip(gridData && gridData.properties);
    if (hourlyPeriods.length) {
      updateCurrent(
        hourlyPeriods[0],
        hourly.properties.generatedAt,
        observation && observation.properties,
        precipMm
      );
    } else {
      setCurrentUnavailable(observation && observation.properties, precipMm);
    }
    renderHourly(hourlyPeriods.slice(0, 24));
    renderDaily(dailyPeriods, hourlyPeriods);
    updateLocationLabels(daily && daily.properties && daily.properties.updated);
    updateMapPosition(state.lat, state.lon);
    loadNearbyRadarChoices(!isSameLocation);
    setLocationDisclosure(false);
  } catch (error) {
    if (isAbortError(error)) return;
    console.error(error);
    showToast(friendlyForecastError(error));
    el.updatedLabel.textContent = 'Forecast unavailable. Try again or choose a nearby ZIP code.';
    setLocationDisclosure(true);
  } finally {
    if (state.requestController === controller) {
      state.requestController = null;
      if (!state.zipController) setLoading(false);
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

function setCurrentUnavailable(observation, precipMm) {
  el.currentTemp.textContent = '--';
  el.currentSummary.textContent = 'Hourly forecast is temporarily unavailable';
  el.feelsLike.textContent = '--\u00B0';
  el.wind.textContent = '--';
  el.humidity.textContent = '--';
  el.precipChance.textContent = '--';
  el.dewPoint.textContent = '--';
  el.visibility.textContent = formatDistance(
    getQuantValue(observation && observation.visibility),
    observation && observation.visibility && observation.visibility.unitCode
  );
  el.precipTotal.textContent = formatPrecipTotal(precipMm);
  el.precipTotal.title = Number.isFinite(precipMm)
    ? 'Forecast liquid precipitation for the next 24 hours'
    : 'NWS quantitative precipitation data is unavailable';
}

async function loadLatestObservation(stationsUrl, signal) {
  if (!stationsUrl) return null;
  const stations = await fetchJson(stationsUrl, { signal: signal, retries: 1 });
  const features = stations && Array.isArray(stations.features) ? stations.features : [];
  let fallback = null;

  for (const feature of features.slice(0, 3)) {
    const stationId = String(
      feature && feature.properties && feature.properties.stationIdentifier || ''
    ).trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(stationId)) continue;

    try {
      const observation = await fetchJson(
        'https://api.weather.gov/stations/' + encodeURIComponent(stationId) + '/observations/latest',
        { signal: signal, retries: 1 }
      );
      if (!fallback) fallback = observation;
      const visibility = observation && observation.properties && observation.properties.visibility;
      if (Number.isFinite(getQuantValue(visibility))) return observation;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!error || error.status !== 404) throw error;
    }
  }

  return fallback;
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
    const value = getQuantValue(entry && entry.value);
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
  if (parts.length !== 2) return null;
  const start = Date.parse(parts[0]);
  const duration = parseIsoDuration(parts[1]);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return null;
  return { start: start, end: start + duration };
}

function parseIsoDuration(value) {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value || '');
  if (!match || !match.slice(1).some(Boolean)) return NaN;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

// Sunrise/sunset are not part of the NWS API response, so they are computed locally
// with NOAA's published low-precision solar position algorithm (see
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF). This is accurate to roughly a
// minute for the sunrise/sunset use case and needs no extra network request.
const SUN_DEG2RAD = Math.PI / 180;
const SUN_RAD2DEG = 180 / Math.PI;

function normalizeDegrees(value) {
  const mod = value % 360;
  return mod < 0 ? mod + 360 : mod;
}

function dateToJulianDay(components) {
  // Using noon UTC of the calendar day (rather than the exact moment) keeps this
  // independent of time-of-day; the Julian century term it feeds only drifts
  // meaningfully over years, so this has no material effect on accuracy.
  const ms = Date.UTC(components.year, components.month - 1, components.day, 12, 0, 0);
  return ms / 86400000 + 2440587.5;
}

function getLocationTodayComponents(timeZone) {
  const now = new Date();
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(now);
      const map = {};
      for (const part of parts) map[part.type] = part.value;
      const year = Number(map.year);
      const month = Number(map.month);
      const day = Number(map.day);
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        return { year: year, month: month, day: day };
      }
    } catch (error) {
      // Fall through to the UTC-based date below.
    }
  }
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

// Returns { sunrise: Date|null, sunset: Date|null, alwaysUp, alwaysDown } for the
// given latitude/longitude and calendar-day components, or null for invalid input.
function calculateSunTimes(lat, lon, dayComponents) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const jd = dateToJulianDay(dayComponents);
  const t = (jd - 2451545.0) / 36525.0;

  const meanLongitude = normalizeDegrees(280.46646 + t * (36000.76983 + t * 0.0003032));
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const meanAnomalyRad = meanAnomaly * SUN_DEG2RAD;
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const equationOfCenter =
    Math.sin(meanAnomalyRad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomalyRad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomalyRad) * 0.000289;
  const trueLongitude = meanLongitude + equationOfCenter;
  const apparentLongitude = trueLongitude - 0.00569 -
    0.00478 * Math.sin((125.04 - 1934.136 * t) * SUN_DEG2RAD);

  const meanObliquity = 23 + (26 + (21.448 -
    t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquityCorrection = meanObliquity +
    0.00256 * Math.cos((125.04 - 1934.136 * t) * SUN_DEG2RAD);

  const declinationRad = Math.asin(
    Math.sin(obliquityCorrection * SUN_DEG2RAD) * Math.sin(apparentLongitude * SUN_DEG2RAD)
  );

  const halfObliquityTan = Math.tan((obliquityCorrection / 2) * SUN_DEG2RAD);
  const y = halfObliquityTan * halfObliquityTan;
  const equationOfTimeMinutes = 4 * SUN_RAD2DEG * (
    y * Math.sin(2 * meanLongitude * SUN_DEG2RAD) -
    2 * eccentricity * Math.sin(meanAnomalyRad) +
    4 * eccentricity * y * Math.sin(meanAnomalyRad) * Math.cos(2 * meanLongitude * SUN_DEG2RAD) -
    0.5 * y * y * Math.sin(4 * meanLongitude * SUN_DEG2RAD) -
    1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomalyRad)
  );

  const latRad = lat * SUN_DEG2RAD;
  const cosHourAngle =
    Math.cos(90.833 * SUN_DEG2RAD) / (Math.cos(latRad) * Math.cos(declinationRad)) -
    Math.tan(latRad) * Math.tan(declinationRad);

  if (cosHourAngle > 1) return { sunrise: null, sunset: null, alwaysUp: false, alwaysDown: true };
  if (cosHourAngle < -1) return { sunrise: null, sunset: null, alwaysUp: true, alwaysDown: false };

  const hourAngleDeg = Math.acos(cosHourAngle) * SUN_RAD2DEG;
  const solarNoonMinutes = 720 - 4 * lon - equationOfTimeMinutes;
  const sunriseMinutes = solarNoonMinutes - 4 * hourAngleDeg;
  const sunsetMinutes = solarNoonMinutes + 4 * hourAngleDeg;

  const dayStartUtcMs = Date.UTC(dayComponents.year, dayComponents.month - 1, dayComponents.day);
  return {
    sunrise: new Date(dayStartUtcMs + sunriseMinutes * 60000),
    sunset: new Date(dayStartUtcMs + sunsetMinutes * 60000),
    alwaysUp: false,
    alwaysDown: false
  };
}

function formatClockTime(date) {
  return date instanceof Date && Number.isFinite(date.getTime())
    ? formatInForecastTime(date, { hour: 'numeric', minute: '2-digit' })
    : '--';
}

function formatSunTimes(sunTimes) {
  if (!sunTimes) return '--';
  if (sunTimes.alwaysUp) return 'Sun up all day';
  if (sunTimes.alwaysDown) return 'No sunrise today';
  if (!sunTimes.sunrise || !sunTimes.sunset) return '--';
  return formatClockTime(sunTimes.sunrise) + ' / ' + formatClockTime(sunTimes.sunset);
}

function renderSunTimes(lat, lon) {
  if (!el.sunTimes) return;
  const today = getLocationTodayComponents(state.timeZone);
  el.sunTimes.textContent = formatSunTimes(calculateSunTimes(lat, lon, today));
}

function renderHourly(periods) {
  state.hourlyPeriods = Array.isArray(periods) ? periods : [];
  el.hourlyCount.textContent = periods.length + ' hours';
  renderHourlyTrend(periods);
  el.hourlyForecast.replaceChildren();
  if (!periods.length) {
    el.hourlyForecast.innerHTML = '<div class="empty-state">No hourly forecast returned by NWS.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const period of periods) {
    const humidity = getQuantValue(period.relativeHumidity);
    const feels = calculateFeelsLike(period.temperature, humidity, period.windSpeed);
    const tempRounded = Math.round(period.temperature);
    const feelsRounded = Number.isFinite(feels) ? Math.round(feels) : tempRounded;
    const precipChance = getQuantValue(period.probabilityOfPrecipitation);
    const card = document.createElement('article');
    card.className = 'hour-card';
    card.innerHTML =
      '<div class="hour-time">' + formatHour(period.startTime) + '</div>' +
      '<img class="hour-icon" src="' + iconUrl(period.icon, 'large') + '" alt="' +
      escapeHtml(period.shortForecast || '') +
      '" width="54" height="54" loading="lazy" decoding="async">' +
      '<div class="hour-temp">' + tempRounded + '\u00B0</div>' +
      (feelsRounded !== tempRounded
        ? '<div class="hour-feels">Feels ' + feelsRounded + '\u00B0</div>'
        : '') +
      // A 0% (or missing) chance on nearly every card would bury the few hours
      // that actually matter, so only meaningful precipitation chances are shown.
      (Number.isFinite(precipChance) && precipChance > 0
        ? '<div class="hour-precip"><span class="hour-precip-icon" aria-hidden="true">\u{1F4A7}</span>' +
          formatPercent(precipChance) + '</div>'
        : '');
    fragment.append(card);
  }
  el.hourlyForecast.append(fragment);
}

function renderHourlyTrend(periods) {
  if (!el.hourlyTrend) return;
  if (!periods || !periods.length) {
    el.hourlyTrend.innerHTML = '';
    el.hourlyTrend.classList.add('hidden');
    return;
  }

  el.hourlyTrend.classList.remove('hidden');
  const markup = buildHourlyTrendMarkup(periods, el.hourlyTrend.clientWidth);
  el.hourlyTrend.innerHTML = markup ||
    '<p class="hourly-trend-empty">NWS did not return precipitation chances for these hours.</p>';
}

// The chart is drawn at the container's own pixel size instead of being stretched
// from a fixed viewBox, because a non-uniform stretch distorts the axis text into
// something unreadable. That makes the width layout-dependent, so redraw on resize.
function observeHourlyTrendWidth() {
  if (!el.hourlyTrend || typeof ResizeObserver === 'undefined') return;
  let lastWidth = el.hourlyTrend.clientWidth;
  const observer = new ResizeObserver(function (entries) {
    const width = Math.round(entries[0].contentRect.width);
    if (!width || width === lastWidth) return;
    lastWidth = width;
    if (state.hourlyPeriods.length) renderHourlyTrend(state.hourlyPeriods);
  });
  observer.observe(el.hourlyTrend);
}

// Builds one full-width SVG column chart of hourly precipitation chance, rather
// than trying to keep per-hour marks aligned with the independently-scrolling hour
// cards below (which would break on scroll/resize). The scale is pinned to 0-100%
// so hours read against a constant axis instead of a rescaled one. Returns ''
// when NWS supplied no usable probability values.
function buildHourlyTrendMarkup(periods, availableWidth) {
  const points = periods
    .map(function (period) {
      const chance = getQuantValue(period && period.probabilityOfPrecipitation);
      if (!Number.isFinite(chance)) return null;
      return { chance: Math.min(100, Math.max(0, chance)), time: period.startTime };
    })
    .filter(Boolean);
  if (!points.length) return '';

  const width = Math.max(280, Math.round(availableWidth) || 600);
  const height = 178;
  const paddingLeft = 42;
  const paddingRight = 12;
  const paddingTop = 20;
  const paddingBottom = 30;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;
  const baseline = paddingTop + plotHeight;
  const slot = plotWidth / points.length;
  const barWidth = Math.max(4, Math.min(30, slot * 0.62));
  const yFor = function (chance) { return paddingTop + plotHeight * (1 - chance / 100); };

  let peakIndex = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].chance > points[peakIndex].chance) peakIndex = i;
  }
  const peak = points[peakIndex];

  let gridMarkup = '';
  for (const level of [0, 25, 50, 75, 100]) {
    const y = yFor(level);
    gridMarkup += '<line class="hourly-trend-grid" x1="' + paddingLeft + '" y1="' + y.toFixed(1) +
      '" x2="' + (width - paddingRight) + '" y2="' + y.toFixed(1) + '"></line>' +
      '<text class="hourly-trend-axis" x="' + (paddingLeft - 8) + '" y="' + (y + 4).toFixed(1) +
      '" text-anchor="end">' + level + '%</text>';
  }

  // Thin the hour labels to whatever the available width can show without them
  // colliding, so the axis stays legible from phone to desktop.
  const labelStep = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotWidth / 58))));
  let barsMarkup = '';
  let ticksMarkup = '';
  points.forEach(function (point, index) {
    const center = paddingLeft + slot * (index + 0.5);
    const top = yFor(point.chance);
    if (point.chance > 0) {
      const barHeight = Math.max(2, baseline - top);
      barsMarkup += '<rect class="hourly-trend-bar' +
        (index === peakIndex ? ' hourly-trend-bar-peak' : '') +
        '" x="' + (center - barWidth / 2).toFixed(1) + '" y="' + top.toFixed(1) +
        '" width="' + barWidth.toFixed(1) +
        '" height="' + barHeight.toFixed(1) +
        // Clamp the radius by height too, so a near-zero bar stays a sliver
        // instead of rounding itself into a lozenge.
        '" rx="' + Math.min(4, barWidth / 2, barHeight / 2).toFixed(1) + '"></rect>';
    }
    if (index % labelStep === 0) {
      ticksMarkup += '<text class="hourly-trend-tick" x="' + center.toFixed(1) + '" y="' +
        (height - 10) + '" text-anchor="middle">' + escapeHtml(formatHour(point.time)) + '</text>';
    }
  });

  let peakMarkup = '';
  if (peak.chance > 0) {
    // Keep the callout inside the plot when the peak lands on the first or last hour.
    const peakX = Math.min(
      width - paddingRight - 16,
      Math.max(paddingLeft + 16, paddingLeft + slot * (peakIndex + 0.5))
    );
    peakMarkup = '<text class="hourly-trend-label" x="' + peakX.toFixed(1) + '" y="' +
      Math.max(13, yFor(peak.chance) - 8).toFixed(1) + '" text-anchor="middle">' +
      formatPercent(peak.chance) + '</text>';
  }

  const summary = peak.chance > 0
    ? 'Peak ' + formatPercent(peak.chance) + ' at ' + formatHour(peak.time)
    : 'No chance above 0%';
  const ariaLabel = peak.chance > 0
    ? points.length + '-hour precipitation chance, peaking at ' + formatPercent(peak.chance) +
      ' at ' + formatHour(peak.time)
    : points.length + '-hour precipitation chance, 0% every hour';

  return '<div class="hourly-trend-head">' +
      '<h3 class="hourly-trend-title">Chance of precipitation</h3>' +
      '<span class="hourly-trend-summary">' + escapeHtml(summary) + '</span>' +
    '</div>' +
    '<svg class="hourly-trend-svg" width="' + width + '" height="' + height +
    '" viewBox="0 0 ' + width + ' ' + height +
    '" role="img" aria-label="' + escapeHtml(ariaLabel) + '">' +
    gridMarkup + barsMarkup + ticksMarkup + peakMarkup +
    '</svg>';
}

function renderAlerts(features) {
  el.alertsList.replaceChildren();
  el.alertsPanel.classList.remove('hidden');
  if (!Array.isArray(features)) {
    el.alertsCount.textContent = 'Unavailable';
    el.alertsList.innerHTML = '<div class="empty-state">Active alerts could not be checked. Refresh to try again.</div>';
    return;
  }

  const alerts = features
    .map(function (feature) { return feature && feature.properties; })
    .filter(function (alert) { return /\b(watch|warning)\b/i.test((alert && alert.event) || ''); })
    .sort(function (a, b) {
      return new Date(a.ends || a.expires || 0) - new Date(b.ends || b.expires || 0);
    });

  el.alertsCount.textContent = alerts.length ? alerts.length + ' active' : 'None';
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
      '<img src="' + iconUrl(day.icon, 'large') + '" alt="" width="58" height="58" loading="lazy" decoding="async">' +
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
    const dateKey = toDateKey(period && period.startTime);
    if (!dateKey) continue;
    const existing = days.get(dateKey) || {
      name: formatForecastDate(dateKey),
      dateKey: dateKey,
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
    days.set(dateKey, existing);
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
    if (!key) continue;
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
      const data = await fetchJson(
        'https://api.weather.gov/radar/stations?stationType=WSR-88D',
        {
          signal: controller.signal,
          retries: 1
        }
      );
      state.radarCatalog = parseRadarCatalog(data);
      if (!state.radarCatalog.length) {
        throw new Error('NWS returned no usable WSR-88D radar stations.');
      }
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
  el.radarPlayButton.setAttribute('aria-pressed', 'true');
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
  el.radarPlayButton.setAttribute('aria-pressed', 'false');
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
  updateRadarLegend(status);
}

function updateRadarLegend(status) {
  if (!el.radarLegend) return;
  if (status !== 'ready' || !state.radarFrames.length) {
    el.radarLegend.classList.add('hidden');
    return;
  }
  const sourceKey = state.radarSource === 'nws' ? 'nws' : 'rainviewer';
  const content = RADAR_LEGEND_CONTENT[sourceKey];
  el.radarLegend.dataset.source = sourceKey;
  el.radarLegendCaption.textContent = content.caption;
  el.radarLegendTicks.replaceChildren(...content.ticks.map(function (label) {
    const tick = document.createElement('span');
    tick.textContent = label;
    return tick;
  }));
  if (el.radarLegendDescription) el.radarLegendDescription.textContent = content.description;
  el.radarLegend.classList.remove('hidden');
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

function isValidCoordinates(lat, lon) {
  if ((typeof lat !== 'number' && typeof lat !== 'string') ||
      (typeof lon !== 'number' && typeof lon !== 'string') ||
      String(lat).trim() === '' || String(lon).trim() === '') {
    return false;
  }
  const latitude = Number(lat);
  const longitude = Number(lon);
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function getLocationKey(lat, lon) {
  return isValidCoordinates(lat, lon)
    ? roundCoord(Number(lat)) + ',' + roundCoord(Number(lon))
    : '';
}

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function normalizeTimeZone(value) {
  const timeZone = String(value || '').trim();
  if (!timeZone) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone }).format(0);
    return timeZone;
  } catch {
    return '';
  }
}

function getQuantValue(value) {
  if (value === null || value === undefined) return NaN;
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
  if (!Number.isFinite(value) || value < 0) return '--';
  const unit = String(unitCode || '');
  let miles = value;
  if (unit === 'm' || unit.endsWith(':m')) miles = value / 1609.344;
  else if (unit === 'km' || unit.endsWith(':km')) miles = value / 1.609344;
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
  const matches = String(text || '').match(/\d+(?:\.\d+)?/g);
  if (!matches) return 0;
  const values = matches.map(Number);
  return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
}

function compactWind(speed, direction) {
  const speedText = String(speed || '').trim();
  if (!speedText || speedText.toLowerCase() === 'calm') return 'Calm';
  return direction ? direction + ' ' + speedText : speedText;
}

// Today loses its daytime period once the afternoon passes, and the final day of
// the range can arrive without a night period. Label the single value that exists
// instead of pairing it with a meaningless placeholder.
function formatHighLow(day) {
  const hasHigh = Number.isFinite(day.high);
  const hasLow = Number.isFinite(day.low);
  if (hasHigh && hasLow) return Math.round(day.high) + '\u00B0 / ' + Math.round(day.low) + '\u00B0';
  if (hasHigh) return 'High ' + Math.round(day.high) + '\u00B0';
  if (hasLow) return 'Low ' + Math.round(day.low) + '\u00B0';
  return '--';
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
  const isoDate = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(String(value || ''));
  if (isoDate) {
    const parsedIsoDate = new Date(isoDate[1] + 'T12:00:00Z');
    if (Number.isFinite(parsedIsoDate.getTime()) &&
        parsedIsoDate.toISOString().slice(0, 10) === isoDate[1]) {
      return isoDate[1];
    }
    return '';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function formatForecastDate(dateKey) {
  const date = new Date(dateKey + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime())) return 'Forecast day';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

function formatAlertEnds(value) {
  if (!value) return 'Until further notice';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'End time unavailable';
  return 'Until ' + formatInForecastTime(date, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'time unavailable';
  return formatInForecastTime(date, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatHour(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? formatInForecastTime(date, { hour: 'numeric' })
    : '--';
}

function formatUnix(value) {
  const date = new Date(Number(value) * 1000);
  if (!Number.isFinite(date.getTime())) return '--';
  return formatInForecastTime(date, {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatInForecastTime(date, options) {
  const config = Object.assign({}, options);
  if (state.timeZone) config.timeZone = state.timeZone;
  return date.toLocaleString(undefined, config);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function iconUrl(value, size) {
  try {
    const url = new URL(value);
    url.searchParams.set('size', size);
    return safeUrl(url.href);
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
