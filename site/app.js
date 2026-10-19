// Visual Timer — a 3D take on the classic disc countdown timer.
// Timing uses wall-clock end times, so it stays right in background tabs and across reloads.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = (s) => document.querySelector(s);
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = (n) => String(n).padStart(2, '0');
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const THEMES = [
  { id: 'mint',  body: '#9fe3c1', lip: '#bdeed3', wedge: '#18a34a', bg1: '#f2fbf6', bg2: '#cfeedf' },
  { id: 'coral', body: '#ff8f7d', lip: '#ffad9f', wedge: '#e0262b', bg1: '#fff6f3', bg2: '#ffd8cf' },
  { id: 'sky',   body: '#93c8ff', lip: '#b5daff', wedge: '#1f6fe0', bg1: '#f3f8ff', bg2: '#cfe3fa' },
  { id: 'lemon', body: '#ffd765', lip: '#ffe597', wedge: '#ee7a00', bg1: '#fffbef', bg2: '#f9eabf' },
  { id: 'grape', body: '#c3b1ff', lip: '#d7cbff', wedge: '#6d3ff0', bg1: '#f8f5ff', bg2: '#ded5fb' },
  { id: 'ink',   body: '#3a3f47', lip: '#4b525d', wedge: '#ff5a36', bg1: '#30353c', bg2: '#15171b', dark: true },
];
const SCALES = [60, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 432000];
const PRESETS = { focus: 1500, short: 300, long: 900 };
const PHASE_NAME = { focus: 'Focus', short: 'Short break', long: 'Long break', custom: 'Timer' };
const MAX = 99 * 3600 + 59 * 60 + 59;

/* ------------------------------------------------------------------ storage */
// localStorage first; a cookie keeps a compact copy in case storage is blocked or wiped.
const KEY = 'visual-timer-v1';
const store = {
  mode: 'none',
  read() {
    try {
      const v = localStorage.getItem(KEY);
      if (v) { this.mode = 'local'; return JSON.parse(v); }
    } catch (e) { /* fall through */ }
    try {
      const m = document.cookie.match(new RegExp('(?:^|; )' + KEY + '=([^;]*)'));
      if (m) { this.mode = 'cookie'; return JSON.parse(decodeURIComponent(m[1])); }
    } catch (e) { /* ignore */ }
    return null;
  },
  write(obj) {
    const json = JSON.stringify(obj);
    let ok = false;
    try { localStorage.setItem(KEY, json); ok = true; this.mode = 'local'; } catch (e) { /* ignore */ }
    try {
      // Cookies cap near 4 KB, so the cookie copy keeps only the newest history entries.
      const slim = { ...obj, history: obj.history.slice(-25) };
      let c = encodeURIComponent(JSON.stringify(slim));
      if (c.length > 3800) c = encodeURIComponent(JSON.stringify({ ...obj, history: obj.history.slice(-5) }));
      document.cookie = `${KEY}=${c}; max-age=31536000; path=/; SameSite=Lax`;
      if (!ok) this.mode = 'cookie';
    } catch (e) { /* ignore */ }
  },
  clear() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    document.cookie = `${KEY}=; max-age=0; path=/`;
  },
};

const S = {
  theme: 0, sound: true, tick: false, auto: false, seenHint: false,
  scale: 3600, total: 1500, remaining: 1500, running: false, endAt: 0, startedAt: 0,
  phase: 'focus', focusInCycle: 0,
  history: [], // {t: end time ms, p: phase, d: seconds}
};
const OG = new URLSearchParams(location.search).has('og'); // thumbnail mode: demo state, nothing saved
const saved = OG ? null : store.read();
if (saved) Object.assign(S, saved);
if (!Array.isArray(S.history)) S.history = [];
if (!SCALES.includes(S.scale)) S.scale = 3600;
let saveTimer = 0;
function save(now = false) {
  if (OG) return;
  clearTimeout(saveTimer);
  const doit = () => store.write({
    theme: S.theme, sound: S.sound, tick: S.tick, auto: S.auto, seenHint: S.seenHint,
    scale: M.spinT >= 0 ? M.spinTo : S.scale, total: S.total, remaining: S.remaining, running: S.running, endAt: S.endAt, startedAt: S.startedAt,
    phase: S.phase, focusInCycle: S.focusInCycle, history: S.history.slice(-500),
  });
  if (now) doit(); else saveTimer = setTimeout(doit, 250);
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const todayFocus = () => S.history.filter((h) => h.p === 'focus' && dayKey(h.t) === dayKey(Date.now()));

/* ------------------------------------------------------------------ audio */
let AC = null, noiseBuf = null, alarmBus = null;
function ac() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function tone({ f = 440, f2 = 0, type = 'sine', dur = 0.15, vol = 0.2, delay = 0, attack = 0.005, dest = null }) {
  if (!S.sound) return;
  const a = ac(); if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest || a.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
function noise({ dur = 0.02, vol = 0.2, freq = 3000, q = 2, delay = 0 }) {
  if (!S.sound) return;
  const a = ac(); if (!a) return;
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = a.currentTime + delay;
  const src = a.createBufferSource(), bp = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noiseBuf; bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(a.destination);
  src.start(t); src.stop(t + dur + 0.02);
}
const sfx = {
  click: () => { noise({ dur: 0.014, vol: 0.35, freq: 3800, q: 3 }); tone({ f: 2200, dur: 0.012, vol: 0.03, type: 'square' }); },
  thunk: () => tone({ f: 170, f2: 90, dur: 0.1, vol: 0.35 }),
  start: () => { tone({ f: 660, type: 'triangle', dur: 0.1, vol: 0.18 }); tone({ f: 990, type: 'triangle', dur: 0.14, vol: 0.18, delay: 0.08 }); },
  pause: () => { tone({ f: 880, type: 'triangle', dur: 0.1, vol: 0.16 }); tone({ f: 587, type: 'triangle', dur: 0.14, vol: 0.16, delay: 0.08 }); },
  boing: () => { tone({ f: 440, f2: 130, dur: 0.38, vol: 0.25 }); tone({ f: 660, f2: 200, type: 'triangle', dur: 0.3, vol: 0.06 }); },
  pop: () => tone({ f: 480, f2: 1200, dur: 0.09, vol: 0.25 }),
  tick: (hi) => noise({ dur: 0.01, vol: 0.12, freq: hi ? 5200 : 3600, q: 4 }),
  whoosh: () => noise({ dur: 0.35, vol: 0.12, freq: 900, q: 0.7 }),
  alarm: () => {
    if (!S.sound) return;
    const a = ac(); if (!a) return;
    alarmBus = a.createGain(); alarmBus.gain.value = 1; alarmBus.connect(a.destination);
    const notes = [1047, 1319, 1568];
    for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) {
      const f = notes[k], d = r * 1.1 + k * 0.17;
      tone({ f, dur: 1.0, vol: 0.22, attack: 0.002, delay: d, dest: alarmBus });
      tone({ f: f * 2.76, dur: 0.35, vol: 0.05, attack: 0.002, delay: d, dest: alarmBus });
    }
  },
  stopAlarm: () => {
    if (alarmBus && AC) { alarmBus.gain.setTargetAtTime(0, AC.currentTime, 0.03); alarmBus = null; }
  },
};

/* ------------------------------------------------------------------ three.js scene */
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap; // blurred, soft-edged shadows

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
const camTarget = new THREE.Vector3(0, -0.2, 0.6);

const key = new THREE.DirectionalLight(0xffffff, 1.9);
key.position.set(-2.6, 10, 4.5); // high and a little to the front-left: short shadow falling back-right
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -9; key.shadow.camera.right = 9;
key.shadow.camera.top = 9; key.shadow.camera.bottom = -9;
key.shadow.camera.near = 2; key.shadow.camera.far = 26;
key.shadow.radius = 12; key.shadow.blurSamples = 20; key.shadow.bias = -0.0004;
scene.add(key);
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c8c0, 0.35));

const DESK_Y = -1.8;
const desk = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.2 }));
desk.rotation.x = -Math.PI / 2; desk.position.y = DESK_Y; desk.receiveShadow = true;
scene.add(desk);

// contact shadows: a dark blur right where things touch the desk, so nothing looks like it floats
function blurTex(w, h, r, blur) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d'), sx = 256 / (w + blur * 4), sy = 256 / (h + blur * 4);
  g.translate(128, 128); g.scale(sx, sy);
  g.filter = `blur(${blur * Math.min(sx, sy)}px)`;
  g.fillStyle = '#000'; g.beginPath(); g.roundRect(-w / 2, -h / 2, w, h, r); g.fill();
  const t = new THREE.CanvasTexture(c); return { t, w: w + blur * 4, h: h + blur * 4 };
}
const bodyBlur = blurTex(3.5, 1.3, 0.55, 0.16);
const contact = new THREE.Mesh(new THREE.PlaneGeometry(bodyBlur.w, bodyBlur.h),
  new THREE.MeshBasicMaterial({ map: bodyBlur.t, color: '#000', transparent: true, opacity: 0.42, depthWrite: false }));
contact.rotation.order = 'YXZ'; contact.rotation.x = -Math.PI / 2; contact.position.y = DESK_Y + 0.004; contact.renderOrder = 1;
scene.add(contact);
const tomatoBlur = blurTex(0.36, 0.36, 0.18, 0.06);
const tomatoShadowGeo = new THREE.PlaneGeometry(tomatoBlur.w, tomatoBlur.h);

// root: position/hop + spin; tilt: drag tilt + wobble; dial: the face
const root = new THREE.Group(); scene.add(root);
const tilt = new THREE.Group(); root.add(tilt);
const REST_Y = -0.38;

// Rounded-rectangle outline as distinct points (a repeated start/end point breaks the extrude bevel).
function rrPoints(w, h, r, seg = 24) {
  const pts = [], cx = w / 2 - r, cy = h / 2 - r;
  const corners = [[cx, -cy, -Math.PI / 2], [cx, cy, 0], [-cx, cy, Math.PI / 2], [-cx, -cy, Math.PI]];
  for (const [x, y, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push(new THREE.Vector2(x + Math.cos(a) * r, y + Math.sin(a) * r));
    }
  }
  return pts;
}
function rrPath(p, w, h, r) { p.setFromPoints(rrPoints(w, h, r)); return p; }
function smooth(g) {
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4); g.computeVertexNormals(); return g;
}

// body: rounded square with soft bevelled edges; it sits on the desk (y from -1.8 to 1.8)
const bodyMat = new THREE.MeshPhysicalMaterial({ color: THEMES[0].body, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, envMapIntensity: 0.55 });
let bodyGeo = new THREE.ExtrudeGeometry(rrPath(new THREE.Shape(), 3.2, 3.2, 0.82),
  { depth: 1.0, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 10 });
bodyGeo.translate(0, 0, -0.5);
const body = new THREE.Mesh(smooth(bodyGeo), bodyMat);
body.castShadow = true; body.userData.kind = 'body';
tilt.add(body);

const FRONT = 0.7;
const lipShape = rrPath(new THREE.Shape(), 3.04, 3.04, 0.7);
lipShape.holes.push(rrPath(new THREE.Path(), 2.74, 2.74, 0.56));
const lipGeo = new THREE.ExtrudeGeometry(lipShape, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 4 });
const lipMat = new THREE.MeshPhysicalMaterial({ color: THEMES[0].lip, roughness: 0.4, clearcoat: 0.4, envMapIntensity: 0.55 });
const lip = new THREE.Mesh(smooth(lipGeo), lipMat);
lip.position.z = FRONT + 0.03; lip.castShadow = true; lip.userData.kind = 'body';
tilt.add(lip);

const dial = new THREE.Group(); tilt.add(dial);
const FACE = 2.76;

function makeCanvasTex(size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { c, ctx: c.getContext('2d'), t };
}
const faceTex = makeCanvasTex(2048);
const tickTex = makeCanvasTex(2048);
const face = new THREE.Mesh(new THREE.PlaneGeometry(FACE, FACE),
  new THREE.MeshStandardMaterial({ map: faceTex.t, roughness: 0.65, transparent: true, alphaTest: 0.5 }));
face.position.z = FRONT + 0.005; face.receiveShadow = true; face.userData.kind = 'face';
dial.add(face);

const wedgeMat = new THREE.MeshStandardMaterial({ color: THEMES[0].wedge, roughness: 0.5 });
const wedge = new THREE.Mesh(new THREE.BufferGeometry(), wedgeMat);
wedge.position.z = FRONT + 0.01; wedge.receiveShadow = true;
wedge.raycast = () => {};
dial.add(wedge);

const ticks = new THREE.Mesh(new THREE.PlaneGeometry(FACE, FACE),
  new THREE.MeshStandardMaterial({ map: tickTex.t, roughness: 0.6, transparent: true, depthWrite: false }));
ticks.position.z = FRONT + 0.015; ticks.raycast = () => {};
dial.add(ticks);

// knurled knob (lathe profile, ridges pushed out around the rim)
const knobPts = [[0, 0], [0.36, 0], [0.375, 0.03], [0.375, 0.2], [0.355, 0.25], [0.3, 0.275], [0.15, 0.288], [0, 0.29]]
  .map(([x, y]) => new THREE.Vector2(x, y));
let knobGeo = new THREE.LatheGeometry(knobPts, 192);
{
  const p = knobGeo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = Math.hypot(v.x, v.z);
    if (r > 0.36 && v.y > 0.015 && v.y < 0.215) {
      const phi = Math.atan2(v.z, v.x);
      const k = r + 0.014 * Math.max(0, Math.cos(phi * 64));
      v.x *= k / r; v.z *= k / r; p.setXYZ(i, v.x, v.y, v.z);
    }
  }
  knobGeo.rotateX(Math.PI / 2);
  knobGeo.computeVertexNormals();
}
const knobMat = new THREE.MeshPhysicalMaterial({ color: THEMES[0].lip, roughness: 0.45, clearcoat: 0.4, envMapIntensity: 0.55 });
const knob = new THREE.Mesh(knobGeo, knobMat);
knob.position.z = FRONT + 0.012; knob.castShadow = true; knob.userData.kind = 'knob';
dial.add(knob);

// status light + glow sprite
const LED_POS = new THREE.Vector3(-1.02, 1.02, FRONT + 0.02);
const ledMat = new THREE.MeshStandardMaterial({ color: '#2b2b2b', emissive: '#22ff66', emissiveIntensity: 0, roughness: 0.2 });
const led = new THREE.Mesh(new THREE.SphereGeometry(0.075, 24, 16), ledMat);
led.scale.z = 0.5; led.position.copy(LED_POS); led.userData.kind = 'led';
dial.add(led);
const glowCanvas = document.createElement('canvas'); glowCanvas.width = glowCanvas.height = 128;
{
  const g = glowCanvas.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
}
const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glowCanvas), color: '#22ff66', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
glow.scale.set(0.6, 0.6, 1); glow.position.copy(LED_POS).setZ(FRONT + 0.06);
dial.add(glow);

/* ------------------------------------------------------------------ face drawing */
const FONT = 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';
function scaleBadge(sc) {
  if (sc === 60) return '60 SEC';
  if (sc === 3600) return '60 MIN';
  return `${sc / 3600} HR`;
}
function scaleOption(sc) {
  if (sc === 60) return 'Dial: 60 sec';
  if (sc === 3600) return 'Dial: 60 min';
  return `Dial: ${sc / 3600} hours`;
}
function labelFor(i, sc) {
  const v = (i * sc) / 12;
  if (sc === 60) return String(v);
  if (sc <= 3600) return String(v / 60);
  const mins = v / 60, h = Math.floor(mins / 60), m = Math.round(mins % 60);
  if (h === 0) return String(m);
  return m === 0 ? `${h}h` : `${h}:${pad(m)}`;
}
const BADGE = { x: -1.0, y: -1.1, w: 0.42, h: 0.17 };

function drawFace(sc) {
  const { c, ctx } = faceTex, S2 = c.width, u = S2 / FACE;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, S2, S2);
  ctx.setTransform(u, 0, 0, -u, S2 / 2, S2 / 2); // unit coords, y up, origin in the middle
  ctx.beginPath(); rrCanvas(ctx, FACE, FACE, 0.56);
  const gr = ctx.createRadialGradient(0, 0.3, 0.2, 0, 0, 2);
  gr.addColorStop(0, '#fbfbfa'); gr.addColorStop(1, '#e9ebea');
  ctx.fillStyle = gr; ctx.fill();

  ctx.save(); ctx.scale(1, -1); // text upright
  ctx.fillStyle = '#1b1b1b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < 12; i++) {
    const t = labelFor(i, sc), a = (i / 12) * TAU, R = 1.14;
    const size = t.length >= 4 ? 0.17 : t.length === 3 ? 0.2 : 0.25;
    ctx.font = `500 ${size}px ${FONT}`;
    let x = Math.sin(a) * R; const y = -Math.cos(a) * R;
    if (i === 0) x += 0.12;
    ctx.fillText(t, x, y);
  }
  // direction arrow from 0 towards the next label
  ctx.strokeStyle = '#1b1b1b'; ctx.lineWidth = 0.014; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(0, 0, 1.17, -Math.PI / 2 + 0.2, -Math.PI / 2 + 0.36); ctx.stroke();
  const ae = -Math.PI / 2 + 0.38, ax = Math.cos(ae) * 1.17, ay = Math.sin(ae) * 1.17;
  ctx.beginPath(); ctx.moveTo(ax - 0.055, ay - 0.035); ctx.lineTo(ax, ay); ctx.lineTo(ax - 0.05, ay + 0.04); ctx.stroke();
  // range badge
  ctx.lineWidth = 0.012;
  ctx.beginPath(); ctx.roundRect(BADGE.x - BADGE.w / 2, -BADGE.y - BADGE.h / 2, BADGE.w, BADGE.h, 0.08); ctx.stroke();
  ctx.font = `700 0.085px ${FONT}`; ctx.fillText(scaleBadge(sc), BADGE.x, -BADGE.y + 0.005);
  ctx.restore();
  faceTex.t.needsUpdate = true;
}
function rrCanvas(ctx, w, h, r) { ctx.roundRect(-w / 2, -h / 2, w, h, r); }

function drawTicks() {
  const { c, ctx } = tickTex, S2 = c.width, u = S2 / FACE;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, S2, S2);
  ctx.setTransform(u, 0, 0, -u, S2 / 2, S2 / 2);
  ctx.strokeStyle = '#151515'; ctx.lineCap = 'butt';
  const R = 0.96;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU, major = i % 5 === 0, quarter = i % 15 === 0;
    const len = quarter ? 0.2 : major ? 0.15 : 0.08;
    ctx.lineWidth = major ? 0.02 : 0.011;
    const s = Math.sin(a), co = Math.cos(a);
    ctx.beginPath(); ctx.moveTo(s * (R - len), co * (R - len)); ctx.lineTo(s * R, co * R); ctx.stroke();
  }
  ctx.lineWidth = 0.012; // zero line up to the rim
  ctx.beginPath(); ctx.moveTo(0, R); ctx.lineTo(0, FACE / 2); ctx.stroke();
  tickTex.t.needsUpdate = true;
}

let wedgeFrac = -1;
function setWedge(frac) {
  frac = clamp(frac, 0, 1);
  if (Math.abs(frac - wedgeFrac) < 0.0004) return;
  wedgeFrac = frac;
  wedge.geometry.dispose();
  if (frac <= 0) { wedge.geometry = new THREE.BufferGeometry(); return; }
  const len = frac * TAU, seg = Math.max(3, Math.ceil(256 * frac));
  // CircleGeometry runs counter-clockwise from +x; start at 12 o'clock minus the length so it ends at the top.
  wedge.geometry = new THREE.CircleGeometry(0.965, seg, Math.PI / 2 - len, len);
}

/* ------------------------------------------------------------------ tomatoes + confetti */
const tomatoes = [];
const tomatoMat = new THREE.MeshPhysicalMaterial({ color: '#e8302c', roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2 });
const leafMat = new THREE.MeshStandardMaterial({ color: '#2f9e44', roughness: 0.6 });
const tomatoGeo = new THREE.SphereGeometry(0.2, 32, 20);
const leafGeo = new THREE.ConeGeometry(0.04, 0.16, 4); leafGeo.translate(0, 0.08, 0);
function tomatoSlot(i) {
  const row = Math.floor(i / 8), col = [3, 4, 2, 5, 1, 6, 0, 7][i % 8]; // fill from the middle out
  return new THREE.Vector3(-1.75 + col * 0.5 + (row % 2) * 0.25 - 0.25, DESK_Y + 0.17, 1.55 + row * 0.5);
}
function addTomato(dropIn) {
  if (tomatoes.length >= 24) return;
  const g = new THREE.Group();
  const ball = new THREE.Mesh(tomatoGeo, tomatoMat); ball.scale.set(1, 0.85, 1); ball.castShadow = true; g.add(ball);
  for (let k = 0; k < 5; k++) {
    const l = new THREE.Mesh(leafGeo, leafMat);
    l.position.y = 0.16; l.rotation.set(Math.PI / 2 - 0.35, 0, 0); l.rotation.order = 'YXZ';
    l.rotation.y = (k / 5) * TAU; g.add(l);
  }
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.07, 6), leafMat); stem.position.y = 0.2; g.add(stem);
  const slot = tomatoSlot(tomatoes.length);
  g.position.copy(slot); g.rotation.y = Math.random() * TAU;
  g.userData = { kind: 'tomato', home: slot.clone(), vy: 0, y: dropIn ? 4.5 : 0, sq: 0, sqv: 0, spin: 0 };
  g.traverse((o) => { o.userData.kind = 'tomato'; o.userData.ref = g; });
  const sh = new THREE.Mesh(tomatoShadowGeo, new THREE.MeshBasicMaterial({ map: tomatoBlur.t, color: '#000', transparent: true, opacity: 0.4, depthWrite: false }));
  sh.rotation.x = -Math.PI / 2; sh.position.set(slot.x, DESK_Y + 0.004, slot.z); sh.renderOrder = 1;
  g.userData.shadow = sh; scene.add(sh);
  scene.add(g); tomatoes.push(g);
}
function syncTomatoes() {
  const n = Math.min(24, todayFocus().length);
  while (tomatoes.length > n) { const t = tomatoes.pop(); scene.remove(t); scene.remove(t.userData.shadow); }
  while (tomatoes.length < n) addTomato(false);
}

const CONF = 180;
const confetti = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.07, 0.01), new THREE.MeshStandardMaterial({ roughness: 0.5, side: THREE.DoubleSide }), CONF);
confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
confetti.castShadow = true; confetti.frustumCulled = false;
scene.add(confetti);
const parts = Array.from({ length: CONF }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), life: 0 }));
const dummy = new THREE.Object3D();
const confColors = ['#ff6b6b', '#ffd43b', '#51cf66', '#339af0', '#cc5de8', '#ff922b'].map((c) => new THREE.Color(c));
function hideConfetti() {
  dummy.scale.setScalar(0); dummy.updateMatrix();
  for (let i = 0; i < CONF; i++) confetti.setMatrixAt(i, dummy.matrix);
  confetti.instanceMatrix.needsUpdate = true;
}
function burst() {
  const top = new THREE.Vector3(0, 1.9, 0.3);
  root.localToWorld(top);
  parts.forEach((q, i) => {
    q.p.copy(top).add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 0.3, (Math.random() - 0.5) * 0.6));
    const a = Math.random() * TAU, s = 1.5 + Math.random() * 3.5;
    q.v.set(Math.cos(a) * s * 0.7, 2.5 + Math.random() * 3.5, Math.sin(a) * s * 0.4 + 1.4);
    q.r.set(Math.random() * TAU, Math.random() * TAU, 0);
    q.w.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20);
    q.life = 4 + Math.random() * 1.5;
    confetti.setColorAt(i, confColors[i % confColors.length]);
  });
  confetti.instanceColor.needsUpdate = true;
}
hideConfetti();

/* ------------------------------------------------------------------ motion state */
const M = {
  tx: 0, tvx: 0, ty: 0, tvy: 0, rz: 0, rvz: 0, // tilt springs
  hop: 0, hopV: 0, sq: 0, sqv: 0,              // hop + squash
  spinT: -1, spinTo: 0, spinSwapped: false,
  press: 0, pressV: 0,                          // knob press depth
  knobAngle: 0, ringT: -1, pulse: 0,
};
function spring(x, v, k, c, dt) { const a = -k * x - c * v; v += a * dt; x += v * dt; return [x, v]; }

/* ------------------------------------------------------------------ timer logic */
const remainingNow = () => (S.running ? Math.max(0, (S.endAt - Date.now()) / 1000) : S.remaining);
const pickScale = (sec) => SCALES.find((s) => s >= sec) || SCALES[SCALES.length - 1];

function changeScale(sc, animate = true) {
  if (sc === S.scale && M.spinT < 0) return;
  if (!animate) { S.scale = sc; drawFace(sc); syncScaleSelect(); return; }
  M.spinT = 0; M.spinTo = sc; M.spinSwapped = false; sfx.whoosh();
}
function ensureScaleFits(sec) {
  const target = M.spinT >= 0 ? M.spinTo : S.scale;
  if (sec > target) changeScale(pickScale(sec));
}

function setDuration(sec, phase) {
  sec = clamp(Math.round(sec), 0, MAX);
  stopRinging();
  S.running = false; S.total = sec; S.remaining = sec;
  S.phase = phase || (Object.keys(PRESETS).find((k) => PRESETS[k] === sec) || 'custom');
  const fit = pickScale(sec);
  if (fit !== S.scale) changeScale(fit);
  syncInputs(); syncUI(); save();
}
function start() {
  stopRinging();
  if (S.remaining <= 0) S.remaining = S.total;
  if (S.remaining <= 0) { toast('Set a time first'); poke(0.3); return; }
  ac();
  S.running = true; S.endAt = Date.now() + S.remaining * 1000;
  if (!S.startedAt) S.startedAt = Date.now();
  sfx.start(); M.pressV -= 3; M.hopV = 1.6;
  syncUI(); save(true);
}
function pause() {
  S.remaining = remainingNow(); S.running = false;
  sfx.pause(); M.pressV -= 2;
  syncUI(); save(true);
}
function toggle() { if (M.ringT >= 0) { stopRinging(); return; } S.running ? pause() : start(); }
function reset() {
  stopRinging();
  S.running = false; S.remaining = S.total; S.startedAt = 0;
  sfx.thunk(); M.rvz += 2.5;
  syncUI(); save();
}
function addTime(sec) {
  const r = clamp(remainingNow() + sec, 0, MAX);
  if (S.running) S.endAt = Date.now() + r * 1000; else S.remaining = r;
  if (r > S.total) { S.total = r; syncInputs(); }
  ensureScaleFits(r); sfx.click(); syncUI(); save();
}

let nextPhaseTimer = 0;
function finish() {
  const done = S.phase;
  S.running = false; S.remaining = 0;
  S.history.push({ t: Date.now(), p: done, d: S.total });
  S.startedAt = 0;
  save(true);
  M.ringT = 0; sfx.alarm(); burst();
  if (navigator.vibrate) try { navigator.vibrate([200, 100, 200, 100, 300]); } catch (e) { /* ignore */ }
  document.title = 'Time is up! · Visual Timer';
  let next = null;
  if (done === 'focus') {
    S.focusInCycle = (S.focusInCycle || 0) + 1;
    next = S.focusInCycle % 4 === 0 ? 'long' : 'short';
    setTimeout(() => { addTomato(true); bumpTally(); }, 600);
    toast(next === 'long' ? 'Four in a row. Take a long break.' : 'Focus done. Short break next.');
  } else if (done === 'short' || done === 'long') {
    next = 'focus'; toast('Break over. Back to focus.');
  } else toast('Time is up!');
  syncUI(); renderRecord();
  clearTimeout(nextPhaseTimer);
  if (next) {
    nextPhaseTimer = setTimeout(() => {
      if (S.running || S.remaining > 0) return; // user already moved on
      setDuration(PRESETS[next], next);
      if (S.auto) start();
    }, S.auto ? 4200 : 2600);
  }
}
function stopRinging() {
  if (M.ringT < 0) return;
  M.ringT = -1; sfx.stopAlarm();
  $('#digits').classList.remove('done');
}

/* ------------------------------------------------------------------ UI */
const inH = $('#inH'), inM = $('#inM'), inS = $('#inS');
const fmt = (sec, forceH) => {
  sec = Math.ceil(sec - 1e-6);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 || forceH ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};
function syncInputs() {
  const t = S.total;
  inH.value = pad(Math.floor(t / 3600)); inM.value = pad(Math.floor((t % 3600) / 60)); inS.value = pad(t % 60);
}
function readInputs() {
  const n = (el, max) => clamp(parseInt(el.value.replace(/\D/g, ''), 10) || 0, 0, max);
  return n(inH, 99) * 3600 + n(inM, 59) * 60 + n(inS, 59);
}
for (const el of [inH, inM, inS]) {
  el.addEventListener('focus', () => el.select());
  el.addEventListener('input', () => {
    el.value = el.value.replace(/\D/g, '').slice(0, 2);
    if (el.value.length === 2) { const nx = el === inH ? inM : el === inM ? inS : null; if (nx) nx.focus(); }
  });
  el.addEventListener('change', () => setDuration(readInputs()));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { setDuration(readInputs()); el.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const max = el === inH ? 99 : 59;
      const v = ((parseInt(el.value, 10) || 0) + (e.key === 'ArrowUp' ? 1 : -1) + max + 1) % (max + 1);
      el.value = pad(v); setDuration(readInputs()); sfx.click();
    }
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const max = el === inH ? 99 : 59;
    const v = ((parseInt(el.value, 10) || 0) + (e.deltaY < 0 ? 1 : -1) + max + 1) % (max + 1);
    el.value = pad(v); setDuration(readInputs()); sfx.click();
  }, { passive: false });
}

const sel = $('#selScale');
SCALES.forEach((sc) => { const o = document.createElement('option'); o.value = sc; o.textContent = scaleOption(sc); sel.appendChild(o); });
function syncScaleSelect() { sel.value = String(M.spinT >= 0 ? M.spinTo : S.scale); }
sel.addEventListener('change', () => {
  const sc = +sel.value;
  if (S.total > sc) { setDuration(sc); }
  if (remainingNow() > sc) { S.remaining = sc; if (S.running) S.endAt = Date.now() + sc * 1000; }
  changeScale(sc); save();
});

$('#btnStart').addEventListener('click', toggle);
$('#btnReset').addEventListener('click', reset);
$('#btnPlus').addEventListener('click', () => addTime(60));
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const p = b.dataset.preset; setDuration(PRESETS[p], p); sfx.click(); M.rvz += 1.5;
}));

const sw = $('#swatches');
THEMES.forEach((t, i) => {
  const b = document.createElement('button');
  b.className = 'swatch'; b.style.background = t.body; b.title = t.id; b.setAttribute('aria-label', `${t.id} colour`);
  b.addEventListener('click', () => setTheme(i, true));
  sw.appendChild(b);
});
const chkTick = $('#chkTick'), chkAuto = $('#chkAuto');
chkTick.checked = S.tick; chkAuto.checked = S.auto;
chkTick.addEventListener('change', () => { S.tick = chkTick.checked; save(); });
chkAuto.addEventListener('change', () => { S.auto = chkAuto.checked; save(); });
const btnSound = $('#btnSound');
function syncSound() { btnSound.classList.toggle('off', !S.sound); }
btnSound.addEventListener('click', () => { S.sound = !S.sound; syncSound(); save(); if (S.sound) sfx.pop(); else sfx.stopAlarm(); });

const help = $('#help');
$('#btnHelp').addEventListener('click', () => help.showModal());

function setTheme(i, bounce) {
  S.theme = (i + THEMES.length) % THEMES.length;
  const t = THEMES[S.theme];
  bodyMat.color.set(t.body); lipMat.color.set(t.lip); knobMat.color.set(t.lip); wedgeMat.color.set(t.wedge);
  const r = document.documentElement.style;
  r.setProperty('--bg1', t.bg1); r.setProperty('--bg2', t.bg2); r.setProperty('--accent', t.wedge); r.setProperty('--body', t.body);
  document.body.classList.toggle('dark', !!t.dark);
  document.querySelectorAll('.swatch').forEach((b, k) => b.classList.toggle('on', k === S.theme));
  if (bounce) { M.sqv += 6; M.hopV = 2.2; sfx.pop(); }
  save();
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  const hint = $('#hint'); if (!hint.hidden) hint.classList.add('fade');
}
function bumpTally() {
  const el = $('#tally'); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
}

let lastDigits = '', lastSec = -1;
function syncUI() {
  const r = remainingNow();
  const txt = fmt(r, S.total >= 3600);
  if (txt !== lastDigits) { $('#digits').textContent = txt; lastDigits = txt; }
  $('#phase').textContent = PHASE_NAME[S.phase] || 'Timer';
  $('#btnStart').textContent = M.ringT >= 0 ? 'Stop' : S.running ? 'Pause' : (r > 0 && r < S.total ? 'Resume' : 'Start');
  document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b.dataset.preset === S.phase));
  $('#tallyN').textContent = todayFocus().length;
  $('#digits').classList.toggle('done', M.ringT >= 0);
  if (M.ringT < 0) document.title = S.running ? `${fmt(r)} · ${PHASE_NAME[S.phase]}` : 'Visual Timer';
}

/* ------------------------------------------------------------------ record drawer */
const drawer = $('#record');
function openRecord(open) {
  if (open) { drawer.hidden = false; renderRecord(); requestAnimationFrame(() => drawer.classList.add('open')); }
  else { drawer.classList.remove('open'); setTimeout(() => { if (!drawer.classList.contains('open')) drawer.hidden = true; }, 380); }
}
$('#btnRecord').addEventListener('click', () => openRecord(drawer.hidden));
$('#btnCloseRecord').addEventListener('click', () => openRecord(false));
const human = (sec) => {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
};
function renderRecord() {
  if (drawer.hidden) return;
  const focus = S.history.filter((h) => h.p === 'focus');
  const byDay = {};
  focus.forEach((h) => { const k = dayKey(h.t); byDay[k] = (byDay[k] || 0) + h.d; });
  const today = dayKey(Date.now());
  const tf = todayFocus();
  $('#stToday').textContent = human(tf.reduce((a, h) => a + h.d, 0));
  $('#stSessions').textContent = tf.length;
  $('#stTotal').textContent = human(focus.reduce((a, h) => a + h.d, 0));
  let streak = 0; const d = new Date();
  if (!byDay[today]) d.setDate(d.getDate() - 1); // today not done yet does not break the streak
  while (byDay[dayKey(d)]) { streak++; d.setDate(d.getDate() - 1); }
  $('#stStreak').textContent = streak;

  const bars = $('#bars'); bars.innerHTML = '';
  const days = [];
  for (let i = 6; i >= 0; i--) { const x = new Date(); x.setDate(x.getDate() - i); days.push(x); }
  const max = Math.max(1500, ...days.map((x) => byDay[dayKey(x)] || 0));
  days.forEach((x) => {
    const k = dayKey(x), v = byDay[k] || 0;
    const el = document.createElement('div'); el.className = 'bar' + (k === today ? ' today' : '');
    el.title = `${k}: ${human(v)}`;
    el.innerHTML = `<i style="height:${Math.max(3, (v / max) * 100)}%"></i><span>${v ? human(v) : ''}</span><span>${x.toLocaleDateString(undefined, { weekday: 'narrow' })}</span>`;
    bars.appendChild(el);
  });

  const log = $('#log'); log.innerHTML = '';
  const recent = S.history.slice(-40).reverse();
  if (!recent.length) log.innerHTML = '<li class="empty">Nothing yet. Finish a timer and it shows up here.</li>';
  recent.forEach((h) => {
    const li = document.createElement('li'); li.className = h.p;
    const when = new Date(h.t);
    const dstr = dayKey(h.t) === today ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : when.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `<span class="k">${PHASE_NAME[h.p] || 'Timer'} · ${fmt(h.d)}</span><span class="t">${dstr}</span>`;
    log.appendChild(li);
  });
  $('#storeNote').textContent = store.mode === 'cookie' ? 'Saved in a cookie (storage blocked)' : 'Saved in this browser';
}
$('#btnClear').addEventListener('click', () => {
  if (!confirm('Clear all saved sessions and tomatoes?')) return;
  S.history = []; S.focusInCycle = 0; save(true); syncTomatoes(); syncUI(); renderRecord();
  toast('Record cleared');
});
$('#btnExport').addEventListener('click', () => {
  const rows = ['ended_at,phase,seconds', ...S.history.map((h) => `${new Date(h.t).toISOString()},${h.p},${h.d}`)];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = 'visual-timer-record.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ------------------------------------------------------------------ pointer interaction */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const pickables = [body, lip, face, knob, led];
let drag = null;

function setNdc(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function hitTest(e) {
  setNdc(e);
  const hits = ray.intersectObjects([...pickables, ...tomatoes], true);
  return hits.length ? hits[0] : null;
}
const facePlane = new THREE.Plane(), tmpV = new THREE.Vector3(), tmpN = new THREE.Vector3();
function dialPoint(e) {
  setNdc(e);
  face.updateMatrixWorld();
  tmpN.set(0, 0, 1).transformDirection(face.matrixWorld);
  facePlane.setFromNormalAndCoplanarPoint(tmpN, face.getWorldPosition(tmpV));
  const p = new THREE.Vector3();
  if (!ray.ray.intersectPlane(facePlane, p)) return null;
  return face.worldToLocal(p);
}
const angleOf = (p) => { let a = Math.atan2(p.x, p.y); if (a < 0) a += TAU; return a; };
const wrapPi = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

function stepFor(e) { return e.shiftKey ? Math.max(1, S.scale / 3600) : S.scale / 60; }
function dialSet(sec, e) {
  const st = stepFor(e);
  const v = clamp(Math.round(sec / st) * st, 0, S.scale);
  if (v !== drag.lastVal) {
    sfx.click(); drag.lastVal = v;
    if (navigator.vibrate) try { navigator.vibrate(4); } catch (err) { /* ignore */ }
  }
  S.remaining = v; S.total = v;
  S.phase = Object.keys(PRESETS).find((k) => PRESETS[k] === v) || 'custom';
  syncInputs(); syncUI();
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  ac();
  canvas.setPointerCapture(e.pointerId);
  const h = hitTest(e);
  const kind = h ? (h.object.userData.kind || 'none') : 'none';
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, kind, hit: h, lastVal: -1 };
  if (S.seenHint === false) { S.seenHint = true; save(); $('#hint').classList.add('fade'); }

  if (kind === 'face') {
    const p = face.worldToLocal(h.point.clone());
    if (Math.abs(p.x - BADGE.x) < BADGE.w / 2 + 0.05 && Math.abs(p.y - BADGE.y) < BADGE.h / 2 + 0.05) { drag.kind = 'badge'; return; }
    if (Math.hypot(p.x, p.y) < 1.3) {
      drag.kind = 'dial'; startDial(e, p);
    } else drag.kind = 'body';
  }
  if (drag.kind === 'knob') { M.pressV -= 4; sfx.thunk(); }
  if (drag.kind === 'body' || drag.kind === 'none') {
    drag.kind = drag.kind === 'none' ? 'tilt' : 'body';
    drag.tx0 = M.tx; drag.ty0 = M.ty;
  }
  canvas.classList.add('dragging');
});

function startDial(e, p) {
  stopRinging(); clearTimeout(nextPhaseTimer);
  drag.wasRunning = S.running;
  if (S.running) { S.remaining = remainingNow(); S.running = false; }
  drag.acc = angleOf(p);
  // grabbing near the top of a full dial means "keep it full", not "drop to zero"
  if (S.remaining >= S.scale * 0.95 && drag.acc < 0.35) drag.acc = TAU;
  drag.prevA = angleOf(p);
  dialSet((drag.acc / TAU) * S.scale, e);
}

canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (e.pointerType === 'mouse') {
      const h = hitTest(e), k = h && h.object.userData.kind;
      canvas.classList.toggle('pointer', k === 'knob' || k === 'led' || k === 'tomato' || k === 'face');
    }
    return;
  }
  if (e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) > 6) {
    drag.moved = true;
    if (drag.kind === 'knob') { // turning the knob works like turning the dial
      const p = dialPoint(e);
      if (p) { drag.kind = 'dial'; startDial(e, p); }
    }
    if (drag.kind === 'tomato' || drag.kind === 'led' || drag.kind === 'badge') { drag.kind = 'tilt'; drag.tx0 = M.tx; drag.ty0 = M.ty; }
  }
  if (drag.kind === 'dial') {
    const p = dialPoint(e); if (!p) return;
    const a = angleOf(p);
    drag.acc = clamp(drag.acc + wrapPi(a - drag.prevA), 0, TAU);
    drag.prevA = a;
    dialSet((drag.acc / TAU) * S.scale, e);
  } else if ((drag.kind === 'tilt' || drag.kind === 'body') && drag.moved) {
    const ny = clamp(drag.ty0 + dx * 0.007, -1.1, 1.1), nx = clamp(drag.tx0 + dy * 0.005, -0.55, 0.55);
    M.tvy = (ny - M.ty) * 60; M.tvx = (nx - M.tx) * 60;
    M.ty = ny; M.tx = nx;
  }
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag; drag = null;
  canvas.classList.remove('dragging');
  if (d.kind === 'dial') {
    if (S.remaining > 0 && d.wasRunning) start();
    else { syncUI(); }
    save();
  } else if (!d.moved) {
    if (d.kind === 'knob') toggle();
    else if (d.kind === 'led') setTheme(S.theme + 1, true);
    else if (d.kind === 'badge') cycleScale();
    else if (d.kind === 'tomato') squishTomato(d.hit.object.userData.ref);
    else if (d.kind === 'body') poke(d.hit ? d.hit.point.x : 0);
    else if (M.ringT >= 0) stopRinging();
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (S.running && M.ringT < 0) { addTime(e.deltaY < 0 ? S.scale / 60 : -S.scale / 60); return; }
  const st = S.scale / 60;
  const v = clamp(Math.round((S.remaining + (e.deltaY < 0 ? st : -st)) / st) * st, 0, S.scale);
  stopRinging();
  S.remaining = v; S.total = v; S.phase = Object.keys(PRESETS).find((k) => PRESETS[k] === v) || 'custom';
  sfx.click(); syncInputs(); syncUI(); save();
}, { passive: false });

function poke(x) {
  M.hopV = 3.2; M.rvz += (x >= 0 ? -1 : 1) * 3.5; M.sqv -= 4; sfx.boing();
}
function squishTomato(t) {
  if (!t) return;
  const u = t.userData; u.vy = 3.4 + Math.random(); u.sqv -= 6; u.spin = (Math.random() - 0.5) * 18; sfx.pop();
}
function cycleScale() {
  const minSc = pickScale(remainingNow());
  const cur = SCALES.indexOf(M.spinT >= 0 ? M.spinTo : S.scale);
  let next = SCALES[(cur + 1) % SCALES.length];
  if (next < minSc) next = minSc;
  if (next === S.scale) next = SCALES[(SCALES.indexOf(next) + 1) % SCALES.length];
  changeScale(next); toast(scaleOption(next)); save();
}

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || help.open) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (k === 'r') reset();
  else if (k === 'c') setTheme(S.theme + 1, true);
  else if (k === 'm') btnSound.click();
  else if (k === 'h') openRecord(drawer.hidden);
  else if (k === '?' || k === '/') help.showModal();
  else if (e.key === 'ArrowUp') { e.preventDefault(); addTime(60); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); addTime(-60); }
  else if (k === 'escape') openRecord(false);
});

/* ------------------------------------------------------------------ layout + loop */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // free area for the timer: below the top bar and beside or above the panel
  const pr = OG ? { left: w - 600, top: h } : document.getElementById('panel').getBoundingClientRect();
  const side = OG || pr.left > w * 0.45;
  const top = OG ? 0 : 60, bottom = side ? h - 8 : pr.top - 8;
  const left = 0, right = side ? pr.left - 8 : w;
  const aw = right - left, ah = Math.max(120, bottom - top);
  const worldH = 4.9, worldW = 5.4, tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dH = (worldH * h / ah) / (2 * tanH);
  const dW = (worldW * w / aw) / (2 * tanH * camera.aspect);
  const d = Math.max(dH, dW, 10);
  const dir = new THREE.Vector3(2.0, 1.5, 12.5).normalize();
  camera.position.copy(camTarget).addScaledVector(dir, d);
  camera.lookAt(camTarget);
  // move the picture so the timer sits in the middle of the free area
  const offX = w / 2 - (left + right) / 2, offY = h / 2 - (top + bottom) / 2;
  camera.setViewOffset(w, h, offX, offY, w, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function checkFinish() {
  if (S.running && Date.now() >= S.endAt) finish();
}
setInterval(() => { checkFinish(); if (document.hidden) syncUI(); }, 500);

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20), t = clock.elapsedTime;
  checkFinish();
  const rem = remainingNow();

  // per-second effects
  const secNow = Math.ceil(rem);
  if (S.running && secNow !== lastSec) {
    if (S.tick && lastSec >= 0) sfx.tick(secNow % 2 === 0);
    if (secNow <= 10 && secNow > 0) { M.pulse = 1; if (!S.tick) sfx.tick(true); }
    lastSec = secNow;
  }
  M.pulse = Math.max(0, M.pulse - dt * 3.5);

  // springs
  if (!drag || (drag.kind !== 'tilt' && drag.kind !== 'body') || !drag.moved) {
    [M.tx, M.tvx] = spring(M.tx, M.tvx, 55, 4.5, dt);
    [M.ty, M.tvy] = spring(M.ty, M.tvy, 45, 3.6, dt);
  }
  [M.rz, M.rvz] = spring(M.rz, M.rvz, 90, 5, dt);
  [M.sq, M.sqv] = spring(M.sq, M.sqv, 160, 9, dt);
  [M.press, M.pressV] = spring(M.press, M.pressV, 260, 18, dt);
  M.hopV -= 22 * dt; M.hop += M.hopV * dt;
  if (M.hop < 0) {
    if (M.hopV < -1.5) M.sqv -= Math.min(6, -M.hopV * 0.8);
    M.hop = 0; M.hopV = Math.abs(M.hopV) > 1.2 ? -M.hopV * 0.3 : 0;
  }

  // ringing: an alarm-clock dance
  let ring = 0;
  if (M.ringT >= 0) {
    M.ringT += dt;
    const fade = Math.max(0, 1 - M.ringT / 4.5);
    ring = Math.sin(t * 48) * 0.07 * fade;
    if (M.hop === 0 && fade > 0 && Math.random() < 0.25) M.hopV = 1.3;
    const blink = Math.sin(t * 18) > 0;
    ledMat.emissive.set('#ff3b30'); ledMat.emissiveIntensity = blink ? 3 : 0.2;
    glow.material.color.set('#ff3b30'); glow.material.opacity = blink ? 0.9 : 0;
    if (M.ringT > 4.5) stopRinging(), syncUI();
  } else if (S.running) {
    const ph = (Date.now() - S.endAt) / 1000;
    const beat = Math.pow(Math.max(0, Math.cos((ph % 1) * Math.PI)), 6);
    ledMat.emissive.set('#22ff66'); ledMat.emissiveIntensity = 0.8 + beat * 2.2;
    glow.material.color.set('#22ff66'); glow.material.opacity = 0.35 + beat * 0.5;
  } else {
    ledMat.emissiveIntensity = Math.max(0, ledMat.emissiveIntensity - dt * 4);
    glow.material.opacity = Math.max(0, glow.material.opacity - dt * 3);
  }

  // scale-change spin
  let spin = 0;
  if (M.spinT >= 0) {
    M.spinT += dt / 0.85;
    if (!M.spinSwapped && M.spinT >= 0.5) { M.spinSwapped = true; S.scale = M.spinTo; drawFace(S.scale); syncScaleSelect(); save(); }
    if (M.spinT >= 1) { M.spinT = -1; } else spin = ease(M.spinT) * TAU;
  }

  // idle float
  const idle = drag ? 0 : Math.sin(t * 0.8) * 0.025;
  root.position.y = M.hop;
  root.rotation.set(0, REST_Y + spin, 0);
  contact.rotation.y = REST_Y + spin + M.ty * 0.3;
  contact.material.opacity = 0.42 * clamp(1 - M.hop / 1.2 - Math.abs(M.tx) * 0.8, 0.15, 1);
  const cs = 1 + M.hop * 0.25; contact.scale.set(cs, cs, 1);
  tilt.rotation.set(M.tx + idle, M.ty, M.rz + ring);
  const sq = M.sq * 0.06, pul = M.pulse * 0.025;
  tilt.scale.set(1 - sq * 0.5 + pul, 1 + sq + pul, 1 - sq * 0.5 + pul);
  tilt.position.y = (tilt.scale.y - 1) * 1.8; // squash about the desk, not the middle

  // wedge + knob
  const frac = rem / S.scale;
  setWedge(frac);
  const targetKnob = -clamp(frac, 0, 1) * TAU;
  M.knobAngle += (targetKnob - M.knobAngle) * Math.min(1, dt * 18);
  knob.rotation.z = M.knobAngle;
  knob.position.z = FRONT + 0.012 + M.press * 0.02;

  // tomatoes
  for (const g of tomatoes) {
    const u = g.userData;
    u.vy -= 20 * dt; u.y += u.vy * dt;
    if (u.y < 0) {
      if (u.vy < -2) { u.sqv -= Math.min(10, -u.vy * 0.9); if (u.vy < -5) sfx.tick(false); }
      u.y = 0; u.vy = Math.abs(u.vy) > 1.5 ? -u.vy * 0.38 : 0;
    }
    [u.sq, u.sqv] = spring(u.sq, u.sqv, 220, 10, dt);
    u.spin *= Math.pow(0.1, dt);
    g.rotation.y += u.spin * dt;
    g.position.set(u.home.x, u.home.y + u.y, u.home.z);
    u.shadow.material.opacity = 0.4 * clamp(1 - u.y / 1.5, 0.1, 1);
    u.shadow.scale.setScalar(1 + u.y * 0.3);
    const s = u.sq * 0.12;
    g.scale.set(1 - s * 0.6, 1 + s, 1 - s * 0.6);
  }

  // confetti
  let anyLive = false;
  for (let i = 0; i < CONF; i++) {
    const q = parts[i];
    if (q.life <= 0) continue;
    anyLive = true;
    q.life -= dt;
    q.v.y -= 9 * dt; q.v.multiplyScalar(Math.pow(0.55, dt));
    q.p.addScaledVector(q.v, dt);
    if (q.p.y < DESK_Y + 0.02) { q.p.y = DESK_Y + 0.02; q.v.set(0, 0, 0); q.w.multiplyScalar(0.9); q.r.x = Math.PI / 2; }
    q.r.x += q.w.x * dt; q.r.y += q.w.y * dt; q.r.z += q.w.z * dt;
    dummy.position.copy(q.p); dummy.rotation.copy(q.r);
    dummy.scale.setScalar(q.life > 0.6 ? 1 : Math.max(0, q.life / 0.6));
    dummy.updateMatrix(); confetti.setMatrixAt(i, dummy.matrix);
  }
  if (anyLive) confetti.instanceMatrix.needsUpdate = true;

  if (S.running || M.ringT >= 0 || (drag && drag.kind === 'dial')) syncUI();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ brag card */
const SITE = 'https://hong-iron.github.io/VISUAL-TIMER/';
const RANKS = [ // minutes of focus in one day
  [0, 'Just warming up'], [25, 'Tomato Sprout'], [50, 'Steady Ticker'], [100, 'Pomodoro Pro'],
  [200, 'Focus Machine'], [300, 'Deep Work Wizard'], [480, 'Time Lord'],
];
const PERIODS = {
  today: { label: 'today', days: 1, rankScale: 1 },
  week: { label: 'in the last 7 days', days: 7, rankScale: 5 },
  all: { label: 'all time', days: 0, rankScale: 30 },
};
function focusByDay() {
  const byDay = {};
  S.history.forEach((h) => { if (h.p === 'focus') { const k = dayKey(h.t); byDay[k] = (byDay[k] || 0) + h.d; } });
  return byDay;
}
function streakDays(byDay) {
  let n = 0; const d = new Date();
  if (!byDay[dayKey(d)]) d.setDate(d.getDate() - 1);
  while (byDay[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function periodStats(pk) {
  const P = PERIODS[pk], byDay = focusByDay();
  let since = 0;
  if (P.days) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (P.days - 1)); since = d.getTime(); }
  const items = S.history.filter((h) => h.p === 'focus' && h.t >= since);
  const sec = items.reduce((a, h) => a + h.d, 0);
  const days = Object.entries(byDay).filter(([k]) => !P.days || new Date(k + 'T00:00').getTime() >= since);
  const best = days.reduce((a, [, v]) => Math.max(a, v), 0);
  const mins = sec / 60 / P.rankScale;
  const rank = RANKS.filter(([m]) => mins >= m).pop()[1];
  return { sec, n: items.length, streak: streakDays(byDay), best, rank, byDay, label: P.label };
}

// Render the live 3D timer into an image, framed for the card.
function snapshot(w, h) {
  const prevW = renderer.domElement.width, prevH = renderer.domElement.height;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.clearViewOffset();
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const d = Math.max(4.9 / (2 * tanH), 5.6 / (2 * tanH * camera.aspect));
  camera.position.copy(camTarget).addScaledVector(new THREE.Vector3(2.0, 1.5, 12.5).normalize(), d);
  camera.lookAt(camTarget); camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(renderer.domElement, 0, 0, w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  resize();
  void prevW; void prevH;
  return c;
}

function drawTomato(g, x, y, r) {
  const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  gr.addColorStop(0, '#ff8a7a'); gr.addColorStop(0.55, '#e3262b'); gr.addColorStop(1, '#a8151a');
  g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, r, r * 0.88, 0, 0, TAU); g.fill();
  g.fillStyle = '#2f9e44';
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k / 5) * TAU;
    g.beginPath(); g.ellipse(x + Math.cos(a) * r * 0.22, y - r * 0.8 + Math.sin(a) * r * 0.12, r * 0.3, r * 0.1, a, 0, TAU); g.fill();
  }
}

function makeCard(pk) {
  const st = periodStats(pk), t = THEMES[S.theme];
  const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const ink = t.dark ? '#f2f4f6' : '#1b211e', muted = t.dark ? 'rgba(242,244,246,0.6)' : 'rgba(27,33,30,0.55)';
  const tile = t.dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.6)';
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, t.bg1); bg.addColorStop(1, t.bg2);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const F = (w, s) => `${w} ${s}px Inter, "Helvetica Neue", Arial, sans-serif`;

  // header
  g.fillStyle = t.body; g.beginPath(); g.roundRect(64, 60, 44, 44, 13); g.fill();
  g.fillStyle = '#f3f3f1'; g.beginPath(); g.arc(86, 82, 14, 0, TAU); g.fill();
  g.fillStyle = t.wedge; g.beginPath(); g.moveTo(86, 82); g.arc(86, 82, 14, -Math.PI / 2, 0.6); g.fill();
  g.fillStyle = ink; g.font = F(700, 34); g.textBaseline = 'middle'; g.fillText('Visual Timer', 124, 84);
  g.textAlign = 'right'; g.fillStyle = muted; g.font = F(600, 28);
  const now = new Date();
  g.fillText(pk === 'today' ? now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : pk === 'week' ? 'Last 7 days' : 'All time', W - 64, 84);
  g.textAlign = 'left';

  // the 3D timer
  const shot = snapshot(900, 640);
  g.drawImage(shot, (W - 900) / 2, 120);

  // headline number
  let y = 820;
  g.fillStyle = ink; g.textBaseline = 'alphabetic'; g.textAlign = 'center';
  g.font = F(800, st.sec >= 36000 ? 132 : 150); g.fillText(human(st.sec), W / 2, y);
  g.fillStyle = muted; g.font = F(600, 34); g.fillText(`of deep focus ${st.label}`, W / 2, y + 56);

  // rank pill
  g.font = F(800, 34);
  const rw = g.measureText(st.rank.toUpperCase()).width + 64;
  g.fillStyle = t.wedge; g.beginPath(); g.roundRect((W - rw) / 2, y + 92, rw, 64, 32); g.fill();
  g.fillStyle = '#fff'; g.fillText(st.rank.toUpperCase(), W / 2, y + 136);

  // tomato row
  y = 1050;
  const shown = Math.min(st.n, 12), r = 24, gap = 60;
  const x0 = W / 2 - ((shown - 1) * gap) / 2 - (st.n > 12 ? 40 : 0);
  for (let i = 0; i < shown; i++) drawTomato(g, x0 + i * gap, y, r);
  g.textAlign = 'left'; g.fillStyle = ink; g.font = F(800, 34);
  if (st.n > 12) g.fillText(`+${st.n - 12}`, x0 + shown * gap - 20, y + 12);
  if (!st.n) { g.textAlign = 'center'; g.fillStyle = muted; g.font = F(600, 28); g.fillText('No tomatoes yet. Watch this space.', W / 2, y + 10); }

  // stat tiles
  y = 1110;
  const tiles = [[String(st.n), st.n === 1 ? 'session' : 'sessions'], [String(st.streak), 'day streak'],
    pk === 'today' ? [String(Math.round(st.sec / 60)), 'minutes'] : [human(st.best), 'best day']];
  const tw = (W - 128 - 32) / 3;
  tiles.forEach(([v, k], i) => {
    const x = 64 + i * (tw + 16);
    g.fillStyle = tile; g.beginPath(); g.roundRect(x, y, tw, 120, 24); g.fill();
    g.textAlign = 'center'; g.fillStyle = ink; g.font = F(800, 46); g.fillText(v, x + tw / 2, y + 62);
    g.fillStyle = muted; g.font = F(600, 24); g.fillText(k, x + tw / 2, y + 98);
  });

  // footer
  g.fillStyle = muted; g.font = F(600, 26); g.textAlign = 'center';
  g.fillText('Beat me at  ' + SITE.replace('https://', '').replace(/\/$/, ''), W / 2, H - 52);
  return { canvas: c, st };
}

function bragText(pk, st) {
  const what = pk === 'today' ? 'today' : pk === 'week' ? 'in the last 7 days' : 'so far';
  const streak = st.streak > 1 ? `, ${st.streak}-day streak` : '';
  return `I focused ${human(st.sec)} ${what} with ${st.n} 🍅${streak}. Rank: ${st.rank}. Beat that:`;
}

const shareDlg = $('#share');
let card = null, cardPeriod = 'today';
function buildCard() {
  card = makeCard(cardPeriod);
  $('#cardImg').src = card.canvas.toDataURL('image/png');
  document.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('on', b.dataset.period === cardPeriod));
  const txt = bragText(cardPeriod, card.st);
  $('#btnX').href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(txt)}&url=${encodeURIComponent(SITE)}`;
}
function openShare() {
  // default to the period with something to brag about
  if (!todayFocus().length) cardPeriod = S.history.some((h) => h.p === 'focus') ? 'all' : 'today';
  buildCard(); shareDlg.showModal();
}
document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { cardPeriod = b.dataset.period; buildCard(); }));
$('#btnBrag').addEventListener('click', openShare);
const cardBlob = () => new Promise((res) => card.canvas.toBlob(res, 'image/png'));
$('#btnShareNative').addEventListener('click', async () => {
  const txt = bragText(cardPeriod, card.st);
  try {
    const file = new File([await cardBlob()], 'visual-timer-brag.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: `${txt} ${SITE}` });
    } else if (navigator.share) {
      await navigator.share({ text: txt, url: SITE });
    } else {
      $('#btnSave').click(); toast('Image saved. Attach it anywhere.');
    }
  } catch (e) { if (e && e.name !== 'AbortError') toast('Sharing failed. Try saving the image.'); }
});
$('#btnSave').addEventListener('click', async () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await cardBlob());
  a.download = `visual-timer-${cardPeriod}-${dayKey(Date.now())}.png`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#btnCopy').addEventListener('click', async () => {
  const txt = `${bragText(cardPeriod, card.st)} ${SITE}`;
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob(), 'text/plain': new Blob([txt], { type: 'text/plain' }) })]);
      toast('Card and text copied');
    } else { await navigator.clipboard.writeText(txt); toast('Text copied'); }
  } catch (e) {
    try { await navigator.clipboard.writeText(txt); toast('Text copied'); } catch (e2) { toast('Copy blocked by the browser'); }
  }
});

/* ------------------------------------------------------------------ boot */
drawFace(S.scale); drawTicks();
if (document.fonts) document.fonts.ready.then(() => drawFace(S.scale));
setTheme(S.theme, false);
syncSound(); syncInputs(); syncScaleSelect(); syncTomatoes();
// a timer that ran out while the page was closed still counts
if (S.running && Date.now() >= S.endAt) {
  S.running = false; S.remaining = 0;
  S.history.push({ t: S.endAt, p: S.phase, d: S.total });
  if (S.phase === 'focus') S.focusInCycle = (S.focusInCycle || 0) + 1;
  save(true); syncTomatoes();
  setTimeout(() => toast(`${PHASE_NAME[S.phase]} finished while you were away`), 600);
}
syncUI(); resize();
if (OG) {
  document.body.classList.add('og');
  S.total = 1500; S.remaining = 1100; S.phase = 'focus';
  for (let i = 0; i < 4; i++) addTomato(false);
  syncUI(); resize();
} else if (!S.seenHint) {
  const hint = $('#hint'); hint.hidden = false;
  setTimeout(() => hint.classList.add('fade'), 9000);
}
window.addEventListener('beforeunload', () => {
  if (S.running) S.remaining = remainingNow();
  save(true);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
requestAnimationFrame(frame);
window.__vt = { S, start, pause, reset, setDuration, finish: () => { S.endAt = Date.now(); S.running = true; }, camera, root };
