const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const elements = new Map();
const context = vm.createContext({
  HTMLElement: class {
    attachShadow() {
      this.shadowRoot = { addEventListener() {}, querySelector() { return null; }, innerHTML: '' };
    }
    dispatchEvent(event) { (this.events ||= []).push(event); return true; }
  },
  customElements: { get: (n) => elements.get(n), define: (n, v) => elements.set(n, v) },
  window: {}, console: { info() {} }, setInterval: () => 0, clearInterval() {}, Date,
  CustomEvent: class { constructor(type, o) { this.type = type; Object.assign(this, o); } },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/kuni-device-card.js'), 'utf8'), context);
const get = (n) => vm.runInContext(n, context);

const HW = 'e0a9f100-hw';
const device = { id: 'ha-dev', name: 'Living room', identifiers: [['kuni', HW]] };
const entry = (entity_id, key, extra = {}) => ({ entity_id, device_id: 'ha-dev', platform: 'kuni', unique_id: `kuni_ENTRY_${HW}_${key}`, ...extra });
const entries = [
  entry('switch.renamed_power', 'power'), entry('select.kuni_scent', 'current_scent'),
  entry('number.kuni_intensity', 'intensity'), entry('sensor.kuni_time_left', 'time_left'),
  entry('sensor.s1', 'scent_slot_1'), entry('sensor.s2', 'scent_slot_2'), entry('sensor.s3', 'scent_slot_3'),
];
const st = (state, attributes = {}, extra = {}) => ({ state, attributes, ...extra });

function card(states = {}) {
  const c = new (elements.get('kuni-device-card'))();
  c.setConfig({ language: 'en' });
  c._device = device; c._resolved = true;
  c._roles = get('resolveRoles')(device, entries);
  const calls = [];
  c._hass = {
    language: 'en',
    states: {
      'switch.renamed_power': st('on'),
      'select.kuni_scent': st('Soft · slot 3', { options: ['Bossa Nova · slot 1', 'Chill Out · slot 2', 'Soft · slot 3'] }),
      'number.kuni_intensity': st('3', { min: 1, max: 7, step: 1 }),
      'sensor.kuni_time_left': st('0'),
      'sensor.s1': st('99', { scent_name: 'Bossa Nova' }), 'sensor.s2': st('45', { scent_name: 'Chill Out' }), 'sensor.s3': st('12', { scent_name: 'Soft' }),
      ...states,
    },
    callService: async (...a) => calls.push(a),
  };
  c.calls = calls;
  return c;
}
const click = (c, dataset) => c._click({ target: { closest: () => ({ dataset, disabled: false }) } });

test('roles resolve by unique-ID suffix even after renaming; disabled and other devices are ignored', () => {
  const roles = get('resolveRoles')(device, entries);
  assert.equal(roles.power, 'switch.renamed_power');
  assert.equal(roles.slot_3, 'sensor.s3');
  assert.equal(get('resolveRoles')(device, [entry('switch.x', 'power', { disabled_by: 'user' })]).power, undefined);
  assert.equal(get('resolveRoles')(device, [entry('switch.x', 'power', { device_id: 'other' })]).power, undefined);
});

test('a single Kuni device is picked automatically; two devices need a choice', () => {
  const d2 = { id: 'b', identifiers: [['kuni', 'hw2']] };
  const all = [...entries, { device_id: 'b', platform: 'kuni', entity_id: 'switch.b' }];
  assert.equal(get('resolveDevice')({}, [device], entries).id, 'ha-dev');
  assert.equal(get('resolveDevice')({}, [device, d2], all), undefined);
  assert.equal(get('resolveDevice')({ device_id: 'b' }, [device, d2], all).id, 'b');
});

test('slots show scent name, level, tone and the active cartridge', () => {
  const slots = card()._slots();
  assert.deepEqual(JSON.parse(JSON.stringify(slots.map((s) => [s.name, s.level, s.tone, s.active]))), [
    ['Bossa Nova', 99, 'ok', false], ['Chill Out', 45, 'mid', false], ['Soft', 12, 'low', true],
  ]);
});

test('tapping a scent selects that cartridge; tapping the active one sends nothing', async () => {
  const c = card();
  click(c, { action: 'scent', slot: '0' });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(c.calls[0])), ['select', 'select_option', { entity_id: 'select.kuni_scent', option: 'Bossa Nova · slot 1' }]);
  const c2 = card();
  click(c2, { action: 'scent', slot: '2' });
  assert.equal(c2.calls.length, 0);
});

test('power toggles, intensity stays in range, timer uses the kuni service with the HA device', async () => {
  const c = card();
  click(c, { action: 'power' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(c.calls[0][1], 'turn_off');
  const c2 = card();
  click(c2, { action: 'intensity', value: '9' });
  assert.equal(c2.calls.length, 0);
  click(c2, { action: 'intensity', value: '5' });
  await Promise.resolve();
  assert.equal(c2.calls[0][2].value, 5);
  const c3 = card();
  click(c3, { action: 'timer', seconds: '3600' });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(c3.calls[0])), ['kuni', 'set_timer', { device_id: 'ha-dev', duration_seconds: 3600 }]);
});

test('timer counts down locally from the last report and formats hours', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  const s = st('3600', {}, { last_updated: '2026-11-22T09:50:00Z' });
  assert.equal(get('remainingSeconds')(s, now), 3000);
  assert.equal(get('remainingSeconds')(st('unknown'), now), 0);
  const t = (k) => ({ min: 'm', hour: 'h' })[k];
  assert.equal(get('formatDuration')(3000, t), '50 m');
  assert.equal(get('formatDuration')(5400, t), '1:30');
});

test('render produces device, three slots, seven intensity steps and escapes names', () => {
  const c = card({ 'sensor.s1': st('99', { scent_name: '<b>x</b>' }) });
  c._render();
  const html = c.shadowRoot.innerHTML;
  assert.equal((html.match(/class="slot"/g) || []).length, 3);
  assert.equal((html.match(/class="step"/g) || []).length, 7);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!html.includes('<b>x</b>'));
});

test('unavailable device disables every control', () => {
  const c = card({ 'switch.renamed_power': st('unavailable') });
  c._render();
  const html = c.shadowRoot.innerHTML;
  assert.ok(/class="power"[^>]*disabled/.test(html));
  assert.ok(!/class="step"[^>]*data-current="false"[^>]*aria-label="Intensity 1" >/.test(html));
  assert.equal((html.match(/class="slot"[^>]*disabled/g) || []).length, 3);
});

test('scent colour follows the scent, not the slot, and can be overridden', () => {
  const color = get('scentColor');
  assert.equal(color('Soft', 0), color('soft', 2));
  assert.equal(color('Chill Out', 0), '#4fb3a4');
  assert.equal(color('Soft', 0, { soft: '#123456' }), '#123456');
  assert.equal(color('Soft', 0, { soft: 'red;x' }), color('Soft', 0));
  assert.equal(color('Unknown Blend', 0), color('unknown blend', 2));
});

test('tapped scent shows at once, and rapid taps send only the newest choice', async () => {
  const c = card();
  let release;
  c._hass.callService = (...a) => { c.calls.push(a); return new Promise((r) => { release = r; }); };
  click(c, { action: 'scent', slot: '0' });
  assert.equal(c._slots().find((s) => s.active).index, 0);
  click(c, { action: 'scent', slot: '1' });
  click(c, { action: 'scent', slot: '0' });
  assert.equal(c.calls.length, 1);
  release(); await new Promise((r) => setImmediate(r));
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[1][2].option, 'Bossa Nova · slot 1');
});

test('a running diffuser without a timer (value 1) shows no countdown', () => {
  assert.equal(get('remainingSeconds')(st('1', {}, { last_updated: new Date().toISOString() })), 0);
});

test('setting the same timer again restarts the countdown from the tap', () => {
  const rs = get('remainingSeconds');
  const now = Date.parse('2026-11-22T10:20:00Z');
  // The device reported 1800 at 10:00 and keeps reporting 1800.
  const s = st('1800', {}, { last_updated: '2026-11-22T10:00:00Z' });
  assert.equal(rs(s, now), 600);
  // 30 min tapped again at 10:15: the state does not change, the tap wins.
  assert.equal(rs(s, now, { seconds: 1800, at: Date.parse('2026-11-22T10:15:00Z') }), 1500);
  // A newer state change (e.g. a timer set from the Kuni app) wins over an older tap.
  const s2 = st('3600', {}, { last_updated: '2026-11-22T10:18:00Z' });
  assert.equal(rs(s2, now, { seconds: 1800, at: Date.parse('2026-11-22T10:15:00Z') }), 3480);
  // Running without a timer after an old tap: no countdown.
  const s3 = st('1', {}, { last_updated: '2026-11-22T10:18:00Z' });
  assert.equal(rs(s3, now, { seconds: 1800, at: Date.parse('2026-11-22T10:15:00Z') }), 0);
});

test('a timer tap is remembered by the card for the countdown', async () => {
  const c = card();
  click(c, { action: 'timer', seconds: '1800' });
  await Promise.resolve();
  assert.equal(c._timerSet.seconds, 1800);
  click(c, { action: 'timer', seconds: '0' });
  assert.equal(c._timerSet, undefined);
});

test('entities picked by hand replace the ones found on the device', async () => {
  const c = new (elements.get('kuni-device-card'))();
  c._render = () => {};
  c.setConfig({ language: 'en', entities: { power: 'switch.my_power', slot_1: 'sensor.my_slot' } });
  c._hass = { language: 'en', states: {}, callWS: async (m) => (m.type === 'config/device_registry/list' ? [device] : entries) };
  await c._discover();
  assert.equal(c._roles.power, 'switch.my_power');
  assert.equal(c._roles.slot_1, 'sensor.my_slot');
  assert.equal(c._roles.intensity, 'number.kuni_intensity');
});

test('entity overrides must match the role domain', () => {
  const validate = get('validateConfig');
  assert.throws(() => validate({ entities: { power: 'sensor.wrong' } }), /power/);
  assert.throws(() => validate({ entities: { nope: 'switch.x' } }), /nope/);
  assert.doesNotThrow(() => validate({ entities: { intensity: 'number.ok' } }));
});

test('editor sets and clears entity overrides and the photo', () => {
  const e = new (elements.get('kuni-device-card-editor'))();
  e._render = () => {};
  e.setConfig({ language: 'en' });
  e._change({ target: { dataset: { role: 'power' }, value: 'switch.p' } });
  assert.equal(JSON.stringify(e._config.entities), JSON.stringify({ power: 'switch.p' }));
  e._change({ target: { dataset: { field: 'image' }, value: '/local/kuni.webp' } });
  assert.equal(e._config.image, '/local/kuni.webp');
  e._change({ target: { dataset: { role: 'power' }, value: '' } });
  assert.equal(e._config.entities, undefined);
  assert.equal(e.events.at(-1).detail.config.image, '/local/kuni.webp');
});
