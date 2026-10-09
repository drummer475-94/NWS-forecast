'use strict';

const STATUS_SNAPSHOT_URL = 'data/nc-status.json';
const COUNTY_GEOJSON_URL = 'data/nc-counties.geojson';
const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?area=NC';
const ZIP_LOOKUP_BASE = 'https://api.zippopotam.us/us/';
const USGS_BASEMAP_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const THEME_STORAGE_KEY = 'theme';
const COUNTY_STORAGE_KEY = 'local-weather-nc-county';
const DEFAULT_COUNTY_FIPS = '37183';
const WEATHER_REFRESH_MS = 5 * 60 * 1000;
const RESUME_REFRESH_MIN_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;
const POWER_FRESH_MS = 45 * 60 * 1000;
const POWER_STALE_MS = 60 * 60 * 1000;
const WEATHER_FRESH_MS = 5 * 60 * 1000;
const WEATHER_STALE_MS = 10 * 60 * 1000;

const COUNTY_NAMES = [
  'Alamance', 'Alexander', 'Alleghany', 'Anson', 'Ashe', 'Avery', 'Beaufort', 'Bertie', 'Bladen', 'Brunswick',
  'Buncombe', 'Burke', 'Cabarrus', 'Caldwell', 'Camden', 'Carteret', 'Caswell', 'Catawba', 'Chatham', 'Cherokee',
  'Chowan', 'Clay', 'Cleveland', 'Columbus', 'Craven', 'Cumberland', 'Currituck', 'Dare', 'Davidson', 'Davie',
  'Duplin', 'Durham', 'Edgecombe', 'Forsyth', 'Franklin', 'Gaston', 'Gates', 'Graham', 'Granville', 'Greene',
  'Guilford', 'Halifax', 'Harnett', 'Haywood', 'Henderson', 'Hertford', 'Hoke', 'Hyde', 'Iredell', 'Jackson',
  'Johnston', 'Jones', 'Lee', 'Lenoir', 'Lincoln', 'McDowell', 'Macon', 'Madison', 'Martin', 'Mecklenburg',
  'Mitchell', 'Montgomery', 'Moore', 'Nash', 'New Hanover', 'Northampton', 'Onslow', 'Orange', 'Pamlico', 'Pasquotank',
  'Pender', 'Perquimans', 'Person', 'Pitt', 'Polk', 'Randolph', 'Richmond', 'Robeson', 'Rockingham', 'Rowan',
  'Rutherford', 'Sampson', 'Scotland', 'Stanly', 'Stokes', 'Surry', 'Swain', 'Transylvania', 'Tyrrell', 'Union',
  'Vance', 'Wake', 'Warren', 'Washington', 'Watauga', 'Wayne', 'Wilkes', 'Wilson', 'Yadkin', 'Yancey'
];

const NC_COUNTIES = COUNTY_NAMES.map(function (name, index) {
  return { name: name, fips: '37' + String(index * 2 + 1).padStart(3, '0') };
});
// Forecast-zone (NCZ###) to county lookups are intentionally empty: no reliable source was available to
// derive them and mappings are never guessed. Zone-only alerts resolve through SAME/UGC county codes,
// affectedZones county URLs, or polygon geometry; otherwise they are listed as unmatched.
const NC_ZONE_TO_COUNTY_FIPS = {};
const COUNTY_BY_FIPS = new Map(NC_COUNTIES.map(function (county) { return [county.fips, county]; }));
// Shared with scripts/nc-status.mjs; status.html loads alert-geography.js before this script.
const alertGeographyApi = globalThis.NcAlertGeography;
const geometryPolygons = alertGeographyApi.geometryPolygons;
const pointInPolygon = alertGeographyApi.pointInPolygon;
const alertGeography = alertGeographyApi.alertGeography;
const isAlertActive = alertGeographyApi.isAlertActive;
const deriveAlertGeography = alertGeographyApi.createAlertGeography({
  countyFips: NC_COUNTIES.map(function (county) { return county.fips; }),
  zoneTable: NC_ZONE_TO_COUNTY_FIPS
}).deriveAlertGeography;
const numberFormatter = new Intl.NumberFormat('en-US');

const statusState = {
  activeLayer: 'power',
  countyLayers: new Map(),
  geometry: null,
  geometryPromise: null,
  liveAlerts: null,
  map: null,
  mapLayer: null,
  refreshing: false,
  refreshTimer: 0,
  selectedFips: DEFAULT_COUNTY_FIPS,
  snapshot: null,
  snapshotCheckedAt: '',
  snapshotController: null,
  snapshotError: false,
  snapshotLastAttemptMs: 0,
  snapshotPromise: null,
  weatherLastAttemptMs: 0,
  weatherPromise: null,
  weatherSource: null
};

const statusEl = {
  alertList: document.querySelector('#statusAlertList'),
  alertSummary: document.querySelector('#alertSummary'),
  alertTotal: document.querySelector('#alertTotal'),
  unmatchedAlerts: document.querySelector('#statusUnmatchedAlerts'),
  countyList: document.querySelector('#countyList'),
  countySelect: document.querySelector('#countySelect'),
  deviceLocationButton: document.querySelector('#deviceLocationButton'),
  map: document.querySelector('#statusMap'),
  mapFallback: document.querySelector('#mapFallback'),
  mapLegend: document.querySelector('#mapLegend'),
  mapNote: document.querySelector('#mapNote'),
  overallStatusPill: document.querySelector('#overallStatusPill'),
  powerDetailCopy: document.querySelector('#powerDetailCopy'),
  powerDetailTotal: document.querySelector('#powerDetailTotal'),
  powerDetailsHeading: document.querySelector('#powerDetailsHeading'),
  powerFreshness: document.querySelector('#powerFreshness'),
  powerLayerButton: document.querySelector('#powerLayerButton'),
  powerSourceStatus: document.querySelector('#powerSourceStatus'),
  powerSummary: document.querySelector('#powerSummary'),
  powerTotal: document.querySelector('#powerTotal'),
  refreshButton: document.querySelector('#refreshButton'),
  rememberCounty: document.querySelector('#rememberCounty'),
  selectedCountyHint: document.querySelector('#selectedCountyHint'),
  selectedCountyName: document.querySelector('#selectedCountyName'),
  sourceNotice: document.querySelector('#sourceNotice'),
  statusMessage: document.querySelector('#statusMessage'),
  themeToggleButton: document.querySelector('#themeToggleButton'),
  toast: document.querySelector('#toast'),
  warningBanner: document.querySelector('#statusWarningBanner'),
  weatherFreshness: document.querySelector('#weatherFreshness'),
  weatherLayerButton: document.querySelector('#weatherLayerButton'),
  weatherSourceStatus: document.querySelector('#weatherSourceStatus'),
  zip: document.querySelector('#statusZip'),
  zipButton: document.querySelector('#statusZipButton'),
  zipForm: document.querySelector('#statusZipForm')
};

document.addEventListener('DOMContentLoaded', initStatusPage);
statusEl.themeToggleButton.addEventListener('click', toggleTheme);
statusEl.refreshButton.addEventListener('click', refreshAllStatus);
statusEl.zipForm.addEventListener('submit', handleZipLookup);
statusEl.deviceLocationButton.addEventListener('click', handleDeviceLocation);
statusEl.countySelect.addEventListener('change', function () {
  selectCounty(statusEl.countySelect.value, 'County selected from the list.');
});
statusEl.rememberCounty.addEventListener('change', handleRememberCounty);
statusEl.powerLayerButton.addEventListener('click', function () { setMapLayer('power'); });
statusEl.weatherLayerButton.addEventListener('click', function () { setMapLayer('weather'); });
document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('offline', function () {
  showToast('You appear to be offline. Last-known county information remains visible.');
});
window.addEventListener('online', function () {
  showToast('Connection restored. Refreshing county status and weather alerts.');
  refreshSourcesQuietly();
  startAutoRefresh();
});

async function initStatusPage() {
  initTheme();
  populateCountyControls();
  restoreRememberedCounty();
  renderStatus();

  await Promise.allSettled([
    loadStatusSnapshot(),
    loadCountyGeometry(),
    refreshWeatherAlerts({ quiet: true })
  ]);

  startAutoRefresh();
}

function isOffline() {
  return typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
}

// Refreshes the deployed snapshot and the live NWS alerts independently; neither failure blocks the other.
function refreshSourcesQuietly() {
  if (isOffline()) return Promise.resolve([]);
  return Promise.allSettled([
    loadStatusSnapshot({ quiet: true }),
    refreshWeatherAlerts({ quiet: true })
  ]);
}

function stopAutoRefresh() {
  if (statusState.refreshTimer) window.clearInterval(statusState.refreshTimer);
  statusState.refreshTimer = 0;
}

// A single timer drives both sources and only runs while the tab is visible.
function startAutoRefresh() {
  stopAutoRefresh();
  if (document.hidden) return;
  statusState.refreshTimer = window.setInterval(function () {
    if (document.hidden) {
      stopAutoRefresh();
      return;
    }
    refreshSourcesQuietly();
  }, WEATHER_REFRESH_MS);
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopAutoRefresh();
    return;
  }
  const oldest = Math.min(statusState.snapshotLastAttemptMs, statusState.weatherLastAttemptMs);
  if (Date.now() - oldest >= RESUME_REFRESH_MIN_MS) refreshSourcesQuietly();
  startAutoRefresh();
}

function getStoredTheme() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : '';
  } catch {
    return '';
  }
}

function getSystemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function getActiveTheme() {
  return getStoredTheme() || getSystemTheme();
}

function syncThemeButton(theme) {
  const next = theme === 'dark' ? 'light' : 'dark';
  statusEl.themeToggleButton.setAttribute('aria-label', 'Switch to ' + next + ' theme');
  statusEl.themeToggleButton.setAttribute('aria-pressed', String(theme === 'light'));
  statusEl.themeToggleButton.querySelector('.theme-icon').textContent = theme === 'dark' ? '\u2600' : '\u263E';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  syncThemeButton(theme);
  renderCountyMap();
}

function initTheme() {
  applyTheme(getActiveTheme());
  if (!window.matchMedia) return;
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = function () {
    if (!getStoredTheme()) applyTheme(getSystemTheme());
  };
  if (query.addEventListener) query.addEventListener('change', onChange);
}

function toggleTheme() {
  const next = getActiveTheme() === 'dark' ? 'light' : 'dark';
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* The selected theme still applies for this page view. */
  }
  applyTheme(next);
}

function populateCountyControls() {
  const options = document.createDocumentFragment();
  const buttons = document.createDocumentFragment();

  NC_COUNTIES.forEach(function (county) {
    const option = document.createElement('option');
    option.value = county.fips;
    option.textContent = county.name + ' County';
    options.append(option);

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.fips = county.fips;
    button.textContent = county.name;
    button.setAttribute('aria-label', 'Select ' + county.name + ' County');
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', function () {
      selectCounty(county.fips, county.name + ' County selected from the county list.');
    });
    buttons.append(button);
  });

  statusEl.countySelect.replaceChildren(options);
  statusEl.countyList.replaceChildren(buttons);
  statusEl.countySelect.value = statusState.selectedFips;
}

function restoreRememberedCounty() {
  try {
    const saved = window.localStorage.getItem(COUNTY_STORAGE_KEY);
    if (COUNTY_BY_FIPS.has(saved)) {
      statusState.selectedFips = saved;
      statusEl.rememberCounty.checked = true;
      statusEl.countySelect.value = saved;
      setStatusMessage('Showing your remembered county.');
    }
  } catch {
    /* County persistence is optional. */
  }
}

function handleRememberCounty() {
  try {
    if (statusEl.rememberCounty.checked) {
      window.localStorage.setItem(COUNTY_STORAGE_KEY, statusState.selectedFips);
      setStatusMessage('This county will be remembered on this device.');
    } else {
      window.localStorage.removeItem(COUNTY_STORAGE_KEY);
      setStatusMessage('This county is no longer remembered.');
    }
  } catch {
    statusEl.rememberCounty.checked = false;
    setStatusMessage('This browser could not save the county preference.');
  }
  renderStatus();
}

function selectCounty(fips, message) {
  if (!COUNTY_BY_FIPS.has(fips)) return false;
  statusState.selectedFips = fips;
  statusEl.countySelect.value = fips;
  if (statusEl.rememberCounty.checked) {
    try {
      window.localStorage.setItem(COUNTY_STORAGE_KEY, fips);
    } catch {
      statusEl.rememberCounty.checked = false;
    }
  }
  if (message) setStatusMessage(message);
  renderStatus();
  return true;
}

function snapshotTimestamp(snapshot, kind) {
  const value = kind === 'power'
    ? snapshot && snapshot.sources && snapshot.sources.power && snapshot.sources.power.lastSuccessAt
    : snapshot && snapshot.generatedAt;
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

// A fetched snapshot replaces the held one only if it is not older (by generation or power success time).
function isSnapshotAcceptable(candidate, held) {
  if (!isStatusSnapshot(candidate)) return false;
  if (!held) return true;
  const kinds = ['generated', 'power'];
  return kinds.every(function (kind) {
    const next = snapshotTimestamp(candidate, kind === 'power' ? 'power' : 'generated');
    const current = snapshotTimestamp(held, kind === 'power' ? 'power' : 'generated');
    if (current === null) return true;
    return next !== null && next >= current;
  });
}

function loadStatusSnapshot(options) {
  if (statusState.snapshotPromise) return statusState.snapshotPromise;
  const quiet = options && options.quiet;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  statusState.snapshotController = controller;
  statusState.snapshotLastAttemptMs = Date.now();
  const promise = (async function () {
    try {
      const separator = STATUS_SNAPSHOT_URL.includes('?') ? '&' : '?';
      const snapshot = await fetchJson(STATUS_SNAPSHOT_URL + separator + 'v=' + Date.now(), {
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      if (!isStatusSnapshot(snapshot)) throw new Error('The status snapshot has an unexpected format.');
      statusState.snapshotCheckedAt = new Date().toISOString();
      if (!isSnapshotAcceptable(snapshot, statusState.snapshot)) {
        // Older or regressed data never replaces a good snapshot already held.
        if (!quiet) setStatusMessage('The saved county snapshot was older than the data already shown, so it was ignored.');
        renderStatus();
        return statusState.snapshot;
      }
      statusState.snapshot = snapshot;
      statusState.snapshotError = false;
      if (statusState.liveAlerts === null) statusState.weatherSource = snapshot.sources.weather;
      if (!quiet) setStatusMessage('Official county status loaded. Source age is shown with each section.');
      renderStatus();
      return snapshot;
    } catch (error) {
      statusState.snapshotError = true;
      if (!quiet) setStatusMessage('The saved county snapshot could not be loaded. Last-known county information remains visible.');
      renderStatus();
      throw error;
    } finally {
      statusState.snapshotPromise = null;
      statusState.snapshotController = null;
    }
  })();
  statusState.snapshotPromise = promise;
  return promise;
}

async function loadCountyGeometry() {
  if (statusState.geometry) return statusState.geometry;
  if (statusState.geometryPromise) return statusState.geometryPromise;

  statusState.geometryPromise = (async function () {
    try {
      const geometry = await fetchJson(COUNTY_GEOJSON_URL, { cache: 'force-cache' });
      if (!isCountyGeometry(geometry)) throw new Error('The county boundary file has an unexpected format.');
      statusState.geometry = geometry;
      initializeCountyMap(geometry);
      return geometry;
    } catch (error) {
      showMapFallback();
      throw error;
    } finally {
      statusState.geometryPromise = null;
    }
  })();

  return statusState.geometryPromise;
}

function refreshWeatherAlerts(options) {
  if (statusState.weatherPromise) return statusState.weatherPromise;
  statusState.weatherPromise = fetchWeatherAlerts(options).finally(function () {
    statusState.weatherPromise = null;
  });
  return statusState.weatherPromise;
}

async function fetchWeatherAlerts(options) {
  const quiet = options && options.quiet;
  const attemptedAt = new Date().toISOString();
  statusState.weatherLastAttemptMs = Date.now();
  try {
    // County boundaries let polygon-only alerts be mapped to counties; alerts still load without them.
    if (!statusState.geometry) await loadCountyGeometry().catch(function () {});
    const payload = await fetchJson(NWS_ALERTS_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/geo+json' }
    });
    statusState.liveAlerts = parseNwsAlerts(payload, Date.now(), statusState.geometry);
    statusState.weatherSource = {
      name: 'National Weather Service',
      sourceUrl: NWS_ALERTS_URL,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: attemptedAt,
      freshness: 'fresh'
    };
    if (!quiet) setStatusMessage('Weather alerts refreshed from the National Weather Service.');
    renderStatus();
    return statusState.liveAlerts;
  } catch (error) {
    const previous = getWeatherSource();
    statusState.weatherSource = Object.assign({}, previous, {
      name: 'National Weather Service',
      sourceUrl: NWS_ALERTS_URL,
      lastAttemptAt: attemptedAt,
      failureCategory: 'live-refresh-failed'
    });
    if (!quiet) setStatusMessage('Live weather alerts could not be refreshed. Last-known information remains visible.');
    renderStatus();
    throw error;
  }
}

async function refreshAllStatus() {
  if (statusState.refreshing) return;
  statusState.refreshing = true;
  setRefreshLoading(true);
  setStatusMessage('Refreshing county status and weather alerts.');
  const tasks = [loadStatusSnapshot({ quiet: true }), refreshWeatherAlerts({ quiet: true })];
  if (!statusState.geometry) tasks.push(loadCountyGeometry());
  const results = await Promise.allSettled(tasks);
  const failures = results.filter(function (result) { return result.status === 'rejected'; }).length;
  setRefreshLoading(false);
  statusState.refreshing = false;
  if (failures) {
    setStatusMessage('Some sources could not be refreshed. Last-known information remains labeled below.');
    showToast('Refresh completed with ' + failures + ' unavailable ' + (failures === 1 ? 'source.' : 'sources.'));
  } else {
    setStatusMessage('County status refreshed.');
    showToast('North Carolina status refreshed.');
  }
}

async function handleZipLookup(event) {
  event.preventDefault();
  const zip = statusEl.zip.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    setStatusMessage('Enter a 5-digit North Carolina ZIP code.');
    statusEl.zip.focus();
    return;
  }

  statusEl.zipButton.disabled = true;
  setStatusMessage('Finding the North Carolina county for ZIP ' + zip + '.');
  try {
    const payload = await fetchJson(ZIP_LOOKUP_BASE + encodeURIComponent(zip), { cache: 'no-store' });
    const place = resolveZipPayload(payload);
    if (place.status === 'outside') {
      setStatusMessage('ZIP ' + zip + ' is outside North Carolina. Choose an NC county below.');
      return;
    }
    if (place.status !== 'matched') throw new Error('ZIP lookup did not return usable coordinates.');
    const geometry = await loadCountyGeometry();
    const fips = countyFipsAt(place.longitude, place.latitude, geometry);
    if (!fips) throw new Error('ZIP coordinates did not match a North Carolina county.');
    const county = COUNTY_BY_FIPS.get(fips);
    selectCounty(fips, 'ZIP ' + zip + ' maps approximately to ' + county.name + ' County. Confirm the county if needed.');
  } catch (error) {
    setStatusMessage('That ZIP could not be matched right now. Choose a county from the list instead.');
  } finally {
    statusEl.zipButton.disabled = false;
  }
}

async function handleDeviceLocation() {
  if (!navigator.geolocation) {
    setStatusMessage('Device location is not available in this browser. Choose a county instead.');
    return;
  }

  statusEl.deviceLocationButton.disabled = true;
  setStatusMessage('Finding your county on this device. Coordinates are not transmitted or saved.');
  try {
    const geometry = await loadCountyGeometry();
    navigator.geolocation.getCurrentPosition(function (position) {
      const fips = countyFipsAt(position.coords.longitude, position.coords.latitude, geometry);
      if (fips) {
        const county = COUNTY_BY_FIPS.get(fips);
        selectCounty(fips, 'Device location matched ' + county.name + ' County. Coordinates were not transmitted or saved.');
      } else {
        setStatusMessage('Your device appears to be outside North Carolina. Choose an NC county below.');
      }
      statusEl.deviceLocationButton.disabled = false;
    }, function () {
      setStatusMessage('Location permission was not granted. Choose a county instead.');
      statusEl.deviceLocationButton.disabled = false;
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  } catch (error) {
    setStatusMessage('County boundaries are unavailable. Choose a county from the list instead.');
    statusEl.deviceLocationButton.disabled = false;
  }
}

function resolveZipPayload(payload) {
  const places = payload && Array.isArray(payload.places) ? payload.places : [];
  const place = places[0];
  if (!place || typeof place !== 'object') return { status: 'invalid' };
  if (String(place['state abbreviation'] || '').toUpperCase() !== 'NC') return { status: 'outside' };
  const latitude = Number(place.latitude);
  const longitude = Number(place.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { status: 'invalid' };
  return {
    status: 'matched',
    latitude: latitude,
    longitude: longitude,
    label: String(place['place name'] || '').trim()
  };
}

function isStatusSnapshot(value) {
  return Boolean(
    value &&
    value.schemaVersion === 1 &&
    value.state === 'NC' &&
    value.sources &&
    value.sources.power &&
    value.sources.weather &&
    Array.isArray(value.power) &&
    Array.isArray(value.alerts)
  );
}

function isCountyGeometry(value) {
  return Boolean(
    value &&
    value.type === 'FeatureCollection' &&
    Array.isArray(value.features) &&
    value.features.length === 100 &&
    value.features.every(function (feature) {
      return feature &&
        feature.type === 'Feature' &&
        feature.properties &&
        /^37\d{3}$/.test(String(feature.properties.GEOID || '')) &&
        feature.geometry &&
        (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon');
    })
  );
}

function countyFipsAt(longitude, latitude, boundaries) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Array.isArray(boundaries && boundaries.features)) {
    return undefined;
  }
  for (const feature of boundaries.features) {
    const geometry = feature.geometry;
    const polygons = geometryPolygons(geometry);
    if (polygons.some(function (polygon) { return pointInPolygon(longitude, latitude, polygon); })) {
      const fips = String(feature.properties && feature.properties.GEOID || '');
      return COUNTY_BY_FIPS.has(fips) ? fips : undefined;
    }
  }
  return undefined;
}

function parseNwsAlerts(input, nowMs, boundaries, zoneTable) {
  const features = input && input.features;
  if (!Array.isArray(features)) throw new Error('The NWS alert response has an unexpected format.');
  const currentTime = Number.isFinite(nowMs) ? nowMs : Date.now();

  return features.map(function (feature) {
    const properties = feature && feature.properties;
    if (!properties || typeof properties !== 'object') throw new Error('The NWS alert response has an unexpected feature.');
    const id = cleanText(properties.id) || cleanText(feature.id);
    const event = cleanText(properties.event);
    const expiresAt = validIso(properties.expires);
    if (!id || !event || !expiresAt) throw new Error('The NWS alert response is missing required fields.');
    const mapped = deriveAlertGeography(properties, feature.geometry, boundaries, zoneTable);
    const suppliedSeverity = cleanText(properties.severity);
    const severity = ['Extreme', 'Severe', 'Moderate', 'Minor'].includes(suppliedSeverity) ? suppliedSeverity : 'Unknown';
    return {
      id: id,
      event: event,
      headline: cleanText(properties.headline) || event,
      severity: severity,
      urgency: cleanText(properties.urgency) || 'Unknown',
      certainty: cleanText(properties.certainty) || 'Unknown',
      status: cleanText(properties.status) || 'Actual',
      messageType: cleanText(properties.messageType) || undefined,
      sentAt: validIso(properties.sent) || expiresAt,
      effectiveAt: validIso(properties.effective),
      onsetAt: validIso(properties.onset),
      expiresAt: expiresAt,
      endsAt: validIso(properties.ends),
      areaDescription: cleanText(properties.areaDesc) || 'North Carolina',
      geography: mapped.geography,
      countyFips: mapped.countyFips,
      description: cleanText(properties.description) || undefined,
      instruction: cleanText(properties.instruction) || undefined,
      senderName: cleanText(properties.senderName) || 'National Weather Service',
      sourceUrl: safeUrl(cleanText(properties['@id'])) || safeUrl('https://api.weather.gov/alerts/' + encodeURIComponent(id))
    };
  }).filter(function (alert) {
    return isAlertActive(alert, currentTime);
  });
}

function deriveFreshness(source, freshMs, staleMs, nowMs) {
  if (!source || !source.lastSuccessAt) return 'unavailable';
  const timestamp = Date.parse(source.lastSuccessAt);
  if (!Number.isFinite(timestamp)) return 'unavailable';
  const age = Math.max(0, (Number.isFinite(nowMs) ? nowMs : Date.now()) - timestamp);
  if (age <= freshMs) return 'fresh';
  if (age <= staleMs) return 'stale';
  return 'unavailable';
}

function powerBand(customersOut) {
  if (!Number.isFinite(customersOut) || customersOut < 0) return 'unknown';
  if (customersOut === 0) return 'none';
  if (customersOut < 100) return 'low';
  if (customersOut < 1000) return 'elevated';
  return 'major';
}

function weatherBand(alerts) {
  if (!Array.isArray(alerts)) return 'unknown';
  if (alerts.some(function (alert) { return alert.severity === 'Extreme' || alert.severity === 'Severe'; })) return 'major';
  if (alerts.some(function (alert) { return alert.severity === 'Moderate'; })) return 'elevated';
  if (alerts.length) return 'low';
  return 'none';
}

function alertsForCounty(alerts, fips, nowMs) {
  return (Array.isArray(alerts) ? alerts : []).filter(function (alert) {
    if (!isAlertActive(alert, nowMs)) return false;
    const geography = alertGeography(alert);
    return geography === 'statewide' || (geography === 'county' && alert.countyFips.includes(fips));
  }).sort(function (left, right) {
    return alertRank(left) - alertRank(right) || Date.parse(left.expiresAt) - Date.parse(right.expiresAt);
  });
}

function unmatchedAlerts(alerts, nowMs) {
  return (Array.isArray(alerts) ? alerts : []).filter(function (alert) {
    return isAlertActive(alert, nowMs) && alertGeography(alert) === 'unknown';
  });
}

function alertRank(alert) {
  const severity = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 }[alert.severity] ?? 4;
  return severity * 2 + (alert.urgency === 'Immediate' ? -1 : 0);
}

function getPowerSource() {
  return statusState.snapshot && statusState.snapshot.sources ? statusState.snapshot.sources.power : null;
}

function getWeatherSource() {
  if (statusState.weatherSource) return statusState.weatherSource;
  return statusState.snapshot && statusState.snapshot.sources ? statusState.snapshot.sources.weather : null;
}

function getVisibleAlerts() {
  return statusState.liveAlerts !== null ? statusState.liveAlerts : statusState.snapshot ? statusState.snapshot.alerts : [];
}

function getCountyPower(fips) {
  if (!statusState.snapshot || !Array.isArray(statusState.snapshot.power)) return null;
  return statusState.snapshot.power.find(function (record) { return record.countyFips === fips; }) || null;
}

function renderStatus() {
  const county = COUNTY_BY_FIPS.get(statusState.selectedFips) || COUNTY_BY_FIPS.get(DEFAULT_COUNTY_FIPS);
  const countyName = county.name + ' County';
  const now = Date.now();
  const powerSource = getPowerSource();
  const weatherSource = getWeatherSource();
  const powerFreshness = deriveFreshness(powerSource, POWER_FRESH_MS, POWER_STALE_MS, now);
  const weatherFreshness = deriveFreshness(weatherSource, WEATHER_FRESH_MS, WEATHER_STALE_MS, now);
  const power = getCountyPower(county.fips);
  const alerts = alertsForCounty(getVisibleAlerts(), county.fips, now);

  statusEl.selectedCountyName.textContent = countyName;
  statusEl.powerDetailsHeading.textContent = countyName;
  statusEl.countySelect.value = county.fips;
  statusEl.selectedCountyHint.textContent = statusEl.rememberCounty.checked
    ? 'This county is remembered on this device.'
    : 'Change the county with ZIP, device location, the map, or the list.';

  const powerValue = power && Number.isFinite(power.customersOut) ? power.customersOut : null;
  statusEl.powerTotal.textContent = powerValue === null ? '\u2014' : numberFormatter.format(powerValue);
  statusEl.powerDetailTotal.textContent = powerValue === null ? '\u2014' : numberFormatter.format(powerValue);
  statusEl.powerSummary.textContent = metricSummary(powerValue, powerFreshness, powerSource, 'reported');
  statusEl.powerDetailCopy.textContent = powerDetailMessage(powerValue, powerFreshness, powerSource);
  statusEl.powerFreshness.textContent = freshnessLabel(powerFreshness, powerSource);
  statusEl.powerFreshness.dataset.state = powerFreshness;

  statusEl.alertTotal.textContent = alertCountLabel(alerts, weatherFreshness);
  statusEl.alertSummary.textContent = alertSummaryMessage(alerts, weatherFreshness, weatherSource);
  statusEl.weatherFreshness.textContent = freshnessLabel(weatherFreshness, weatherSource);
  statusEl.weatherFreshness.dataset.state = weatherFreshness;

  renderAlertList(alerts, weatherFreshness, weatherSource);
  renderUnmatchedAlerts(unmatchedAlerts(getVisibleAlerts(), now));
  renderSourceState(powerFreshness, weatherFreshness, powerSource, weatherSource);
  renderWarningBanner(alerts, weatherFreshness);
  renderCountySelection();
  renderCountyMap();
}

function metricSummary(value, freshness, source, noun) {
  if (value === null) return freshness === 'fresh' ? 'County value is missing from current data.' : 'No last-known county value is available.';
  if (freshness === 'fresh') return noun + ' · updated ' + formatAge(source && source.lastSuccessAt);
  const asOf = formatDateTime(source && source.lastSuccessAt);
  if (freshness === 'stale') return 'Last known: ' + numberFormatter.format(value) + ' ' + noun + ' as of ' + asOf + ' \u2014 data is stale';
  return 'Last known: ' + numberFormatter.format(value) + ' ' + noun + ' as of ' + asOf + ' \u2014 current update unavailable';
}

function powerDetailMessage(value, freshness, source) {
  if (value === null) return 'Current county outage information is unavailable. This does not mean there are no outages.';
  if (freshness === 'fresh') return 'NC Emergency Management currently reports ' + numberFormatter.format(value) + ' customers without power. Updated ' + formatAge(source.lastSuccessAt) + '.';
  return 'The last successful NC Emergency Management update reported ' + numberFormatter.format(value) + ' customers without power. Current information is ' + freshness + '; this value is not an all-clear.';
}

function alertSummaryMessage(alerts, freshness, source) {
  if (freshness === 'fresh') {
    return alerts.length ? alerts[0].severity + ' · ' + alerts[0].event : 'No active county alerts in current NWS data.';
  }
  if (alerts.length) return 'Last known: ' + alerts[0].severity + ' · ' + alerts[0].event + '. Current updates are ' + freshness + '.';
  if (!source || !source.lastSuccessAt) return 'Current NWS alerts could not be checked, and no last-known alert set is available.';
  return 'No alerts were present in the last successful update. Current alerts could not be confirmed (' + formatAge(source && source.lastSuccessAt) + ').';
}

function alertCountLabel(alerts, freshness) {
  const count = Array.isArray(alerts) ? alerts.length : 0;
  return freshness === 'unavailable' && count === 0 ? '\u2014' : numberFormatter.format(count);
}

function renderAlertList(alerts, freshness, source) {
  const fragment = document.createDocumentFragment();
  if (!alerts.length) {
    const empty = document.createElement('p');
    empty.className = 'status-alert-empty';
    empty.textContent = freshness === 'fresh'
      ? 'No active NWS alerts apply to this county in current data.'
      : source && source.lastSuccessAt
        ? 'No alerts were present in the last successful update. Current conditions could not be confirmed.'
        : 'Current NWS alerts could not be checked. No last-known alert set is available.';
    fragment.append(empty);
  } else {
    alerts.forEach(function (alert) {
      const card = document.createElement('article');
      card.className = 'status-alert-card';
      card.dataset.severity = alert.severity;

      const titleRow = document.createElement('div');
      titleRow.className = 'status-alert-title-row';
      const title = document.createElement('strong');
      title.textContent = alert.event;
      const severity = document.createElement('span');
      severity.className = 'status-alert-severity';
      severity.textContent = alert.severity;
      titleRow.append(title, severity);

      const headline = document.createElement('p');
      headline.className = 'status-alert-headline';
      headline.textContent = alert.headline;
      const meta = document.createElement('p');
      meta.className = 'status-alert-meta';
      meta.textContent = alert.urgency + ' urgency · expires ' + formatDateTime(alert.expiresAt) + ' · ' + alert.areaDescription;
      card.append(titleRow, headline, meta);

      if (alert.instruction) {
        const instruction = document.createElement('p');
        instruction.className = 'status-alert-instruction';
        instruction.textContent = alert.instruction;
        card.append(instruction);
      }

      const url = safeUrl(alert.sourceUrl);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = 'View official NWS alert';
        card.append(link);
      }
      fragment.append(card);
    });
  }
  statusEl.alertList.replaceChildren(fragment);
}

function renderUnmatchedAlerts(unmatched) {
  const container = statusEl.unmatchedAlerts;
  if (!container) return;
  if (!unmatched.length) {
    container.classList.add('hidden');
    container.replaceChildren();
    return;
  }
  const message = document.createElement('p');
  message.className = 'status-alert-empty';
  message.textContent = unmatched.length + (unmatched.length === 1 ? ' NWS alert' : ' NWS alerts') +
    ' could not be matched to a county and ' + (unmatched.length === 1 ? 'is' : 'are') +
    ' not included in county totals or the map. Check the official details:';
  const list = document.createElement('ul');
  list.className = 'status-unmatched-list';
  unmatched.forEach(function (alert) {
    const item = document.createElement('li');
    const url = safeUrl(alert.sourceUrl);
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = alert.event + ' \u2014 ' + alert.areaDescription + ' (official NWS details)';
      item.append(link);
    } else {
      item.textContent = alert.event + ' \u2014 ' + alert.areaDescription;
    }
    list.append(item);
  });
  container.replaceChildren(message, list);
  container.classList.remove('hidden');
}

function renderSourceState(powerFreshness, weatherFreshness, powerSource, weatherSource) {
  const freshnessRank = { fresh: 0, stale: 1, unavailable: 2 };
  const overall = freshnessRank[powerFreshness] >= freshnessRank[weatherFreshness] ? powerFreshness : weatherFreshness;
  statusEl.overallStatusPill.dataset.state = overall;
  statusEl.overallStatusPill.textContent = overall === 'fresh' ? 'Sources current' : overall === 'stale' ? 'Some data stale' : 'Updates unavailable';

  if (overall === 'fresh') {
    statusEl.sourceNotice.classList.add('hidden');
    statusEl.sourceNotice.textContent = '';
  } else {
    statusEl.sourceNotice.classList.remove('hidden');
    statusEl.sourceNotice.dataset.state = overall;
    statusEl.sourceNotice.textContent = overall === 'stale'
      ? 'Some information is older than its freshness window. Last-known values are labeled and should not be treated as current.'
      : 'One or more sources cannot confirm current conditions. Last-known values remain visible and are not an all-clear.';
  }

  renderSourceParagraph(statusEl.powerSourceStatus, 'NC Emergency Management power data', powerFreshness, powerSource,
    statusState.snapshotCheckedAt ? 'Snapshot last checked ' + formatAge(statusState.snapshotCheckedAt) + '. ' : '');
  renderSourceParagraph(statusEl.weatherSourceStatus, 'National Weather Service alerts', weatherFreshness, weatherSource);
}

function renderSourceParagraph(element, label, freshness, source, extra) {
  const text = document.createTextNode(label + ': ' + freshness + ', last successful update ' + formatAge(source && source.lastSuccessAt) + '. ' + (extra || ''));
  const url = safeUrl(source && source.sourceUrl);
  if (!url) {
    element.replaceChildren(text);
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'Open source';
  element.replaceChildren(text, link);
}

function renderWarningBanner(alerts, weatherFreshness) {
  const warnings = alerts.filter(function (alert) {
    return alert.status === 'Actual' && (alert.event === 'Tornado Warning' || alert.event === 'Flash Flood Warning');
  });
  if (!warnings.length) {
    statusEl.warningBanner.classList.add('hidden');
    statusEl.warningBanner.replaceChildren();
    return;
  }

  const content = document.createElement('div');
  content.className = 'warning-banner-content';
  const title = document.createElement('strong');
  title.textContent = warnings.map(function (warning) { return warning.event; }).join(' · ');
  const headline = document.createElement('span');
  headline.textContent = warnings[0].headline;
  const link = document.createElement('a');
  link.href = '#weatherDetails';
  link.textContent = 'Review county warning details';
  content.append(title, headline, link);
  if (weatherFreshness !== 'fresh') {
    const stale = document.createElement('span');
    stale.textContent = 'Updates are currently ' + weatherFreshness + '; confirm with official alerts.';
    content.append(stale);
  }
  statusEl.warningBanner.replaceChildren(content);
  statusEl.warningBanner.classList.remove('hidden');
}

function renderCountySelection() {
  statusEl.countyList.querySelectorAll('button[data-fips]').forEach(function (button) {
    button.setAttribute('aria-pressed', String(button.dataset.fips === statusState.selectedFips));
  });
}

function initializeCountyMap(geometry) {
  if (typeof L === 'undefined') {
    showMapFallback();
    return;
  }
  if (statusState.map) return;

  statusEl.map.classList.remove('hidden');
  statusEl.mapLegend.classList.remove('hidden');
  statusEl.mapFallback.classList.add('hidden');

  statusState.map = L.map(statusEl.map, {
    minZoom: 5,
    maxZoom: 12,
    scrollWheelZoom: false,
    zoomControl: true
  });

  L.tileLayer(USGS_BASEMAP_URL, {
    attribution: 'Basemap: USGS',
    maxNativeZoom: 16,
    maxZoom: 16
  }).addTo(statusState.map);

  statusState.mapLayer = L.geoJSON(geometry, {
    style: countyFeatureStyle,
    onEachFeature: function (feature, layer) {
      const fips = String(feature.properties.GEOID || '');
      const county = COUNTY_BY_FIPS.get(fips);
      if (!county) return;
      statusState.countyLayers.set(fips, layer);
      layer.bindTooltip(county.name + ' County', { sticky: true });
      layer.on('click', function () {
        selectCounty(fips, county.name + ' County selected from the map.');
      });
      layer.on('add', function () {
        const node = layer.getElement && layer.getElement();
        if (!node) return;
        node.setAttribute('tabindex', '0');
        node.setAttribute('role', 'button');
        node.setAttribute('aria-label', 'Select ' + county.name + ' County on the map');
        node.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectCounty(fips, county.name + ' County selected from the map.');
          }
        });
      });
    }
  }).addTo(statusState.map);

  const bounds = statusState.mapLayer.getBounds();
  statusState.map.fitBounds(bounds, { padding: [12, 12] });
  statusState.map.setMaxBounds(bounds.pad(0.4));
  renderCountyMap();
}

function showMapFallback() {
  statusEl.map.classList.add('hidden');
  statusEl.mapLegend.classList.add('hidden');
  statusEl.mapFallback.classList.remove('hidden');
}

function setMapLayer(layer) {
  if (layer !== 'power' && layer !== 'weather') return;
  statusState.activeLayer = layer;
  statusEl.powerLayerButton.classList.toggle('active', layer === 'power');
  statusEl.powerLayerButton.setAttribute('aria-pressed', String(layer === 'power'));
  statusEl.weatherLayerButton.classList.toggle('active', layer === 'weather');
  statusEl.weatherLayerButton.setAttribute('aria-pressed', String(layer === 'weather'));
  renderCountyMap();
}

function countyFeatureStyle(feature) {
  const fips = String(feature.properties && feature.properties.GEOID || '');
  const band = mapBandForCounty(fips);
  const selected = fips === statusState.selectedFips;
  return {
    color: selected ? cssValue('--status-map-selected') : 'rgba(235, 243, 251, 0.82)',
    fillColor: cssValue('--status-map-' + band),
    fillOpacity: band === 'unknown' ? 0.48 : 0.76,
    weight: selected ? 4 : 1.15
  };
}

function mapBandForCounty(fips) {
  const freshness = mapFreshnessForLayer();
  if (freshness === 'unavailable') return 'unknown';
  let band;
  if (statusState.activeLayer === 'power') {
    const record = getCountyPower(fips);
    band = record ? powerBand(Number(record.customersOut)) : 'unknown';
  } else if (!statusState.snapshot && statusState.liveAlerts === null) {
    band = 'unknown';
  } else {
    band = weatherBand(alertsForCounty(getVisibleAlerts(), fips, Date.now()));
  }
  // A stale source cannot confirm "none", so the all-clear band is withheld.
  return freshness === 'stale' && band === 'none' ? 'unknown' : band;
}

function mapFreshnessForLayer() {
  return statusState.activeLayer === 'power'
    ? deriveFreshness(getPowerSource(), POWER_FRESH_MS, POWER_STALE_MS, Date.now())
    : deriveFreshness(getWeatherSource(), WEATHER_FRESH_MS, WEATHER_STALE_MS, Date.now());
}

function renderCountyMap() {
  renderMapLegend();
  if (!statusState.mapLayer) return;
  statusState.mapLayer.eachLayer(function (layer) {
    if (layer.feature) layer.setStyle(countyFeatureStyle(layer.feature));
  });
  const selectedLayer = statusState.countyLayers.get(statusState.selectedFips);
  if (selectedLayer && selectedLayer.bringToFront) selectedLayer.bringToFront();
}

function renderMapLegend() {
  const powerItems = [
    ['none', '0 reported'],
    ['low', '1–99'],
    ['elevated', '100–999'],
    ['major', '1,000+'],
    ['unknown', 'No current data']
  ];
  const weatherItems = [
    ['none', 'No active alerts'],
    ['low', 'Minor / unknown'],
    ['elevated', 'Moderate'],
    ['major', 'Severe / extreme'],
    ['unknown', 'No current data']
  ];
  const items = statusState.activeLayer === 'power' ? powerItems : weatherItems;
  const fragment = document.createDocumentFragment();
  const title = document.createElement('strong');
  title.textContent = statusState.activeLayer === 'power' ? 'Customers without power' : 'Highest alert severity';
  fragment.append(title);
  items.forEach(function (item) {
    const row = document.createElement('span');
    row.className = 'status-legend-item';
    const swatch = document.createElement('i');
    swatch.className = 'status-legend-swatch';
    swatch.style.background = cssValue('--status-map-' + item[0]);
    swatch.setAttribute('aria-hidden', 'true');
    row.append(swatch, document.createTextNode(item[1]));
    fragment.append(row);
  });
  statusEl.mapLegend.replaceChildren(fragment);
  statusEl.mapLegend.setAttribute('aria-label', title.textContent + ' legend');
  const freshness = mapFreshnessForLayer();
  const currentNote = statusState.activeLayer === 'power'
    ? 'Map colors use fixed reported-customer bands, so they remain comparable between updates.'
    : 'Map colors show the highest active NWS alert severity applying to each county.';
  const staleNote = statusState.activeLayer === 'power'
    ? 'Map colors show last-known reported-customer bands; the power source is stale, so counties with no reported outages are shown as no current data.'
    : 'Map colors show last-known alert severity; the weather source is stale, so counties without alerts are shown as no current data.';
  const unavailableNote = statusState.activeLayer === 'power'
    ? 'Current power map data is unavailable, so counties are shown as no current data.'
    : 'Current weather map data is unavailable, so counties are shown as no current data.';
  statusEl.mapNote.textContent = (freshness === 'fresh' ? currentNote : freshness === 'stale' ? staleNote : unavailableNote) +
    ' The county list provides equivalent navigation.';
}

function cssValue(name) {
  if (!document.documentElement || !window.getComputedStyle) return '#61758a';
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#61758a';
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = window.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
  const external = options && options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', function () { controller.abort(); });
  }
  const config = Object.assign({}, options || {}, { signal: controller.signal });
  try {
    const response = await fetch(url, config);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function freshnessLabel(freshness, source) {
  const prefix = freshness === 'fresh' ? 'Current' : freshness === 'stale' ? 'Stale' : 'Unavailable';
  return prefix + ' · ' + formatAge(source && source.lastSuccessAt);
}

function formatAge(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 'no successful update';
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  return hours + ' hr' + (hours === 1 ? '' : 's') + ' ago';
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'time unavailable';
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function validIso(value) {
  const date = new Date(String(value || ''));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function setStatusMessage(message) {
  statusEl.statusMessage.textContent = message;
}

function setRefreshLoading(loading) {
  statusEl.refreshButton.disabled = loading;
  statusEl.refreshButton.style.opacity = loading ? '0.55' : '1';
}

let statusToastTimer = 0;
function showToast(message) {
  window.clearTimeout(statusToastTimer);
  statusEl.toast.textContent = message;
  statusEl.toast.classList.add('show');
  statusToastTimer = window.setTimeout(function () {
    statusEl.toast.classList.remove('show');
  }, 5200);
}
