import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './fake-dom.js';

const {
  TemperatureTileCard,
  TemperatureTileCardEditor,
  temperatureTile,
  temperatureFill,
  relativeTemperatureFill,
  referenceTemperatures,
  entityTemperature,
} = await loadCard();

const NOW = new Date().toISOString();
const state = (value, attributes = {}, lastUpdated = NOW) => ({ state: String(value), attributes, last_updated: lastUpdated });
const temp = (value, extra = {}, lastUpdated = NOW) =>
  state(value, { device_class: 'temperature', unit_of_measurement: '°C', ...extra }, lastUpdated);

const makeCard = (config, states = {}) => {
  const card = new TemperatureTileCard();
  card.setConfig(config);
  card.hass = { states, entities: {}, devices: {}, callService() {} };
  return card;
};
const haCardTag = (card) => /<ha-card[\s\S]*?>/.exec(card.shadowRoot.innerHTML)[0];
const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
const fontSizes = (svg) => [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));

/* --- moteur d'échelle ---------------------------------------------------- */

test('temperatureFill : échelle absolue par défaut (-5 / 15 / 35 °C), bornée', () => {
  assert.equal(temperatureFill(null), 'rgba(127,127,127,.14)');
  assert.equal(temperatureFill(-5), 'rgb(93,165,206)');
  assert.equal(temperatureFill(15), 'rgb(238,230,199)');
  assert.equal(temperatureFill(35), 'rgb(224,112,91)');
  assert.equal(temperatureFill(-20), 'rgb(93,165,206)');
  assert.equal(temperatureFill(50), 'rgb(224,112,91)');
});

test('temperatureFill : seuils et couleurs personnalisés (#hex, « r,g,b », [r,g,b])', () => {
  const cfg = { min: 0, mid: 10, max: 20, cool: '#000000', neutral: '255, 255, 255', warm: [255, 0, 0] };
  assert.equal(temperatureFill(5, cfg), 'rgb(128,128,128)');
  assert.equal(temperatureFill(15, cfg), 'rgb(255,128,128)');
  assert.equal(temperatureFill(20, cfg), 'rgb(255,0,0)');
  // couleur illisible -> couleur par défaut
  assert.equal(temperatureFill(-5, { cool: 'bleu' }), 'rgb(93,165,206)');
});

test('relativeTemperatureFill : position entre min et max des références', () => {
  assert.equal(relativeTemperatureFill(null, [18, 22]), 'rgba(127,127,127,.14)');
  assert.equal(relativeTemperatureFill(18, [18, 22]), 'rgb(93,165,206)');
  assert.equal(relativeTemperatureFill(20, [18, 22]), 'rgb(238,230,199)');
  assert.equal(relativeTemperatureFill(22, [18, 22]), 'rgb(224,112,91)');
  // écart < 0,15 °C : gris neutre uniforme
  assert.equal(relativeTemperatureFill(20, [20, 20.1]), 'rgb(221,218,207)');
  // aucune référence : repli sur l'échelle absolue
  const cfg = { min: 10, mid: 15, max: 20 };
  assert.equal(relativeTemperatureFill(18, [], cfg), temperatureFill(18, cfg));
});

test('entityTemperature : weather, climate, sensor (état puis attribut), indisponible', () => {
  const hass = {
    states: {
      'weather.maison': state('sunny', { temperature: 12.5 }),
      'climate.salon': state('heat', { current_temperature: '20.5' }),
      'sensor.bureau': state('19.25'),
      'sensor.attribut': state('n/a', { temperature: 7 }),
      'sensor.inconnu': state('unknown', { temperature: 7 }),
      'sensor.hs': state('unavailable'),
    },
  };
  assert.equal(entityTemperature(hass, 'weather.maison'), 12.5);
  assert.equal(entityTemperature(hass, 'climate.salon'), 20.5);
  assert.equal(entityTemperature(hass, 'sensor.bureau'), 19.25);
  assert.equal(entityTemperature(hass, 'sensor.attribut'), 7);
  assert.equal(entityTemperature(hass, 'sensor.inconnu'), null);
  assert.equal(entityTemperature(hass, 'sensor.hs'), null);
  assert.equal(entityTemperature(hass, 'sensor.absent'), null);
});

test('referenceTemperatures : entités explicites puis zones, moyennées par appareil puis par zone', () => {
  const old = new Date(Date.now() - 3 * 3600e3).toISOString();
  const hass = {
    states: {
      'climate.bureau': state('heat', { current_temperature: 19 }),
      'sensor.salon_thermo_a': temp(20),
      'sensor.salon_thermo_b': temp(22),
      'sensor.salon_radiateur': temp(23),
      'sensor.salon_cpu_temperature': temp(45),
      'sensor.salon_fahrenheit': temp(70, { unit_of_measurement: '°F' }),
      'sensor.salon_cachee': temp(10),
      'sensor.salon_diagnostic': temp(10),
      'sensor.salon_ancienne': temp(10, {}, old),
      'sensor.salon_aberrante': temp(80),
      'sensor.chambre_temperature': temp(18),
      'sensor.cuisine_temperature': temp(25),
    },
    entities: {
      'sensor.salon_thermo_a': { device_id: 'd1' },
      'sensor.salon_thermo_b': { device_id: 'd1' },
      'sensor.salon_radiateur': { device_id: 'd2' },
      'sensor.salon_cpu_temperature': { area_id: 'salon' },
      'sensor.salon_fahrenheit': { area_id: 'salon' },
      'sensor.salon_cachee': { area_id: 'salon', hidden_by: 'user' },
      'sensor.salon_diagnostic': { area_id: 'salon', entity_category: 'diagnostic' },
      'sensor.salon_ancienne': { area_id: 'salon' },
      'sensor.salon_aberrante': { area_id: 'salon' },
      'sensor.chambre_temperature': { area_id: 'chambre' },
      'sensor.cuisine_temperature': { area_id: 'cuisine' },
    },
    devices: { d1: { area_id: 'salon' }, d2: { area_id: 'salon' } },
  };
  // salon : appareil d1 = (20 + 22) / 2 = 21, appareil d2 = 23 -> zone = 22 ; capteurs filtrés ignorés
  assert.deepEqual(
    referenceTemperatures(hass, { reference_entities: ['climate.bureau'], reference_areas: ['salon', 'chambre'] }),
    [19, 22, 18],
  );
});

/* --- rendu SVG de la tuile ----------------------------------------------- */

test('temperatureTile : valeur, précision et contraste du texte selon le fond', () => {
  const unavailable = temperatureTile(null, 'CAVE', 200, 74, 'rgba(127,127,127,.14)', 't', 1);
  assert.match(unavailable, />—</);
  assert.match(unavailable, /fill="var\(--primary-text-color\)"/);

  const light = temperatureTile(21.456, 'SALON', 200, 74, 'rgb(238,230,199)', 't', 2);
  assert.match(light, />21\.46°</);
  assert.match(light, /fill="#16232e"/);

  const dark = temperatureTile(3, 'TERRASSE', 200, 74, 'rgb(40,60,120)', 't', 7);
  assert.match(dark, />3\.000°</); // précision bornée à 3
  assert.match(dark, /fill="#f2f5fb"/);
});

test('temperatureTile : auto-fit du libellé au lieu de le tronquer', () => {
  const label = 'CHAMBRE DES ENFANTS';
  const [, wide] = fontSizes(temperatureTile(20, label, 400, 74, 'rgb(238,230,199)', 't', 1));
  const [, narrow] = fontSizes(temperatureTile(20, label, 120, 74, 'rgb(238,230,199)', 't', 1));
  assert.equal(wide, 10.5);
  assert.ok(narrow < wide && narrow >= 6, `police réduite attendue, obtenu ${narrow}`);
});

/* --- carte : configuration ----------------------------------------------- */

test('setConfig : refuse les configurations invalides', () => {
  const setConfig = (config) => () => new TemperatureTileCard().setConfig(config);
  assert.throws(setConfig({}), /source de température/);
  assert.throws(setConfig({ temperature_entity: 'sensor.t', temperature_color: { mode: 'relative' } }), /échelle relative/);
  assert.throws(setConfig({ temperature_entity: 'sensor.t', temperature_color: { mode: 'auto' } }), /absolute/);
  assert.throws(setConfig({ temperature_entity: 'sensor.t', climate_entity: 'sensor.vanne' }), /climate_entity/);
});

test('setConfig : valeurs par défaut (nom, hauteur plancher 48 px, icône de chauffe)', () => {
  const card = makeCard({ temperature_entity: 'sensor.t' }, { 'sensor.t': state(21) });
  assert.equal(attr(haCardTag(card), 'aria-label'), 'Maison, 21.0°');
  assert.match(card.shadowRoot.innerHTML, /height: 74px/);
  assert.match(card.shadowRoot.innerHTML, /icon="mdi:radiator"/);

  const small = makeCard({ temperature_entity: 'sensor.t', height: 20 }, { 'sensor.t': state(21) });
  assert.match(small.shadowRoot.innerHTML, /height: 48px/);
});

test('valeur affichée : moyenne des références sans capteur dédié', () => {
  const card = makeCard(
    { name: 'MAISON', temperature_color: { mode: 'relative', reference_entities: ['sensor.a', 'sensor.b'] } },
    { 'sensor.a': state(19), 'sensor.b': state(22) },
  );
  assert.equal(attr(haCardTag(card), 'aria-label'), 'MAISON, 20.5°');
});

test('le nom est échappé dans le SVG et l’aria-label', () => {
  const card = makeCard({ name: '<b>Salon</b>', temperature_entity: 'sensor.t' }, { 'sensor.t': state(21) });
  assert.match(card.shadowRoot.innerHTML, /&lt;b&gt;Salon&lt;\/b&gt;/);
  assert.doesNotMatch(card.shadowRoot.innerHTML, /<b>/);
});

/* --- carte : indicateur de chauffe --------------------------------------- */

test('chauffe : le climate source suffit, hvac_action « heating » = 100 %', () => {
  const states = { 'climate.salon': state('heat', { current_temperature: 19.5, hvac_action: 'heating' }) };
  const card = makeCard({ name: 'SALON', temperature_entity: 'climate.salon' }, states);
  const tag = haCardTag(card);
  assert.match(attr(tag, 'class'), /tt-heating/);
  assert.equal(attr(tag, 'data-heating-level'), '100.0');
  assert.equal(attr(tag, 'aria-label'), 'SALON, 19.5°, chauffe');
  assert.match(card.shadowRoot.innerHTML, /data-tooltip="Chauffe · actif"/);

  // passage à idle : nouvel état -> re-rendu sans indicateur
  card.hass = { states: { 'climate.salon': state('heat', { current_temperature: 19.5, hvac_action: 'idle' }) } };
  assert.doesNotMatch(attr(haCardTag(card), 'class'), /tt-heating/);
  assert.equal(attr(haCardTag(card), 'data-heating-level'), '0.0');
});

test('chauffe : aucune source si la température vient d’un capteur sans climate_entity', () => {
  const card = makeCard({ temperature_entity: 'sensor.t' }, { 'sensor.t': state(21) });
  assert.equal(attr(haCardTag(card), 'data-heating-level'), '');
  assert.doesNotMatch(attr(haCardTag(card), 'class'), /tt-heating/);
});

test('chauffe : heating_entity numérique module l’intensité (bornée à 100 %)', () => {
  const config = { name: 'BUREAU', temperature_entity: 'sensor.t', heating_entity: 'sensor.vanne' };
  const card = makeCard(config, { 'sensor.t': state(20), 'sensor.vanne': state(40) });
  const tag = haCardTag(card);
  assert.equal(attr(tag, 'data-heating-level'), '40.0');
  assert.equal(attr(tag, 'aria-label'), 'BUREAU, 20.0°, chauffe, intensité indicative 40 %');
  assert.match(card.shadowRoot.innerHTML, /data-tooltip="Chauffe · 40 %"/);

  const saturated = makeCard(config, { 'sensor.t': state(20), 'sensor.vanne': state(250) });
  assert.equal(attr(haCardTag(saturated), 'data-heating-level'), '100.0');
});

test('chauffe : heating_entity remplace climate_entity ; indisponible = pas d’icône', () => {
  const states = {
    'climate.salon': state('heat', { current_temperature: 19, hvac_action: 'idle' }),
    'binary_sensor.chaudiere': state('on'),
    'sensor.hs': state('unavailable'),
  };
  const card = makeCard({ temperature_entity: 'climate.salon', heating_entity: 'binary_sensor.chaudiere' }, states);
  assert.equal(attr(haCardTag(card), 'data-heating-level'), '100.0');

  const missing = makeCard({ temperature_entity: 'climate.salon', heating_entity: 'sensor.hs' }, states);
  assert.equal(attr(haCardTag(missing), 'data-heating-level'), '');
  assert.doesNotMatch(attr(haCardTag(missing), 'class'), /tt-heating/);
});

/* --- carte : actions, grille, éditeur, enregistrement --------------------- */

test('tap : more-info sur la source, rien à ouvrir pour une moyenne pure', () => {
  const card = makeCard({ temperature_entity: 'sensor.t' }, { 'sensor.t': state(21) });
  card._runAction('tap');
  assert.equal(card.dispatched?.[0]?.type, 'hass-more-info');
  assert.equal(card.dispatched[0].detail.entityId, 'sensor.t');

  const average = makeCard({ temperature_color: { mode: 'relative', reference_entities: ['sensor.t'] } }, { 'sensor.t': state(21) });
  average._runAction('tap');
  assert.equal(average.dispatched, undefined);
});

test('grille « sections » et taille masonry', () => {
  const card = makeCard({ temperature_entity: 'sensor.t' }, { 'sensor.t': state(21) });
  assert.deepEqual(card.getGridOptions(), { columns: 6, min_columns: 2 });
  assert.equal(card.getCardSize(), 1);
  const tall = makeCard({ temperature_entity: 'sensor.t', height: 150 }, { 'sensor.t': state(21) });
  assert.equal(tall.getCardSize(), 3);
});

test('getStubConfig : premier capteur de température disponible', () => {
  assert.equal(TemperatureTileCard.getStubConfig().temperature_entity, 'sensor.temperature');
  const hass = {
    states: {
      'sensor.humidite': { attributes: { device_class: 'humidity' } },
      'sensor.salon_temperature': { attributes: { device_class: 'temperature' } },
    },
  };
  assert.equal(TemperatureTileCard.getStubConfig(hass).temperature_entity, 'sensor.salon_temperature');
});

test('éditeur : champs conditionnels au mode d’échelle', () => {
  const fieldNames = (mode) => {
    const editor = new TemperatureTileCardEditor();
    editor.setConfig({ temperature_color: { mode } });
    const schema = editor._form.schema;
    const color = schema.find((field) => field.name === 'temperature_color');
    return { top: schema.map((field) => field.name), color: color.schema.map((field) => field.name) };
  };
  const absolute = fieldNames('absolute');
  assert.ok(['climate_entity', 'heating_entity', 'heating_icon'].every((name) => absolute.top.includes(name)));
  assert.ok(absolute.color.includes('min') && !absolute.color.includes('reference_entities'));
  const relative = fieldNames('relative');
  assert.ok(relative.color.includes('reference_areas') && !relative.color.includes('min'));
});

test('enregistrement : éléments, card picker et moteur exposé figé', () => {
  assert.equal(customElements.get('temperature-tile-card'), TemperatureTileCard);
  assert.equal(customElements.get('temperature-tile-card-editor'), TemperatureTileCardEditor);
  assert.ok(window.customCards.some((card) => card.type === 'temperature-tile-card' && card.preview));
  const engine = window.TemperatureTileCardEngine;
  assert.ok(Object.isFrozen(engine));
  assert.match(engine.version, /^\d+\.\d+\.\d+$/);
  assert.equal(engine.temperatureFill, temperatureFill);
});
