/* Pure helpers for the Severe Weather Mode dashboard.
 * Classic script usable as a browser global (globalThis.NwsSevereWeather) and a CommonJS module.
 * No DOM access and no network requests: callers pass NWS data in and render the results. */
(function (root) {
  'use strict';

  const OFFICIAL_URL_PREFIX = 'https://api.weather.gov/';
  const NC_STATE_FIPS = '37';

  // Mirrors status.js: POWER_FRESH_MS = 45 * 60 * 1000 (line 14) and POWER_STALE_MS = 60 * 60 * 1000 (line 15),
  // applied by deriveFreshness() (status.js:623-631) to snapshot.sources.power.lastSuccessAt.
  const POWER_FRESH_MS = 45 * 60 * 1000;
  const POWER_STALE_MS = 60 * 60 * 1000;

  const WARNING_PRIORITY = [
    'Tornado Warning', 'Extreme Wind Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning',
    'Hurricane Warning', 'Storm Surge Warning', 'Tropical Storm Warning', 'Blizzard Warning',
    'Ice Storm Warning', 'Winter Storm Warning'
  ];

  const PARAMETER_KEYS = ['tornadoDetection', 'maxHailSize', 'maxWindGust', 'thunderstormDamageThreat', 'flashFloodDamageThreat'];

  // NWS county zone state abbreviation -> state FIPS (only confident, standard assignments).
  const STATE_FIPS = {
    AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12',
    GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23',
    MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33',
    NJ: '34', NM: '35', NY: '36', NC: NC_STATE_FIPS, ND: '38', OH: '39', OK: '40', OR: '41', PA: '42',
    RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
    WI: '55', WY: '56'
  };

  const numberFormatter = new Intl.NumberFormat('en-US');

  function cleanText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // Keeps NWS text verbatim (only checks type and non-emptiness).
  function verbatim(value) {
    return typeof value === 'string' && value.trim() ? value : '';
  }

  function validOfficialUrl(value) {
    const text = cleanText(value);
    if (!text.startsWith(OFFICIAL_URL_PREFIX) || text.length === OFFICIAL_URL_PREFIX.length || /\s/.test(text)) return '';
    try {
      const url = new URL(text);
      return url.protocol === 'https:' && url.hostname === 'api.weather.gov' && !url.username && !url.password ? text : '';
    } catch (error) {
      return '';
    }
  }

  function firstParameter(parameters, key) {
    const values = parameters && typeof parameters === 'object' ? parameters[key] : null;
    if (!Array.isArray(values)) return '';
    const found = values.find(function (item) { return typeof item === 'string' && item.trim(); });
    return found ? found.trim() : '';
  }

  // Same active rule as app.js isActiveAlert/getThreatWarnings: Actual, not Cancel, ends||expires in the future,
  // and effective/onset missing or already reached.
  function isActiveWarning(props, nowMs) {
    if (!props || props.status !== 'Actual' || props.messageType === 'Cancel') return false;
    const expiry = Date.parse(props.ends || props.expires);
    if (!Number.isFinite(expiry) || expiry <= nowMs) return false;
    const effective = Date.parse(props.effective);
    if (Number.isFinite(effective) && effective > nowMs) return false;
    const onset = Date.parse(props.onset);
    return !Number.isFinite(onset) || onset <= nowMs;
  }

  function warningRank(event) {
    const index = WARNING_PRIORITY.indexOf(event);
    return index === -1 ? WARNING_PRIORITY.length : index;
  }

  function normalizeAlert(feature) {
    const props = feature && typeof feature === 'object' ? feature.properties : null;
    if (!props || typeof props !== 'object') return null;
    const event = cleanText(props.event);
    const endsAt = cleanText(props.ends) || cleanText(props.expires);
    const alert = {
      id: cleanText(props['@id']) || cleanText(props.id) || cleanText(feature.id),
      event: event,
      headline: verbatim(props.headline),
      severity: cleanText(props.severity),
      urgency: cleanText(props.urgency),
      certainty: cleanText(props.certainty),
      areaDesc: verbatim(props.areaDesc),
      senderName: cleanText(props.senderName),
      sent: cleanText(props.sent),
      effective: cleanText(props.effective),
      onset: cleanText(props.onset),
      expires: cleanText(props.expires),
      ends: cleanText(props.ends),
      endsAt: endsAt,
      description: verbatim(props.description),
      instruction: verbatim(props.instruction),
      officialUrl: validOfficialUrl(props['@id']) || validOfficialUrl(feature.id) || validOfficialUrl(props.id)
    };
    PARAMETER_KEYS.forEach(function (key) { alert[key] = firstParameter(props.parameters, key); });
    return alert;
  }

  // Active warnings (any "... Warning" event) for the severe dashboard, highest priority first, then soonest expiry.
  function selectSevereAlerts(features, nowMs) {
    if (!Array.isArray(features)) return [];
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const seen = new Set();
    return features.filter(function (feature) {
      const props = feature && feature.properties;
      return props && typeof props.event === 'string' && /Warning$/.test(props.event.trim()) && isActiveWarning(props, now);
    }).map(normalizeAlert).filter(function (alert) {
      if (!alert || !alert.id || seen.has(alert.id)) return false;
      seen.add(alert.id);
      return true;
    }).sort(function (a, b) {
      return warningRank(a.event) - warningRank(b.event) || Date.parse(a.endsAt) - Date.parse(b.endsAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }

  // Stable identity of a warning set, used to remember a dismissed/minimized dashboard.
  function severeModeKey(alerts) {
    if (!Array.isArray(alerts)) return '';
    return alerts.map(function (alert) { return alert && cleanText(alert.id); })
      .filter(Boolean).sort().join('|');
  }

  function countyFipsFromPoint(pointProperties) {
    const url = pointProperties && typeof pointProperties.county === 'string' ? pointProperties.county : '';
    const match = /^https:\/\/api\.weather\.gov\/zones\/county\/([A-Z]{2})C(\d{3})\/?$/.exec(url.trim());
    if (!match || !STATE_FIPS[match[1]]) return '';
    return STATE_FIPS[match[1]] + match[2];
  }

  function isNorthCarolinaFips(fips) {
    return typeof fips === 'string' && /^37\d{3}$/.test(fips);
  }

  // Same thresholds and rule as status.js deriveFreshness() for the power source.
  function powerFreshness(source, nowMs) {
    if (!source || !source.lastSuccessAt) return 'unavailable';
    const timestamp = Date.parse(source.lastSuccessAt);
    if (!Number.isFinite(timestamp)) return 'unavailable';
    const age = Math.max(0, (Number.isFinite(nowMs) ? nowMs : Date.now()) - timestamp);
    if (age <= POWER_FRESH_MS) return 'fresh';
    if (age <= POWER_STALE_MS) return 'stale';
    return 'unavailable';
  }

  function countyOutageFromSnapshot(snapshot, fips, nowMs) {
    if (!isNorthCarolinaFips(fips)) {
      return { supported: false, countyName: '', customersOut: null, asOf: '', freshness: 'unavailable', sourceName: '', sourceUrl: '' };
    }
    const sources = snapshot && typeof snapshot === 'object' && snapshot.sources;
    const source = sources && typeof sources === 'object' ? sources.power : null;
    const records = snapshot && Array.isArray(snapshot.power) ? snapshot.power : [];
    const record = records.find(function (item) { return item && item.countyFips === fips; });
    const name = record ? cleanText(record.countyName) : '';
    const result = {
      supported: true,
      countyName: name ? (/ County$/i.test(name) ? name : name + ' County') : '',
      customersOut: null,
      asOf: '',
      freshness: 'unavailable',
      sourceName: source && cleanText(source.name) || 'NC Emergency Management',
      sourceUrl: source ? validHttpsUrl(source.sourceUrl) : ''
    };
    if (!record || !Number.isInteger(record.customersOut) || record.customersOut < 0) return result;
    // Like status.js, an out-of-date source with a known county value keeps the last-known value and as-of time
    // (freshness 'unavailable' = "current update unavailable"). Without a parseable as-of time there is no value.
    if (!source || !Number.isFinite(Date.parse(source.lastSuccessAt))) return result;
    result.freshness = powerFreshness(source, nowMs);
    result.customersOut = record.customersOut;
    result.asOf = source.lastSuccessAt;
    return result;
  }

  function validHttpsUrl(value) {
    const text = cleanText(value);
    try {
      return new URL(text).protocol === 'https:' ? text : '';
    } catch (error) {
      return '';
    }
  }

  function formatOutageSummary(outage, formatTime) {
    if (!outage || !outage.supported) return 'Power outage data is available for North Carolina locations only.';
    const county = outage.countyName || 'this county';
    if (!Number.isFinite(outage.customersOut) || !outage.asOf) {
      return 'Outage data for ' + county + ' is unavailable right now.';
    }
    const time = typeof formatTime === 'function' ? formatTime(outage.asOf) : outage.asOf;
    const count = numberFormatter.format(outage.customersOut);
    const noun = outage.customersOut === 1 ? 'customer' : 'customers';
    // Wording mirrors status.js metricSummary().
    if (outage.freshness === 'stale' || outage.freshness === 'unavailable') {
      return 'Last known: ' + count + ' ' + noun + ' without power in ' + county + ' as of ' + time +
        (outage.freshness === 'stale' ? ' \u2014 data is stale' : ' \u2014 current update unavailable');
    }
    if (outage.customersOut === 0) return 'No reported outages in ' + county + ' as of ' + time;
    return count + ' ' + noun + ' without power in ' + county + ' (' + (outage.sourceName || 'NC Emergency Management') + ', as of ' + time + ')';
  }

  function relativeDuration(minutes) {
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours + ' hr' + (rest ? ' ' + rest + ' min' : '');
  }

  function formatExpiry(endsAtIso, nowMs, formatTime) {
    const ends = Date.parse(endsAtIso);
    if (!Number.isFinite(ends)) return 'Expiry not specified';
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (ends <= now) return 'Expired';
    const minutes = Math.max(1, Math.ceil((ends - now) / 60000));
    const time = typeof formatTime === 'function' ? formatTime(endsAtIso) : endsAtIso;
    return 'Expires ' + time + ' (in ' + relativeDuration(minutes) + ')';
  }

  const api = {
    WARNING_PRIORITY: WARNING_PRIORITY,
    POWER_FRESH_MS: POWER_FRESH_MS,
    POWER_STALE_MS: POWER_STALE_MS,
    countyFipsFromPoint: countyFipsFromPoint,
    countyOutageFromSnapshot: countyOutageFromSnapshot,
    formatExpiry: formatExpiry,
    formatOutageSummary: formatOutageSummary,
    isNorthCarolinaFips: isNorthCarolinaFips,
    selectSevereAlerts: selectSevereAlerts,
    severeModeKey: severeModeKey
  };

  root.NwsSevereWeather = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
