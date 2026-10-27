/*!
 * temperature-tile-card — carte Home Assistant AUTONOME.
 * Tuile « valeur + libellé » teintée par une échelle de température : absolue (seuils réglables)
 * OU relative « maison » (min→max de capteurs/zones de référence). La valeur affichée est celle
 * d'un capteur dédié, ou — à défaut — la MOYENNE des références (cas « Maison »). Un indicateur
 * animé signale la chauffe (climate, capteur binaire ou intensité 0–100 %).
 *
 * 100 % indépendante : embarque son propre moteur d'échelle, aucune dépendance à une autre carte.
 *
 * Ressource Lovelace de type « module ».
 */

const CARD_VERSION = '1.0.0';
const DEFAULT_HEATING_ICON = 'mdi:radiator';

/* ===========================================================================
 * Moteur d'échelle de couleur (copie autonome).
 * ==========================================================================*/

const numberValue = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// chaîne non vide -> id d'entité, sinon undefined (=> pas de source dédiée)
const configEntity = (value) => (typeof value === 'string' && value ? value : undefined);

const REFERENCE_REFRESH_MS = 30000; // recalcul des références throttlé à 30 s

const escapeXml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const mixRgb = (from, to, progress) =>
  `rgb(${from.map((value, index) =>
    Math.round(value + (to[index] - value) * progress)).join(',')})`;

const DEFAULT_TEMPERATURE_SCALE = { min: -5, mid: 15, max: 35 };            // seuils absolus (°C)
const DEFAULT_TEMPERATURE_COLORS = { cool: [93, 165, 206], neutral: [238, 230, 199], warm: [224, 112, 91] };

// accepte [r,g,b] (sélecteur color_rgb), "#rrggbb" ou "r,g,b" ; sinon null (=> défaut)
const parseRgb = (value) => {
  if (Array.isArray(value) && value.length === 3 && value.every((v) => Number.isFinite(Number(v)))) return value.map((v) => Number(v));
  if (typeof value !== 'string') return null;
  const hex = value.trim().match(/^#?([0-9a-f]{6})$/i);
  if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const csv = value.split(',').map((v) => Number(v.trim()));
  return csv.length === 3 && csv.every((v) => Number.isFinite(v)) ? csv : null;
};

// échelle absolue : seuils min/mid/max + couleurs cool/neutral/warm (défauts si absents)
const temperatureFill = (temperature, cfg) => {
  if (temperature === null) return 'rgba(127,127,127,.14)';
  const min = Number.isFinite(cfg?.min) ? cfg.min : DEFAULT_TEMPERATURE_SCALE.min;
  const mid = Number.isFinite(cfg?.mid) ? cfg.mid : DEFAULT_TEMPERATURE_SCALE.mid;
  const max = Number.isFinite(cfg?.max) ? cfg.max : DEFAULT_TEMPERATURE_SCALE.max;
  const cool = parseRgb(cfg?.cool) ?? DEFAULT_TEMPERATURE_COLORS.cool;
  const neutral = parseRgb(cfg?.neutral) ?? DEFAULT_TEMPERATURE_COLORS.neutral;
  const warm = parseRgb(cfg?.warm) ?? DEFAULT_TEMPERATURE_COLORS.warm;
  return temperature <= mid
    ? mixRgb(cool, neutral, clamp01((temperature - min) / ((mid - min) || 1)))
    : mixRgb(neutral, warm, clamp01((temperature - mid) / ((max - mid) || 1)));
};

const TECHNICAL_TEMPERATURE = /(device_temperature|cputemp|cpu_temperature|temperature_du_(congelateur|frigo)|temperature_de_la_batterie|shellydimmer|tado_smart_radiator|tempgpu|temperature_gpu|actual_(bed|tool)|target_.*temp|temperature_slope|derivee_temperature)/i;
const MAX_REFERENCE_AGE_MS = 2 * 60 * 60 * 1000;

// température d'une entité : weather (attr) / climate (current_temperature) / sensor (state ou attr)
const entityTemperature = (hass, entityId) => {
  const state = hass?.states?.[entityId];
  if (!state || state.state === 'unknown' || state.state === 'unavailable') return null;
  const attributes = state.attributes ?? {};
  if (entityId.startsWith('weather.')) return numberValue(attributes.temperature);
  if (entityId.startsWith('climate.')) return numberValue(attributes.current_temperature);
  return numberValue(state.state) ?? numberValue(attributes.temperature);
};

// températures de référence (échelle relative « maison ») : entités explicites + capteurs des zones,
// moyennés par appareil puis par zone (filtre les capteurs techniques, °C, fraîcheur < 2 h).
const referenceTemperatures = (hass, temperatureColor) => {
  const values = [];
  const explicit = Array.isArray(temperatureColor?.reference_entities) ? temperatureColor.reference_entities : [];
  for (const entityId of explicit) {
    const value = entityTemperature(hass, entityId);
    if (value !== null) values.push(value);
  }
  const areas = new Set(Array.isArray(temperatureColor?.reference_areas) ? temperatureColor.reference_areas : []);
  if (!areas.size) return values;
  const entityRegistry = hass?.entities ?? {};
  const deviceRegistry = hass?.devices ?? {};
  const areaItems = new Map([...areas].map((areaId) => [areaId, []]));
  for (const [entityId, state] of Object.entries(hass?.states ?? {})) {
    if (!entityId.startsWith('sensor.') || TECHNICAL_TEMPERATURE.test(entityId)) continue;
    const attributes = state?.attributes ?? {};
    if (attributes.device_class !== 'temperature' || attributes.unit_of_measurement !== '°C') continue;
    const registry = entityRegistry[entityId] ?? {};
    if (registry.hidden_by || registry.entity_category || attributes.entity_category) continue;
    const areaId = registry.area_id || deviceRegistry[registry.device_id]?.area_id;
    if (!areas.has(areaId)) continue;
    const updatedAt = Date.parse(state.last_updated || state.last_changed || '');
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > MAX_REFERENCE_AGE_MS) continue;
    const value = numberValue(state.state);
    if (value === null || value < -40 || value > 60) continue;
    areaItems.get(areaId).push({ value, source: registry.device_id || entityId.replace(/_\d+$/, '') });
  }
  for (const items of areaItems.values()) {
    const bySource = new Map();
    for (const item of items) {
      if (!bySource.has(item.source)) bySource.set(item.source, []);
      bySource.get(item.source).push(item.value);
    }
    const sourceMeans = [...bySource.values()].map((sourceValues) =>
      sourceValues.reduce((sum, value) => sum + value, 0) / sourceValues.length);
    if (sourceMeans.length) {
      values.push(sourceMeans.reduce((sum, value) => sum + value, 0) / sourceMeans.length);
    }
  }
  return values;
};

// échelle relative : position de la valeur entre min et max des références
const relativeTemperatureFill = (temperature, references, cfg) => {
  if (temperature === null) return 'rgba(127,127,127,.14)';
  if (!references.length) return temperatureFill(temperature, cfg);
  const min = Math.min(...references);
  const max = Math.max(...references);
  const spread = max - min;
  if (spread < 0.15) return 'rgb(221,218,207)';
  const position = clamp01((temperature - min) / spread);
  const cool = parseRgb(cfg?.cool) ?? DEFAULT_TEMPERATURE_COLORS.cool;
  const neutral = parseRgb(cfg?.neutral) ?? DEFAULT_TEMPERATURE_COLORS.neutral;
  const warm = parseRgb(cfg?.warm) ?? DEFAULT_TEMPERATURE_COLORS.warm;
  return position <= 0.5
    ? mixRgb(cool, neutral, position * 2)
    : mixRgb(neutral, warm, (position - 0.5) * 2);
};

/* ===========================================================================
 * Rendu SVG de la tuile.
 * ==========================================================================*/

// rect teinté plein cadre + valeur + libellé. Texte contrasté sur la luminance du fond
// (fond translucide « indispo » => suit le thème). Auto-fit : police réduite si le texte
// déborde de la largeur — jamais de troncature. Dessin dans un repère w×h, le wrapper étire sans distorsion.
function temperatureTile(value, label, w, h, fill, sfx, precision) {
  const p = Number.isInteger(precision) ? Math.max(0, Math.min(3, precision)) : 1;
  const valueText = value == null ? '—' : `${value.toFixed(p)}°`;
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(fill || '');
  const faded = !rgb || (rgb[4] !== undefined && Number(rgb[4]) < 0.5);
  const lum = rgb ? (0.299 * +rgb[1] + 0.587 * +rgb[2] + 0.114 * +rgb[3]) / 255 : 1;
  const lightTxt = !faded && lum <= 0.6;          // fond foncé (bleu/corail saturé) => texte clair
  const txt = faded ? 'var(--primary-text-color)' : (lightTxt ? '#f2f5fb' : '#16232e');
  const sub = faded ? 'var(--secondary-text-color)' : (lightTxt ? '#ced7e6' : '#33414c');
  const halo = faded ? null : (lightTxt ? 'rgba(6,9,20,.45)' : 'rgba(255,255,255,.4)');
  const big = h >= 60;
  const rx = big ? 17 : 12;
  const cx = (w / 2).toFixed(1);
  // auto-fit : largeur estimée sans DOM (facteur de glyphe moyen + letter-spacing), marge 12 %, plancher 6 px
  const fitFont = (text, baseFs, ls, charFactor) => {
    const maxW = w * 0.88;
    const est = text.length * (charFactor * baseFs + ls);
    return est <= maxW ? baseFs : Math.max(6, (maxW / text.length - ls) / charFactor);
  };
  const fv = fitFont(valueText, big ? 26 : 20, 0, 0.58);   // valeur (chiffres étroits)
  const fl = fitFont(label, big ? 10.5 : 9, 0.6, 0.66);    // libellé (capitales larges + letter-spacing)
  const yv = (h * 0.46).toFixed(1);
  const yl = (h * 0.74).toFixed(1);
  const hw = big ? 0.6 : 0.5;
  const stroke = halo ? ` paint-order="stroke" stroke="${halo}" stroke-width="${hw}" stroke-linejoin="round"` : '';
  return `
      <defs><clipPath id="tt-clip-${sfx}"><rect width="${w}" height="${h}" rx="${rx}"/></clipPath></defs>
      <g clip-path="url(#tt-clip-${sfx})">
        <rect width="${w}" height="${h}" fill="${fill}"/>
        <text x="${cx}" y="${yv}" font-size="${fv.toFixed(2)}" font-weight="600" text-anchor="middle" fill="${txt}"${stroke}>${valueText}</text>
        <text x="${cx}" y="${yl}" font-size="${fl.toFixed(2)}" font-weight="600" letter-spacing=".6" text-anchor="middle" fill="${sub}"${stroke}>${label}</text>
      </g>`;
}

/* ===========================================================================
 * Carte.
 * ==========================================================================*/

class TemperatureTileCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement('temperature-tile-card-editor');
  }

  static getStubConfig(hass) {
    const tempSensor = hass
      ? Object.keys(hass.states || {}).find((id) =>
          id.startsWith('sensor.') && hass.states[id]?.attributes?.device_class === 'temperature')
      : undefined;
    return {
      name: 'Maison',
      height: 74,
      temperature_entity: tempSensor || 'sensor.temperature',
      temperature_color: { mode: 'absolute' },
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._width = 0;
    this._stateSignature = '';
    this._resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (width > 0 && Math.abs(width - this._width) > 1) {
        this._width = width;
        this._render();
      }
    }) : null;
    this._pointerDown = this._pointerDown.bind(this);
    this._pointerUp = this._pointerUp.bind(this);
    this._pointerCancel = this._pointerCancel.bind(this);
    this._keydown = this._keydown.bind(this);
  }

  // Contrat HA : throw sur config invalide -> HA affiche une carte d'erreur.
  setConfig(config) {
    const requestedHeight = Number(config?.height);
    const temperatureColor = config?.temperature_color ?? {};
    const colorMode = temperatureColor.mode ?? 'absolute';
    if (!['absolute', 'relative'].includes(colorMode)) {
      throw new Error('temperature_color.mode doit valoir « absolute » ou « relative ».');
    }
    const referenceEntities = Array.isArray(temperatureColor.reference_entities)
      ? [...new Set(temperatureColor.reference_entities.filter((id) => typeof id === 'string'))]
      : [];
    const referenceAreas = Array.isArray(temperatureColor.reference_areas)
      ? [...new Set(temperatureColor.reference_areas.filter((id) => typeof id === 'string'))]
      : [];
    const temperatureEntity = configEntity(config?.temperature_entity);
    const configuredClimateEntity = configEntity(config?.climate_entity);
    if (configuredClimateEntity && !configuredClimateEntity.startsWith('climate.')) {
      throw new Error('« climate_entity » doit être une entité climate.*.');
    }
    const climateEntity = configuredClimateEntity
      ?? (temperatureEntity?.startsWith('climate.') ? temperatureEntity : undefined);
    // Il faut au moins une source de valeur : capteur dédié OU des références (dont on prend la moyenne).
    if (!temperatureEntity && !referenceEntities.length && !referenceAreas.length) {
      throw new Error('Renseignez une source de température : « temperature_entity » ou des références (« reference_entities » / « reference_areas »).');
    }
    if (colorMode === 'relative' && !referenceEntities.length && !referenceAreas.length) {
      throw new Error('L’échelle relative nécessite « reference_entities » ou « reference_areas ».');
    }
    this._config = {
      ...config,
      name: config?.name ?? 'Maison',
      height: Number.isFinite(requestedHeight) ? Math.max(48, requestedHeight) : 74, // plancher 48 px, pas de plafond
      temperature_entity: temperatureEntity,          // source de la valeur ; vide => moyenne des références
      climate_entity: climateEntity,                  // climate maître ; par défaut, la source de température si c'est un climate
      heating_entity: configEntity(config?.heating_entity), // remplacement optionnel : binaire, climate ou valeur numérique > 0
      heating_icon: configEntity(config?.heating_icon) ?? DEFAULT_HEATING_ICON,
      tap_action: config?.tap_action ?? { action: 'more-info' },
      temperature_color: {
        ...temperatureColor,
        mode: colorMode,
        reference_entities: referenceEntities,
        reference_areas: referenceAreas,
      },
    };
    this._stateSignature = '';
    this._references = undefined;
    this._referencesAt = 0;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const color = this._config?.temperature_color;
    const needsReferences = !!(color && (color.reference_entities.length || color.reference_areas.length));
    // Les références servent à l'échelle relative ET (sans capteur dédié) à la moyenne affichée.
    // referenceTemperatures boucle sur tous les états -> throttle à 30 s (températures lentes).
    if (needsReferences) {
      const now = Date.now();
      if (this._references === undefined || now - this._referencesAt > REFERENCE_REFRESH_MS) {
        this._references = referenceTemperatures(hass, color);
        this._referencesAt = now;
      }
    } else {
      this._references = [];
    }
    const value = this._config?.temperature_entity ? entityTemperature(hass, this._config.temperature_entity) : null;
    // re-render seulement si la donnée pertinente change
    const heatingId = this._heatingSourceId();
    const heatingState = heatingId ? hass?.states?.[heatingId] : null;
    const signature = JSON.stringify([
      value,
      this._references,
      heatingId,
      heatingState?.state,
      heatingState?.attributes?.hvac_action,
    ]);
    if (signature !== this._stateSignature) {
      this._stateSignature = signature;
      this._render();
    }
  }

  connectedCallback() {
    this._resizeObserver?.observe(this);
    // une donnée « périmée » ne génère pas de nouvel état -> on ré-évalue la fraîcheur périodiquement
    // (toggle de classe uniquement, pas de re-render).
    this._staleTimer = setInterval(() => this._refreshStale(), 30000);
    this._render();
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    clearInterval(this._staleTimer);
  }

  // masonry / vue par colonnes (fallback hors « sections »)
  getCardSize() {
    return Math.max(1, Math.round((this._config?.height ?? 74) / 50));
  }

  // vue « sections » (12 colonnes/section) : tuile compacte, largeur ajustable ; on n'impose PAS `rows`
  // -> la carte garde sa hauteur propre (option `height`) au lieu d'être étirée sur une rangée de grille.
  getGridOptions() {
    return { columns: 6, min_columns: 2 };
  }

  // valeur affichée : capteur dédié sinon moyenne des références (cas « Maison »)
  _value() {
    if (this._config?.temperature_entity) return entityTemperature(this._hass, this._config.temperature_entity);
    const refs = this._references || [];
    return refs.length ? refs.reduce((sum, v) => sum + v, 0) / refs.length : null;
  }

  _isStale() {
    const minutes = Number(this._config?.stale_after);
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    const id = this._config.stale_entity || this._config.temperature_entity;
    if (!id) return false;
    const st = this._hass?.states?.[id];
    if (!st) return false;
    const t = Date.parse(st.last_updated || st.last_changed || '');
    return Number.isFinite(t) && (Date.now() - t) > minutes * 60000;
  }

  _heatingSourceId() {
    return this._config?.heating_entity || this._config?.climate_entity;
  }

  _heatingStatus() {
    const id = this._heatingSourceId();
    const state = id ? this._hass?.states?.[id] : null;
    if (!state || state.state === 'unknown' || state.state === 'unavailable') {
      return { id, level: null, kind: 'missing' };
    }
    if (id.startsWith('climate.')) {
      return { id, level: state.attributes?.hvac_action === 'heating' ? 100 : 0, kind: 'binary' };
    }
    if (id.startsWith('binary_sensor.')) {
      return { id, level: state.state === 'on' ? 100 : 0, kind: 'binary' };
    }
    const numericState = numberValue(state.state);
    return {
      id,
      level: numericState === null ? null : clamp01(numericState / 100) * 100,
      kind: numericState === null ? 'missing' : 'numeric',
    };
  }

  _isHeating() {
    const level = this._heatingStatus().level;
    return level !== null && level > 0;
  }

  _refreshStale() {
    const card = this.shadowRoot?.querySelector('ha-card');
    if (card) card.classList.toggle('tt-stale', this._isStale());
  }

  // tap / hold / double_tap : more-info / navigate / url / toggle / perform-action
  _runAction(kind) {
    const cfg = this._config?.[kind === 'tap' ? 'tap_action' : kind === 'hold' ? 'hold_action' : 'double_tap_action'];
    const action = cfg?.action ?? (kind === 'tap' ? 'more-info' : 'none');
    if (action === 'none' || !this._hass) return;
    const target = cfg?.entity || this._config.tap_entity || this._config.temperature_entity;
    if (action === 'more-info' && !target) return; // pas d'entité (moyenne pure) -> rien à ouvrir
    switch (action) {
      case 'more-info':
        this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: target }, bubbles: true, composed: true }));
        break;
      case 'navigate':
        if (cfg?.navigation_path) {
          history.pushState(null, '', cfg.navigation_path);
          window.dispatchEvent(new Event('location-changed'));
        }
        break;
      case 'url':
        if (cfg?.url_path) window.open(cfg.url_path, cfg.new_tab === false ? '_self' : '_blank');
        break;
      case 'toggle':
        if (target) this._hass.callService('homeassistant', 'toggle', { entity_id: target });
        break;
      case 'perform-action':
      case 'call-service': {
        const perform = cfg?.perform_action || cfg?.service;
        if (perform && perform.includes('.')) {
          const [domain, ...rest] = perform.split('.');
          this._hass.callService(domain, rest.join('.'), cfg.data || cfg.service_data || {}, cfg.target);
        }
        break;
      }
    }
  }

  _pointerDown(event) {
    this._held = false;
    this._downXY = [event.clientX, event.clientY];
    clearTimeout(this._holdTimer);
    if (this._config?.hold_action && this._config.hold_action.action !== 'none') {
      this._holdTimer = setTimeout(() => { this._held = true; this._runAction('hold'); }, 500);
    }
  }

  _pointerUp(event) {
    clearTimeout(this._holdTimer);
    if (this._held) { this._held = false; return; }
    if (this._downXY && Math.hypot(event.clientX - this._downXY[0], event.clientY - this._downXY[1]) > 10) return; // scroll/drag
    const hasDouble = this._config?.double_tap_action && this._config.double_tap_action.action !== 'none';
    if (!hasDouble) { this._runAction('tap'); return; }
    const now = Date.now();
    if (this._lastTap && now - this._lastTap < 300) {
      clearTimeout(this._tapTimer);
      this._lastTap = 0;
      this._runAction('double_tap');
    } else {
      this._lastTap = now;
      clearTimeout(this._tapTimer);
      this._tapTimer = setTimeout(() => { this._lastTap = 0; this._runAction('tap'); }, 300);
    }
  }

  _pointerCancel() {
    clearTimeout(this._holdTimer);
    this._held = false;
  }

  _keydown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this._runAction('tap');
    }
  }

  _render() {
    if (!this._config || !this._hass || !this.shadowRoot) return;
    const value = this._value();
    const colorConfig = this._config.temperature_color;
    const references = this._references || [];
    const tempFill = colorConfig.mode === 'relative'
      ? relativeTemperatureFill(value, references, colorConfig)
      : temperatureFill(value, colorConfig);
    const precision = Number.isInteger(this._config.precision) ? Math.max(0, Math.min(3, this._config.precision)) : 1;
    const height = this._config.height;
    const width = Math.max(120, this._width || Math.round(this.getBoundingClientRect().width) || 200);
    // dessin à une hauteur de référence puis viewBox étiré proportionnellement -> pas de distorsion,
    // le texte suit l'échelle de la hauteur.
    const REF = 74;
    const vbW = Math.max(1, Math.round(width * REF / height));
    const radius = (17 * height / REF).toFixed(1);
    const hasAction = (a) => !!(a && a.action && a.action !== 'none');
    const interactive = hasAction(this._config.tap_action) || hasAction(this._config.hold_action) || hasAction(this._config.double_tap_action);
    const stale = this._isStale();
    const heatingStatus = this._heatingStatus();
    const heatingLevel = heatingStatus.level;
    const heating = heatingLevel !== null && heatingLevel > 0;
    const heatImpact = heating ? Math.pow(heatingLevel / 100, .85) : 0;
    const heatDuration = (3 - 2.2 * heatImpact).toFixed(2);
    const heatScale = (1.015 + .435 * heatImpact).toFixed(3);
    const heatLowOpacity = (.2 + .52 * heatImpact).toFixed(3);
    const heatHighOpacity = (.32 + .68 * heatImpact).toFixed(3);
    const heatStaticOpacity = (.25 + .75 * heatImpact).toFixed(3);
    const heatGlow = (.1 + 5.5 * heatImpact).toFixed(2);
    const heatGlowAlpha = (.06 + .84 * heatImpact).toFixed(3);
    const heatColor = `hsl(${(32 - 18 * heatImpact).toFixed(1)} 100% ${(73 - 19 * heatImpact).toFixed(1)}%)`;
    const heatDescription = heatingStatus.kind === 'numeric' && heating
      ? `, chauffe, intensité indicative ${Math.round(heatingLevel)} %`
      : (heating ? ', chauffe' : '');
    const heatTooltip = heatingStatus.kind === 'numeric'
      ? `Chauffe · ${Math.round(heatingLevel)} %`
      : 'Chauffe · actif';
    const svg = temperatureTile(value, escapeXml(this._config.name), vbW, REF, tempFill, 'temperature-tile-card', precision);

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; }
        ha-card {
          position: relative;
          display: block;
          width: 100%;
          padding: 0;
          overflow: hidden;
          border: 0;
          border-radius: ${radius}px;
          box-shadow: none;
          background: transparent;
          cursor: ${interactive ? 'pointer' : 'default'};
        }
        ha-card:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
        ha-card > svg { display: block; width: 100%; height: ${height}px; overflow: hidden; }
        text { font-family: Inter, Roboto, Arial, sans-serif; }
        ha-card.tt-stale > svg { filter: grayscale(.75); opacity: .5; }
        .tt-status-badges { position: absolute; top: 6px; right: 8px; display: flex; gap: 4px; pointer-events: none; }
        .tt-status-badge { width: 16px; height: 16px; display: none; filter: drop-shadow(0 1px 1px rgba(0,0,0,.45)); }
        .tt-status-badge svg,
        .tt-status-badge ha-icon { width: 100%; height: 100%; }
        .tt-status-badge ha-icon { --mdc-icon-size: 16px; display: block; }
        .tt-heating-badge {
          position: relative;
          pointer-events: auto;
          cursor: help;
        }
        .tt-heating-icon {
          color: var(--tt-heat-color, #ff8a3d);
          filter:
            drop-shadow(0 0 1.25px rgba(0,0,0,.98))
            drop-shadow(0 1px 2px rgba(0,0,0,.9))
            drop-shadow(0 0 var(--tt-heat-glow, 0px) rgba(255,82,0,var(--tt-heat-glow-alpha,0)));
        }
        .tt-heating-badge::after {
          content: attr(data-tooltip);
          position: absolute;
          top: -3px;
          right: calc(100% + 7px);
          z-index: 3;
          white-space: nowrap;
          padding: 4px 7px;
          border-radius: 7px;
          border: 1px solid var(--divider-color, rgba(255,255,255,.18));
          background: var(--card-background-color, var(--primary-background-color, #20242b));
          color: var(--primary-text-color, #fff);
          font: 600 11px/1.2 Inter, Roboto, Arial, sans-serif;
          box-shadow: 0 2px 7px rgba(0,0,0,.45);
          opacity: 0;
          transform: translateX(3px);
          transition: opacity .12s ease, transform .12s ease;
          pointer-events: none;
        }
        .tt-heating-badge:hover::after {
          opacity: 1;
          transform: translateX(0);
        }
        .tt-stale-badge { color: #e0a53b; }
        ha-card.tt-heating .tt-heating-badge {
          display: block;
        }
        ha-card.tt-heating .tt-heating-icon {
          transform-origin: center;
          animation: tt-heat-pulse var(--tt-heat-duration, 1.6s) ease-in-out infinite;
        }
        ha-card.tt-stale .tt-stale-badge { display: block; }
        @keyframes tt-heat-pulse {
          0%, 100% { transform: scale(1); opacity: var(--tt-heat-low-opacity, .75); }
          50% { transform: scale(var(--tt-heat-scale, 1.12)); opacity: var(--tt-heat-high-opacity, 1); }
        }
        @media (prefers-reduced-motion: reduce) {
          ha-card.tt-heating .tt-heating-icon {
            animation: none;
            transform: none;
            opacity: var(--tt-heat-static-opacity, 1);
          }
        }
      </style>
      <ha-card
        class="${heating ? 'tt-heating' : ''} ${stale ? 'tt-stale' : ''}"
        data-heating-level="${heatingLevel == null ? '' : heatingLevel.toFixed(1)}"
        ${interactive ? 'role="button" tabindex="0"' : ''}
        aria-label="${escapeXml(`${this._config.name}, ${value == null ? 'indisponible' : value.toFixed(precision) + '°'}${heatDescription}${stale ? ', données anciennes' : ''}`)}"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW} ${REF}" preserveAspectRatio="none">${svg}</svg>
        <div class="tt-status-badges" aria-hidden="true">
          <div
            class="tt-status-badge tt-heating-badge"
            data-tooltip="${escapeXml(heatTooltip)}"
            style="--tt-heat-duration:${heatDuration}s;--tt-heat-scale:${heatScale};--tt-heat-low-opacity:${heatLowOpacity};--tt-heat-high-opacity:${heatHighOpacity};--tt-heat-static-opacity:${heatStaticOpacity};--tt-heat-glow:${heatGlow}px;--tt-heat-glow-alpha:${heatGlowAlpha};--tt-heat-color:${heatColor};"
          >
            <ha-icon class="tt-heating-icon" icon="${escapeXml(this._config.heating_icon)}"></ha-icon>
          </div>
          <div class="tt-status-badge tt-stale-badge" title="Données anciennes">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          </div>
        </div>
      </ha-card>
    `;

    const card = this.shadowRoot.querySelector('ha-card');
    if (interactive) {
      card?.addEventListener('pointerdown', this._pointerDown);
      card?.addEventListener('pointerup', this._pointerUp);
      card?.addEventListener('pointercancel', this._pointerCancel);
      card?.addEventListener('keydown', this._keydown);
    }
  }
}

/* ===========================================================================
 * Éditeur visuel (ha-form natif, light DOM -> hérite des variables de thème HA).
 * ==========================================================================*/

const TEMPERATURE_EDITOR_LABELS = {
  name: 'Nom affiché',
  temperature_entity: 'Source de température',
  climate_entity: 'Climate maître',
  heating_entity: 'Source de chauffe / intensité',
  heating_icon: 'Icône de chauffe',
  height: 'Hauteur',
  precision: 'Décimales de la température',
  temperature_color: 'Échelle de couleur',
  mode: "Mode d'échelle",
  min: 'Seuil froid (°C)',
  mid: 'Seuil neutre (°C)',
  max: 'Seuil chaud (°C)',
  cool: 'Couleur froid',
  neutral: 'Couleur neutre',
  warm: 'Couleur chaud',
  reference_entities: 'Capteurs de référence',
  reference_areas: 'Zones de référence',
  tap_action: 'Action au clic',
  hold_action: 'Action appui long',
  double_tap_action: 'Action double-clic',
  tap_entity: 'Entité ouverte au tap',
  stale_after: 'Marquer périmé après (min)',
  stale_entity: 'Entité surveillée (fraîcheur)',
};

const TEMPERATURE_EDITOR_HELPERS = {
  temperature_entity: 'Température affichée (capteur, climate ou météo). Vide en mode relatif : moyenne des capteurs / zones de référence (cas « Maison »).',
  climate_entity: 'Climate principal de la pièce. Vide : la source de température est reprise automatiquement si elle est de type climate.',
  heating_entity: 'Optionnel : remplace le climate maître. Une valeur de 0 à 100 module l’intensité de l’animation ; un capteur binaire actif ou un climate en chauffe vaut 100 %. Entité absente ou indisponible : aucune icône.',
  heating_icon: 'Icône affichée pendant la chauffe. Par défaut : mdi:radiator.',
  height: 'Hauteur de la carte en pixels (min 48, sans plafond).',
  precision: 'Nombre de décimales de la température (0 à 3).',
  mode: 'Absolue = seuils fixes réglables ci-dessous ; Relative = échelle « maison » calculée sur les références (min → max).',
  min: 'Température (°C) où la couleur froide est pleine.',
  mid: 'Température (°C) neutre (bascule froid / chaud).',
  max: 'Température (°C) où la couleur chaude est pleine.',
  reference_entities: 'Capteurs dont le min / max définissent l’échelle relative (et la moyenne si aucune source n’est fixée).',
  reference_areas: 'Zones dont les capteurs de température (°C) alimentent l’échelle relative et la moyenne.',
  hold_action: 'Action sur appui long (≈ 0,5 s).',
  double_tap_action: 'Action sur double-clic.',
  tap_entity: 'Entité ouverte par l’action « Infos » (more-info). Vide : la source de température.',
  stale_after: 'Optionnel : au-delà de cette ancienneté sans mise à jour, la carte est grisée + horloge. Vide = désactivé.',
  stale_entity: 'Entité dont on surveille la fraîcheur. Vide : la source de température.',
};

class TemperatureTileCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._computeLabel = this._computeLabel.bind(this);
    this._computeHelper = this._computeHelper.bind(this);
    this._valueChanged = this._valueChanged.bind(this);
  }

  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  connectedCallback() {
    this._render();
  }

  // schéma recalculé à chaque rendu : les champs seuils/références dépendent du mode
  _schema() {
    const mode = this._config?.temperature_color?.mode ?? 'absolute';
    const absolute = mode === 'absolute';
    const relative = mode === 'relative';
    return [
      { name: 'name', selector: { text: {} } },
      { name: 'temperature_entity', selector: { entity: { filter: [{ domain: 'sensor', device_class: 'temperature' }, { domain: 'climate' }, { domain: 'weather' }] } } },
      { name: 'climate_entity', selector: { entity: { filter: [{ domain: 'climate' }] } } },
      { name: 'heating_entity', selector: { entity: { filter: [{ domain: 'binary_sensor' }, { domain: 'climate' }, { domain: 'sensor' }] } } },
      { name: 'heating_icon', selector: { icon: {} } },
      { name: 'height', selector: { number: { min: 48, step: 1, mode: 'box', unit_of_measurement: 'px' } } },
      { name: 'precision', selector: { number: { min: 0, max: 3, step: 1, mode: 'box' } } },
      {
        name: 'temperature_color',
        type: 'expandable',
        title: 'Échelle de couleur',
        icon: 'mdi:thermometer',
        schema: [
          {
            name: 'mode',
            selector: {
              select: {
                mode: 'dropdown',
                options: [
                  { value: 'absolute', label: 'Absolue (seuils réglables)' },
                  { value: 'relative', label: 'Relative (échelle maison)' },
                ],
              },
            },
          },
          ...(absolute ? [
            { name: 'min', selector: { number: { mode: 'box', step: 1, unit_of_measurement: '°C' } } },
            { name: 'mid', selector: { number: { mode: 'box', step: 1, unit_of_measurement: '°C' } } },
            { name: 'max', selector: { number: { mode: 'box', step: 1, unit_of_measurement: '°C' } } },
            { name: 'cool', selector: { color_rgb: {} } },
            { name: 'neutral', selector: { color_rgb: {} } },
            { name: 'warm', selector: { color_rgb: {} } },
          ] : []),
          ...(relative ? [
            { name: 'reference_entities', selector: { entity: { multiple: true, domain: ['sensor', 'climate', 'weather'] } } },
            { name: 'reference_areas', selector: { area: { multiple: true } } },
          ] : []),
        ],
      },
      { name: 'tap_action', selector: { ui_action: { actions: ['more-info', 'navigate', 'url', 'toggle', 'perform-action', 'none'] } } },
      { name: 'hold_action', selector: { ui_action: { actions: ['more-info', 'navigate', 'url', 'toggle', 'perform-action', 'none'] } } },
      { name: 'double_tap_action', selector: { ui_action: { actions: ['more-info', 'navigate', 'url', 'toggle', 'perform-action', 'none'] } } },
      { name: 'tap_entity', selector: { entity: {} } },
      { name: 'stale_after', selector: { number: { min: 1, step: 1, mode: 'box', unit_of_measurement: 'min' } } },
      { name: 'stale_entity', selector: { entity: {} } },
    ];
  }

  _computeLabel(schema) {
    return TEMPERATURE_EDITOR_LABELS[schema.name] ?? schema.name;
  }

  _computeHelper(schema) {
    return TEMPERATURE_EDITOR_HELPERS[schema.name];
  }

  _valueChanged(ev) {
    ev.stopPropagation();
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: ev.detail.value },
      bubbles: true,
      composed: true,
    }));
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.computeLabel = this._computeLabel;
      this._form.computeHelper = this._computeHelper;
      this._form.addEventListener('value-changed', this._valueChanged);
      this.appendChild(this._form);
    }
    this._form.schema = this._schema();
    this._form.data = this._config;
    if (this._hass) this._form.hass = this._hass;
  }
}

/* ===========================================================================
 * Enregistrement.
 * ==========================================================================*/

if (!customElements.get('temperature-tile-card-editor')) {
  customElements.define('temperature-tile-card-editor', TemperatureTileCardEditor);
}
if (!customElements.get('temperature-tile-card')) {
  customElements.define('temperature-tile-card', TemperatureTileCard);
}

// card picker
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === 'temperature-tile-card')) {
  window.customCards.push({
    type: 'temperature-tile-card',
    name: 'Temperature Tile Card',
    description: 'Tuile température teintée par une échelle absolue ou relative « maison ».',
    preview: true,
  });
}

// bandeau de version (convention communautaire), une seule fois
if (!window.__temperatureTileCardBanner) {
  window.__temperatureTileCardBanner = true;
  console.info(
    `%c TEMPERATURE-TILE-CARD %c v${CARD_VERSION} `,
    'color:#fff;background:#5da5ce;font-weight:700;padding:2px 6px;border-radius:3px 0 0 3px',
    'color:#5da5ce;background:#20242b;padding:2px 6px;border-radius:0 3px 3px 0',
  );
}

// Moteur exposé pour réutilisation OPTIONNELLE (ne crée aucune dépendance pour cette carte).
window.TemperatureTileCardEngine = Object.freeze({
  version: CARD_VERSION,
  temperatureTile,
  temperatureFill,
  relativeTemperatureFill,
  referenceTemperatures,
  entityTemperature,
});

export {
  TemperatureTileCard,
  TemperatureTileCardEditor,
  temperatureTile,
  temperatureFill,
  relativeTemperatureFill,
  referenceTemperatures,
  entityTemperature,
};
