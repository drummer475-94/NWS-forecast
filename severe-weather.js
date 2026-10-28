/* Pure helpers for the Severe Weather Mode dashboard.
 * Classic script usable as a browser global (globalThis.NwsSevereWeather) and a CommonJS module.
 * No DOM access and no network requests: callers pass NWS data in and render the results. */
(function (root) {
  'use strict';

  const OFFICIAL_URL_PREFIX = 'https://api.weather.gov/';

  const WARNING_PRIORITY = [
    'Tornado Warning', 'Extreme Wind Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning',
    'Hurricane Warning', 'Storm Surge Warning', 'Tropical Storm Warning', 'Blizzard Warning',
    'Ice Storm Warning', 'Winter Storm Warning'
  ];

  const PARAMETER_KEYS = ['tornadoDetection', 'maxHailSize', 'maxWindGust', 'thunderstormDamageThreat', 'flashFloodDamageThreat'];

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
    formatExpiry: formatExpiry,
    selectSevereAlerts: selectSevereAlerts,
    severeModeKey: severeModeKey
  };

  root.NwsSevereWeather = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
