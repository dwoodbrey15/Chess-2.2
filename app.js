import { pieceSVG, NAMES, LETTERS } from './pieces.js?v=25';

const ROWS = 10, COLS = 10, NSQ = 100;
const K = { MOVE: 0, DOUBLE: 1, EP: 2, CASTLE: 3, FIRE: 4, CONVERT: 5, BOMBARD: 6, SWAP: 7, PROMOTE: 8, PASS: 16 };
const P = { PAWN: 1, KING: 6 };
const PROMOS = [5, 4, 2, 3, 7, 8, 9, 10];   // queen, rook, knight, bishop, archer, wizard, catapult, joker
const LEVELS = { 300: { ms: 300, depth: 3 }, 1000: { ms: 1000, depth: 0 }, 3000: { ms: 3000, depth: 0 }, 8000: { ms: 8000, depth: 0 } };
const DZ_LO = 2, DZ_HI = 7;   // the Dragon's 6 x 6 ground, rows and columns c..h / 3..8
const mFrom = m => m & 127, mTo = m => (m >> 7) & 127, mKind = m => (m >> 14) & 31, mPromo = m => (m >> 19) & 31;
const rowOf = s => Math.floor(s / COLS), colOf = s => s % COLS;
const cheb = (a, b) => Math.max(Math.abs(rowOf(a) - rowOf(b)), Math.abs(colOf(a) - colOf(b)));
const inZone = s => rowOf(s) >= DZ_LO && rowOf(s) <= DZ_HI && colOf(s) >= DZ_LO && colOf(s) <= DZ_HI;
const sqName = s => String.fromCharCode(97 + colOf(s)) + (rowOf(s) + 1);
const $ = id => document.getElementById(id);
const host = window.chrome && window.chrome.webview;   // the Windows app
// touch devices get lighter effects: no blur glow on the animation shapes and fewer sparks (iOS draws SVG blur slowly)
const LITE = matchMedia('(hover: none)').matches;

// the 2 x 2 block a Catapult bombard hits (anchors are coded on an 11-wide grid so blocks may hang off the edge)
function blastSquares(anchor) {
  const ar = Math.floor(anchor / 11) - 1, ac = anchor % 11 - 1, out = [];
  for (const [i, j] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    const r = ar + i, c = ac + j;
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) out.push(r * COLS + c);
  }
  return out;
}

// ------------------------------------------------------------------ engine
// The UI thread's engine instance owns the game; a worker with its own instance does the thinking,
// so the board stays responsive while the engine searches.
let ex, worker = null, reqId = 0, pending = null;

async function loadEngine() {
  const bytes = await (await fetch('engine.wasm?v=25')).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, { env: { now: () => performance.now() } });
  ex = instance.exports;
  ex.init();
}

function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker('worker.js?v=25');
  worker.onmessage = e => onWorker(e.data);
}

function onWorker(d) {
  if (!pending || d.id !== pending.id) return;
  const req = pending; pending = null;
  st.thinking = false;
  if (ex.moveCount() !== req.moveCount) { schedule(); return; }
  st.evalWhite = d.score * req.side;
  st.engineInfo = { depth: d.depth, nodes: d.nodes };
  if (req.hint) { st.hint = d.best; render(); return; }
  if (d.best) playMove(d.best);
  else render();
}

// ------------------------------------------------------------------ state
const STORE = 'chess2-v2';
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } })();
const st = {
  layout: 0,
  mode: saved.mode || 'engine', human: saved.human || 1, strength: saved.strength || 1000, flipped: false,
  selected: -1, targets: new Map(), blast: null, hint: 0, last: 0, thinking: false, evalWhite: null, engineInfo: null,
  notes: [], overlayDismissed: false,
  shown: null,   // while the Dragon waits for its turn: the board after the move, before it acts
};
let board = new Int8Array(NSQ), legal = [], act = -1;

function gameMoves() { const out = []; for (let i = 0; i < ex.moveCount(); i++) out.push(ex.moveAt(i)); return out; }

function persist() {
  try { localStorage.setItem(STORE, JSON.stringify({ mode: st.mode, human: st.human, strength: st.strength, layout: st.layout, moves: gameMoves() })); }
  catch { /* storage unavailable */ }
}

function readState() {
  board = st.shown ? st.shown.slice() : new Int8Array(ex.memory.buffer, ex.boardPtr(), NSQ).slice();
  act = ex.actSquare();
  const n = ex.legalMoves();
  legal = Array.from(new Int32Array(ex.memory.buffer, ex.movesPtr(), n));
}

function humanTurn() {
  if (ex.result() || st.shown) return false;
  if (st.mode === 'two') return true;
  if (st.mode === 'watch') return false;
  return ex.sideToMove() === st.human;
}

// ------------------------------------------------------------------ notation
function notate(m, before) {
  const k = mKind(m), from = mFrom(m), to = mTo(m), pr = mPromo(m);
  const promo = pr ? '=' + LETTERS[pr] : '';
  const t = Math.abs(before[from]);
  switch (k) {
    case K.MOVE: {
      const cap = before[to] !== 0;
      if (t === P.PAWN) return (cap ? sqName(from)[0] + 'x' : '') + sqName(to) + promo;
      return LETTERS[t] + (cap ? 'x' : '') + sqName(to);
    }
    case K.PASS: return '';
    case K.DOUBLE: return sqName(to);
    case K.EP: return sqName(from)[0] + 'x' + sqName(to);
    case K.CASTLE: return colOf(to) < colOf(from) ? 'O-O-O' : 'O-O';
    case K.FIRE: return 'A›' + sqName(to);
    case K.CONVERT: return 'W~' + sqName(to) + promo;
    case K.BOMBARD: return 'C✷' + blastSquares(to).map(sqName).join('');
    case K.SWAP: return 'J⇄' + sqName(to) + promo;
    case K.PROMOTE: return '=' + LETTERS[pr];
  }
  return '?';
}

// ------------------------------------------------------------------ board
const boardEl = $('board');
const squares = [], shownCls = [], shownHtml = [];
function buildBoard() {
  boardEl.innerHTML = '';
  for (let i = 0; i < NSQ; i++) {
    const el = document.createElement('div');
    el.className = 'sq';
    el.addEventListener('click', () => onSquare(displayIndexToSquare(i)));
    boardEl.appendChild(el);
    squares.push(el);
  }
}
function displayIndexToSquare(i) {
  const vr = Math.floor(i / COLS), vc = i % COLS;
  return st.flipped ? vr * COLS + (COLS - 1 - vc) : (ROWS - 1 - vr) * COLS + vc;
}
const squareToDisplayIndex = s => st.flipped ? rowOf(s) * COLS + (COLS - 1 - colOf(s)) : (ROWS - 1 - rowOf(s)) * COLS + colOf(s);
const squareEl = s => squares[squareToDisplayIndex(s)];

function markerFor(list, s) {
  const kinds = new Set(list.map(o => o.kind));
  if (kinds.has(K.FIRE)) return 'mk-fire';
  if (kinds.has(K.CONVERT)) return 'mk-convert';
  if (kinds.has(K.CASTLE)) return 'mk-castle';
  if (kinds.has(K.SWAP) && board[s] && kinds.has(K.MOVE)) return 'mk-cap mk-also-swap';   // tap to choose
  if (kinds.has(K.SWAP)) return 'mk-swap';
  if (kinds.has(K.BOMBARD) && kinds.size === 1) return 'mk-blast';
  if (board[s] || kinds.has(K.EP)) return 'mk-cap';
  return 'mk-move';
}

// Only squares whose look changed are touched, so a render costs little even on a phone.
function render() {
  readState();
  const danger = !st.shown && ex.inDanger() ? ex.sideToMove() : 0;
  const drag = st.shown ? st.shownDrag : ex.dragonSquare(), wild = !ex.dragonOwner();
  const lastSquares = new Set();
  if (st.last) {
    const k = mKind(st.last);
    if (k === K.BOMBARD) lastSquares.add(mFrom(st.last));
    else if (k !== K.PROMOTE && k !== K.PASS) { lastSquares.add(mFrom(st.last)); lastSquares.add(mTo(st.last)); }
  }
  const preview = st.blast ? new Set(blastSquares(mTo(st.blast.options[st.blast.idx]))) : null;
  const hint = st.hint ? new Set(mKind(st.hint) === K.BOMBARD ? [mFrom(st.hint), ...blastSquares(mTo(st.hint))] : [mFrom(st.hint), mTo(st.hint)]) : null;
  for (let i = 0; i < NSQ; i++) {
    const s = displayIndexToSquare(i), r = rowOf(s), c = colOf(s), pc = board[s];
    let cls = 'sq ' + ((r + c) % 2 ? 'l' : 'd');
    if (lastSquares.has(s)) cls += ' last';
    if (s === st.selected) cls += ' sel';
    if (hint && hint.has(s)) cls += ' hint';
    if (preview && preview.has(s)) cls += ' preview';
    if (danger && pc === danger * P.KING) cls += ' danger';
    const t = st.targets.get(s);
    if (t) cls += ' ' + markerFor(t, s);
    if (cls !== shownCls[i]) { squares[i].className = cls; shownCls[i] = cls; }
    let html = '';
    if (pc) {
      if (s === drag && wild) html += '<i class="wild-aura"></i>';   // a converted Dragon looks like any other piece of its side
      html += pieceSVG(Math.abs(pc), pc > 0, s === drag && wild);
    }
    if (st.flipped ? r === ROWS - 1 : r === 0) html += `<span class="co co-f">${String.fromCharCode(97 + c)}</span>`;
    if (st.flipped ? c === COLS - 1 : c === 0) html += `<span class="co co-r">${r + 1}</span>`;
    if (html !== shownHtml[i]) { squares[i].innerHTML = html; shownHtml[i] = html; }
  }
  renderSide();
  renderPieceInfo();
  renderAction();
  renderOverlay();
  updateEval();
}

// ------------------------------------------------------------------ effects
const NS = 'http://www.w3.org/2000/svg';
const fxSvg = $('fxSvg'), fxLayer = $('fx');
fxSvg.innerHTML = `<defs>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <radialGradient id="stone"><stop offset="0" stop-color="#fff3d6"/><stop offset=".55" stop-color="#ffb24d"/><stop offset="1" stop-color="#c76a1f"/></radialGradient>
</defs>`;
const sqPx = () => boardEl.getBoundingClientRect().width / COLS;
function center(s) {
  const q = sqPx();
  const vc = st.flipped ? COLS - 1 - colOf(s) : colOf(s), vr = st.flipped ? rowOf(s) : ROWS - 1 - rowOf(s);
  return { x: (vc + .5) * q, y: (vr + .5) * q };
}
function svg(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (!(LITE && k === 'filter')) e.setAttribute(k, attrs[k]);
  fxSvg.appendChild(e);
  return e;
}
function ghost(pc, s) {
  const q = sqPx(), { x, y } = center(s);
  const d = document.createElement('div');
  d.className = 'ghost-pc';
  d.style.cssText = `left:${x - q / 2}px;top:${y - q / 2}px;width:${q}px;height:${q}px`;
  d.innerHTML = pieceSVG(Math.abs(pc), pc > 0);
  fxLayer.appendChild(d);
  return d;
}
const gone = (anim, el) => anim.finished.then(() => el.remove(), () => el.remove());
const pieceAt = s => squareEl(s)?.querySelector('svg.pc');
function clearFx() {
  for (const el of [...fxSvg.children]) if (el.tagName !== 'defs') el.remove();
  fxLayer.querySelectorAll('.ghost-pc').forEach(g => g.remove());
}
function curve(a, b, bend) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
  return { x: mx - dy * bend, y: my + dx * bend };
}
function particles(c, color, n, spread, opts = {}) {
  const q = sqPx();
  if (LITE) n = Math.ceil(n / 2);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2, dist = spread * q * (.4 + Math.random() * .6);
    const p = svg('circle', { cx: c.x, cy: c.y, r: (opts.size || .045) * q * (.6 + Math.random() * .8), fill: color, filter: 'url(#glow)' });
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist + (opts.rise ? -q * .35 : 0), fall = opts.gravity ? q * .5 : 0;
    gone(p.animate([
      { transform: 'translate(0,0)', opacity: 1 },
      { transform: `translate(${dx * .7}px,${dy * .7}px)`, opacity: .9, offset: .6 },
      { transform: `translate(${dx}px,${dy + fall}px)`, opacity: 0 },
    ], { duration: (opts.dur || 650) * (.7 + Math.random() * .5), delay: opts.delay || 0, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' }), p);
  }
}
function slide(from, to, arc = 0, dur = 240) {
  const el = pieceAt(to);
  if (!el) return;
  const a = center(from), b = center(to);
  const frames = [{ transform: `translate(${a.x - b.x}px,${a.y - b.y}px)` }];
  if (arc) { const m = curve(a, b, arc); frames.push({ transform: `translate(${m.x - b.x}px,${m.y - b.y}px) scale(1.12)`, offset: .5 }); }
  frames.push({ transform: 'none' });
  el.animate(frames, { duration: dur, easing: 'cubic-bezier(.3,.7,.2,1)' });
}
function shake(delay, px = 2) {
  const wrap = $('boardWrap'), base = wrap.style.transform || '';
  wrap.animate([{ transform: base || 'none' }, { transform: `${base} translate(${px}px,${-px / 2}px)` },
    { transform: `${base} translate(${-px}px,${px / 2}px)` }, { transform: base || 'none' }], { duration: 180, delay });
}

function fxArrow(from, to, victim) {
  const a = center(from), b = center(to), q = sqPx();
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const g = ghost(victim, to);
  const trail = svg('path', { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, stroke: 'var(--fire)', 'stroke-width': 2, 'stroke-linecap': 'round', fill: 'none', opacity: .55, filter: 'url(#glow)' });
  trail.style.strokeDasharray = len;
  gone(trail.animate([{ strokeDashoffset: len, opacity: .6 }, { strokeDashoffset: 0, opacity: .6, offset: .35 }, { strokeDashoffset: 0, opacity: 0 }], { duration: 600, easing: 'ease-out' }), trail);
  const bolt = svg('path', { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, stroke: '#fff', 'stroke-width': 3.5, 'stroke-linecap': 'round', fill: 'none', filter: 'url(#glow)' });
  const seg = Math.min(q * .9, len);
  bolt.style.strokeDasharray = `${seg} ${len + seg}`;
  const travel = Math.min(260, 90 + len * .35);
  gone(bolt.animate([{ strokeDashoffset: seg }, { strokeDashoffset: -len }], { duration: travel, easing: 'cubic-bezier(.5,0,.9,.6)' }), bolt);
  const ring = svg('circle', { cx: b.x, cy: b.y, r: q * .2, fill: 'none', stroke: 'var(--fire)', 'stroke-width': 3, opacity: 0 });
  gone(ring.animate([{ r: q * .15, opacity: .9 }, { r: q * .55, opacity: 0 }], { duration: 420, delay: travel - 20, easing: 'ease-out', fill: 'both' }), ring);
  particles(b, 'var(--fire)', 8, .5, { delay: travel - 20, dur: 450 });
  gone(g.animate([{ opacity: 1, transform: 'none' }, { opacity: 1, transform: 'none', offset: .45 },
    { opacity: 0, transform: 'translateY(6px) scale(.7) rotate(-14deg)' }], { duration: travel + 360, easing: 'ease-in', fill: 'both' }), g);
}

function fxConvert(from, to, oldPc) {
  const a = center(from), b = center(to), q = sqPx();
  const m = curve(a, b, .3);
  const beam = svg('path', { d: `M${a.x} ${a.y}Q${m.x} ${m.y} ${b.x} ${b.y}`, stroke: 'var(--magic)', 'stroke-width': 3, 'stroke-linecap': 'round', fill: 'none', filter: 'url(#glow)' });
  const len = beam.getTotalLength();
  beam.style.strokeDasharray = len;
  gone(beam.animate([{ strokeDashoffset: len, opacity: 1 }, { strokeDashoffset: 0, opacity: 1, offset: .45 }, { strokeDashoffset: 0, opacity: 0 }], { duration: 650, easing: 'ease-out' }), beam);
  for (let i = 0; i < 2; i++) {
    const ring = svg('circle', { cx: b.x, cy: b.y, r: q * (.36 + i * .1), fill: 'none', stroke: i ? '#d9b8ff' : 'var(--magic)', 'stroke-width': 2.5, 'stroke-dasharray': `${q * .18} ${q * .12}`, filter: 'url(#glow)' });
    ring.style.transformOrigin = `${b.x}px ${b.y}px`;
    gone(ring.animate([{ transform: 'rotate(0) scale(.3)', opacity: 0 }, { transform: `rotate(${i ? -160 : 200}deg) scale(1)`, opacity: 1, offset: .5 },
      { transform: `rotate(${i ? -300 : 360}deg) scale(1.15)`, opacity: 0 }], { duration: 850, delay: 230, easing: 'ease-out', fill: 'both' }), ring);
  }
  particles(b, '#c9a2ff', 14, .55, { delay: 260, dur: 900, rise: true, size: .035 });
  const g = ghost(oldPc, to);
  // keep the piece's own soft shadow under the glow so it never appears to shift
  const sh = 'drop-shadow(0 3px 3px rgba(52,36,130,.26))';
  gone(g.animate([{ opacity: 1, filter: `${sh} drop-shadow(0 0 0 #a26bff)` }, { opacity: 1, filter: `${sh} drop-shadow(0 0 10px #a26bff) brightness(1.4)`, offset: .4 },
    { opacity: 0, filter: `${sh} drop-shadow(0 0 16px #a26bff) brightness(2)`, transform: 'scale(1.12)' }], { duration: 760, delay: 200, fill: 'both' }), g);
  const fresh = pieceAt(to);
  if (fresh) fresh.animate([{ opacity: 0, filter: `${sh} drop-shadow(0 0 14px #a26bff)` }, { opacity: 0, offset: .35 }, { opacity: 1, filter: `${sh} drop-shadow(0 0 0 #a26bff)` }], { duration: 950, easing: 'ease-out' });
}

function fxSwap(from, to) {
  const a = center(from), b = center(to);
  for (const bend of [.35, -.35]) {
    const m = curve(a, b, bend);
    const p = svg('path', { d: `M${a.x} ${a.y}Q${m.x} ${m.y} ${b.x} ${b.y}`, stroke: 'var(--swap)', 'stroke-width': 2.5, fill: 'none', 'stroke-linecap': 'round', filter: 'url(#glow)' });
    const len = p.getTotalLength();
    p.style.strokeDasharray = len;
    gone(p.animate([{ strokeDashoffset: bend > 0 ? len : -len, opacity: .95 }, { strokeDashoffset: 0, opacity: .9, offset: .5 }, { strokeDashoffset: 0, opacity: 0 }], { duration: 620, easing: 'ease-out' }), p);
  }
  slide(from, to, .35, 460);   // the Joker arrives at the target square
  slide(to, from, .35, 460);   // the other piece travels the opposite arc
  particles(a, '#9cc8ff', 7, .45, { delay: 380, dur: 420 });
  particles(b, '#9cc8ff', 7, .45, { delay: 380, dur: 420 });
}

function fxBlast(from, anchor, victims) {
  const q = sqPx(), a = center(from);
  const hit = blastSquares(anchor).map(center);
  const c = { x: hit.reduce((s, p) => s + p.x, 0) / hit.length, y: hit.reduce((s, p) => s + p.y, 0) / hit.length };
  const flight = 560;
  const ghosts = victims.map(v => ghost(v.pc, v.s));
  const cat = pieceAt(from);
  if (cat) { cat.style.transformOrigin = '50% 90%'; cat.animate([{ transform: 'none' }, { transform: 'rotate(-12deg) scaleY(.92)', offset: .25 }, { transform: 'none' }], { duration: 380, easing: 'ease-out' }); }
  // a stone on a parabola, with its shadow sliding along the ground
  const shadow = svg('ellipse', { cx: a.x, cy: a.y + q * .25, rx: q * .12, ry: q * .05, fill: 'rgba(20,10,40,.35)' });
  const stone = svg('circle', { cx: a.x, cy: a.y, r: q * .12, fill: 'url(#stone)', filter: 'url(#glow)' });
  const frames = [], sframes = [], peak = Math.max(q * 1.2, Math.hypot(c.x - a.x, c.y - a.y) * .55);
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, x = a.x + (c.x - a.x) * t, y = a.y + (c.y - a.y) * t - peak * 4 * t * (1 - t);
    frames.push({ transform: `translate(${x - a.x}px,${y - a.y}px) scale(${1 + .5 * 4 * t * (1 - t)})`, offset: t });
    sframes.push({ transform: `translate(${x - a.x}px,${(c.y - a.y) * t}px) scale(${1 - .4 * 4 * t * (1 - t)})`, opacity: .9, offset: t });
  }
  stone.style.transformOrigin = `${a.x}px ${a.y}px`; shadow.style.transformOrigin = `${a.x}px ${a.y + q * .25}px`;
  gone(stone.animate(frames, { duration: flight, easing: 'linear' }), stone);
  gone(shadow.animate(sframes, { duration: flight, easing: 'linear' }), shadow);
  for (const p of hit) {
    const r = svg('rect', { x: p.x - q / 2, y: p.y - q / 2, width: q, height: q, fill: 'var(--blast)', opacity: 0 });
    gone(r.animate([{ opacity: .85 }, { opacity: 0 }], { duration: 520, delay: flight, easing: 'ease-out', fill: 'both' }), r);
  }
  const ring = svg('circle', { cx: c.x, cy: c.y, r: q * .3, fill: 'none', stroke: '#ffd08a', 'stroke-width': 4, opacity: 0, filter: 'url(#glow)' });
  gone(ring.animate([{ r: q * .25, opacity: 1, strokeWidth: 6 }, { r: q * 1.5, opacity: 0, strokeWidth: 1 }], { duration: 560, delay: flight, easing: 'ease-out', fill: 'both' }), ring);
  particles(c, 'var(--blast)', 16, 1.1, { delay: flight, dur: 700, gravity: true, size: .05 });
  particles(c, '#fff1d6', 6, .6, { delay: flight, dur: 400 });
  ghosts.forEach(g => gone(g.animate([{ opacity: 1, transform: 'none' }, { opacity: 1, transform: 'none', offset: flight / (flight + 380) },
    { opacity: 0, transform: `translate(${(Math.random() - .5) * q * .6}px,${-q * .3}px) scale(.6) rotate(${(Math.random() - .5) * 60}deg)` }],
    { duration: flight + 380, easing: 'ease-out', fill: 'both' }), g));
  shake(flight);
}

function fadeVictim(pc, s, delay = 120) {
  if (!pc) return;
  const g = ghost(pc, s);
  gone(g.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.8)' }], { duration: 260, delay, fill: 'both' }), g);
}

// the Dragon's fire along one line, burning every victim on it
function fxBreath(from, path, victims) {
  const a = center(from), b = center(path[path.length - 1]), q = sqPx();
  const ang = Math.atan2(b.y - a.y, b.x - a.x), reach = Math.hypot(b.x - a.x, b.y - a.y);
  for (let i = 0, n = LITE ? 12 : 24; i < n; i++) {
    const spread = (Math.random() - .5) * .45, dist = reach * (.45 + Math.random() * .65);
    const p = svg('circle', { cx: a.x, cy: a.y, r: q * (.05 + Math.random() * .06), fill: i % 3 ? 'var(--fire)' : '#ffd36a', filter: 'url(#glow)' });
    p.style.transformBox = 'fill-box'; p.style.transformOrigin = 'center';
    gone(p.animate([{ transform: 'translate(0,0) scale(.4)', opacity: .95 },
      { transform: `translate(${Math.cos(ang + spread) * dist}px,${Math.sin(ang + spread) * dist}px) scale(1.4)`, opacity: 0 }],
      { duration: 460 + Math.random() * 220, delay: i * 12, easing: 'ease-out', fill: 'both' }), p);
  }
  for (const v of victims) {
    const g = ghost(v.pc, v.s), delay = 80 + cheb(from, v.s) * 70;
    gone(g.animate([{ opacity: 1, filter: 'var(--pc-shadow) brightness(1)' }, { opacity: 1, filter: 'brightness(1.6) sepia(.6)', offset: .4 },
      { opacity: 0, filter: 'brightness(.3)', transform: 'scale(.8)' }], { duration: 620, delay, fill: 'both' }), g);
  }
}

function runFx(m, before) {
  const k = mKind(m), from = mFrom(m), to = mTo(m);
  if (k === K.MOVE || k === K.DOUBLE || k === K.EP) {
    const vsq = k === K.EP ? to - Math.sign(before[from]) * COLS : to;
    fadeVictim(before[vsq], vsq);
    slide(from, to);
  } else if (k === K.CASTLE) {
    const row = rowOf(from), left = colOf(to) < colOf(from);
    slide(from, row * COLS + (left ? 1 : 8), 0, 320);
    slide(to, row * COLS + (left ? 2 : 7), 0, 320);
  } else if (k === K.FIRE) fxArrow(from, to, before[to]);
  else if (k === K.CONVERT) fxConvert(from, to, before[to]);
  else if (k === K.SWAP) fxSwap(from, to);
  else if (k === K.BOMBARD) fxBlast(from, to, blastSquares(to).filter(s => before[s] && !board[s]).map(s => ({ s, pc: before[s] })));
}

// ------------------------------------------------------------------ the wild Dragon
// The engine reports the board after a move but before the Dragon acts; comparing it with the board after
// the Dragon's action tells exactly what the Dragon did.
function previewMove(m) {
  const d = ex.preview(m);
  return { board: new Int8Array(ex.memory.buffer, ex.midBoardPtr(), NSQ).slice(), drag: d };
}
function readDragon(mid, after) {
  const d0 = mid.drag, d1 = ex.dragonSquare();
  if (d0 < 0 || d1 < 0) return null;   // captured by the move (or none in the game)
  if (d1 !== d0) {
    const prey = mid.board[d1];
    return { kind: prey ? 'land' : 'fly', from: d0, to: d1, prey, note: `D${prey ? 'x' : '-'}${sqName(d1)}` };
  }
  const burned = [];
  for (let s = 0; s < NSQ; s++) if (s !== d0 && mid.board[s] && !after[s]) burned.push({ s, pc: mid.board[s] });
  if (!burned.length) return null;
  const f = burned[0].s, sr = Math.sign(rowOf(f) - rowOf(d0)), sc = Math.sign(colOf(f) - colOf(d0));
  const path = [1, 2].map(k => (rowOf(d0) + sr * k) * COLS + colOf(d0) + sc * k).filter(inZone);
  return { kind: 'fire', from: d0, path, burned, note: `D^${burned.map(b => sqName(b.s)).join('')}` };
}
const DRAGON_MS = { fly: 560, land: 620, fire: 720 };
// a flight: it lifts, glides on an arc with its shadow below, and settles; prey vanishes as it lands
function fxDragonFly(a) {
  const el = pieceAt(a.to), q = sqPx();
  if (!el) return;
  const p0 = center(a.from), p1 = center(a.to), dx = p0.x - p1.x, dy = p0.y - p1.y, lift = q * (.35 + .1 * cheb(a.from, a.to));
  const frames = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, e = t < .5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t), h = Math.sin(Math.PI * t) * lift;
    frames.push({ transform: `translate(${dx * (1 - e)}px,${dy * (1 - e) - h}px) scale(${1 + .18 * Math.sin(Math.PI * t)})`, offset: t });
  }
  el.animate(frames, { duration: DRAGON_MS[a.kind] - 60, easing: 'linear' });
  const sh = svg('ellipse', { cx: p1.x, cy: p1.y + q * .3, rx: q * .26, ry: q * .08, fill: 'rgba(20,10,40,.28)' });
  gone(sh.animate([{ transform: `translate(${dx}px,${dy}px) scale(.9)`, opacity: .5 }, { transform: `translate(${dx / 2}px,${dy / 2}px) scale(.6)`, opacity: .25 },
    { transform: 'none', opacity: .5 }], { duration: DRAGON_MS[a.kind] - 60, easing: 'ease-in-out' }), sh);
  sh.style.transformBox = 'fill-box'; sh.style.transformOrigin = 'center';
  if (a.prey) {
    const g = ghost(a.prey, a.to), hit = DRAGON_MS[a.kind] - 160;
    gone(g.animate([{ opacity: 1, transform: 'none' }, { opacity: 1, transform: 'none', offset: hit / (hit + 260) },
      { opacity: 0, transform: 'scale(.7) rotate(-10deg)' }], { duration: hit + 260, easing: 'ease-in', fill: 'both' }), g);
    particles(p1, 'var(--fire)', 10, .5, { delay: hit, dur: 500 });
  }
}
function fxWildDragon(a) {
  if (a.kind === 'fire') fxBreath(a.from, a.path, a.burned);
  else fxDragonFly(a);
}
// how long the mover's own animation runs before the Dragon takes its turn
function moveFxMs(m) {
  const k = mKind(m);
  return k === K.BOMBARD ? 980 : k === K.CONVERT ? 760 : k === K.SWAP || k === K.FIRE ? 620 : 300;
}
let dragonTimer = 0;
function cancelDragon() {
  clearTimeout(dragonTimer);
  if (st.shown) { st.shown = null; clearFx(); }
}

// ------------------------------------------------------------------ interaction
function clearSelection() { st.selected = -1; st.targets = new Map(); st.blast = null; hidePopover(); }
const movesFrom = s => legal.some(m => mFrom(m) === s && mKind(m) !== K.PROMOTE && mKind(m) !== K.PASS);

function select(s) {
  clearSelection();
  st.selected = s; st.hint = 0;
  for (const m of legal) {
    if (mFrom(m) !== s || mKind(m) === K.PROMOTE || mKind(m) === K.PASS) continue;
    const k = mKind(m);
    const add = sq => { if (!st.targets.has(sq)) st.targets.set(sq, []); st.targets.get(sq).push({ kind: k, move: m }); };
    if (k === K.BOMBARD) blastSquares(mTo(m)).forEach(add);
    else add(mTo(m));
  }
  render();
}

function onSquare(s) {
  if (!humanTurn() || ex.pendingSquare() >= 0) return;
  hidePopover();
  if (st.blast && blastSquares(mTo(st.blast.options[st.blast.idx])).includes(s)) { playMove(st.blast.options[st.blast.idx]); return; }
  if (st.selected >= 0 && st.targets.has(s)) { chooseTarget(s); return; }
  if (s !== st.selected && movesFrom(s)) { select(s); return; }
  clearSelection(); render();
}

const KIND_LABEL = (k, s) => ({ [K.MOVE]: board[s] ? 'Capture' : 'Move', [K.DOUBLE]: 'Move', [K.EP]: 'En passant',
  [K.CASTLE]: 'Castle', [K.FIRE]: 'Shoot', [K.CONVERT]: 'Convert', [K.SWAP]: 'Swap', [K.BOMBARD]: 'Bombard' })[k];

function chooseTarget(s) {
  const opts = st.targets.get(s);
  const blasts = [...new Set(opts.filter(o => o.kind === K.BOMBARD).map(o => o.move))];
  const others = opts.filter(o => o.kind !== K.BOMBARD);
  if (blasts.length && !others.length) { previewBlast(s, blasts); return; }
  const byKind = new Map();
  for (const o of others) { if (!byKind.has(o.kind)) byKind.set(o.kind, []); byKind.get(o.kind).push(o.move); }
  if (byKind.size === 1) { commit([...byKind.values()][0]); return; }
  showPopover(s, [...byKind.entries()].map(([k, ms]) => ({ label: KIND_LABEL(k, s), run: () => commit(ms) })));
}

async function commit(moves) {
  hidePopover();
  if (moves.length === 1) { playMove(moves[0]); return; }
  const m = await pickPromotion(moves, ex.sideToMove(), 'Promote');
  if (m) playMove(m);
}

// A tap on a marked square shows the best area there (most enemies, fewest of your own); a tap inside the shown
// area fires it. "Next area" in the sidebar steps through the other areas that cover the tapped square.
function previewBlast(s, options) {
  if (st.blast && blastSquares(mTo(st.blast.options[st.blast.idx])).includes(s)) { playMove(st.blast.options[st.blast.idx]); return; }
  const me = ex.sideToMove();
  const worth = m => blastSquares(mTo(m)).reduce((v, q) => v + (!board[q] ? 0 : Math.sign(board[q]) === me ? -3 : 2 + (Math.abs(board[q]) === P.KING ? 50 : 0)), 0);
  st.blast = { square: s, options: [...options].sort((a, b) => worth(b) - worth(a)), idx: 0 };
  render();
}

// The selected piece's name and what it does, in the sidebar.
const ABOUT = {
  1: 'Moves forward, captures diagonally.', 2: 'Jumps in an L.', 3: 'Slides diagonally.', 4: 'Slides straight.',
  5: 'Slides in any direction.', 6: 'Steps one square. Lose it and you lose.',
  7: 'Steps to empty squares, or shoots the first piece in a line up to 3 squares (adjacent too).',
  8: 'Steps without capturing, or converts an adjacent enemy (the Dragon too), even right after stepping.',
  9: 'Steps straight, or bombards a 2 × 2 block 2–3 squares away.',
  10: 'Steps, or swaps places with any piece within 2 squares.',
  13: 'Stays in the middle 6 × 6 and takes its own turn after every move: takes a king in reach; otherwise eats the most it can (landing on a piece, or fire burning 2 squares along a line) without ending where it could be captured or converted next move, and hunts when there is nothing to eat. If it takes a king, that king\'s player loses. Anyone can capture it; a Wizard can convert it, and then it spares that side and will even sacrifice itself for a rook or more.',
};
function renderPieceInfo() {
  const box = $('pieceInfo'), s = st.selected, pc = s >= 0 ? board[s] : 0;
  if (!pc) { box.hidden = true; return; }
  const t = Math.abs(pc), drag = s === ex.dragonSquare(), wild = drag && !ex.dragonOwner();
  const tag = wild ? 'nobody\'s' : drag ? (ex.dragonOwner() > 0 ? 'White\'s' : 'Black\'s') : '';
  box.hidden = false;
  box.innerHTML = `${pieceSVG(t, pc > 0, wild)}<div><div class="pi-name">${NAMES[t]}${tag ? ` <span class="pi-tag">${tag}</span>` : ''}</div><div class="pi-text">${ABOUT[t] || ''}</div></div>`;
}

// Catapult and Wizard controls live in the sidebar so nothing covers the board.
function renderAction() {
  const card = $('actionCard'), b = st.blast;
  const show = (mode, title, text, warn, buttons) => {
    card.hidden = false; card.dataset.mode = mode;
    $('acTitle').textContent = title; $('acText').textContent = text || ''; $('acWarn').textContent = warn || '';
    $('acCount').textContent = '';
    for (const id of ['acNext', 'acCancel', 'acLaunch']) $(id).hidden = !buttons.includes(id);
  };
  if (b) {
    const area = blastSquares(mTo(b.options[b.idx])).filter(q => board[q]);
    const own = area.filter(q => Math.sign(board[q]) === ex.sideToMove()).length;
    show('blast', `Bombard · ${area.length - own} enemy`, 'Tap the highlighted area again, or Launch, to fire.', own ? `Also hits ${own} of your own piece${own > 1 ? 's' : ''}` : '', ['acNext', 'acCancel', 'acLaunch']);
    $('acCount').textContent = b.options.length > 1 ? `area ${b.idx + 1} of ${b.options.length}` : '';
    $('acNext').disabled = b.options.length < 2;
    $('acLaunch').textContent = 'Launch';
    return;
  }
  if (humanTurn() && act >= 0) {
    show('act', 'Wizard · convert', 'Convert an enemy beside the Wizard, or end your turn.', '', ['acLaunch']);
    $('acLaunch').textContent = 'End turn';
    return;
  }
  card.hidden = true;
}
$('acNext').onclick = () => { st.blast.idx = (st.blast.idx + 1) % st.blast.options.length; render(); };
$('acLaunch').onclick = () => {
  if (st.blast) playMove(st.blast.options[st.blast.idx]);
  else if (act >= 0) { const pass = legal.find(m => mKind(m) === K.PASS); if (pass !== undefined) playMove(pass); }
};
$('acCancel').onclick = () => { clearSelection(); render(); };

function showPopover(s, items) {
  const pop = $('popover');
  pop.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label; b.onclick = it.run;
    pop.appendChild(b);
  }
  const wrap = boardEl.getBoundingClientRect(), r = squareEl(s).getBoundingClientRect();
  pop.hidden = false;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = r.left - wrap.left + r.width / 2 - pw / 2, y = r.top - wrap.top - ph - 6;
  if (y < 4) y = r.bottom - wrap.top + 6;
  pop.style.left = Math.max(4, Math.min(wrap.width - pw - 4, x)) + 'px';
  pop.style.top = y + 'px';
}
function hidePopover() { $('popover').hidden = true; }

function pickPromotion(moves, color, title, sub = '') {
  return new Promise(resolve => {
    const dlg = $('promoDlg');
    $('promoTitle').textContent = title;
    $('promoSub').textContent = sub;
    const grid = $('promoGrid');
    grid.innerHTML = '';
    for (const m of PROMOS.map(t => moves.find(m => mPromo(m) === t)).filter(Boolean)) {
      const b = document.createElement('button');
      b.innerHTML = pieceSVG(mPromo(m), color > 0) + `<span>${NAMES[mPromo(m)]}</span>`;
      b.onclick = () => { dlg.close(); resolve(m); };
      grid.appendChild(b);
    }
    dlg.oncancel = e => { if (ex.pendingSquare() >= 0) e.preventDefault(); else resolve(null); };
    dlg.showModal();
  });
}

// ------------------------------------------------------------------ playing moves
function addNote(m, before, side, second) {
  const text = notate(m, before);
  if ((mKind(m) === K.PROMOTE || second) && st.notes.length) { if (text) st.notes[st.notes.length - 1].text += mKind(m) === K.PROMOTE ? ` (${text})` : ` ${text}`; }
  else st.notes.push({ text, side });
}

function playMove(m) {
  const before = board.slice(), side = ex.sideToMove(), second = ex.actSquare() >= 0;
  const mid = previewMove(m);
  if (!ex.play(m)) { render(); return; }
  addNote(m, before, side, second);
  const after = new Int8Array(ex.memory.buffer, ex.boardPtr(), NSQ).slice();
  const dragon = readDragon(mid, after);
  if (dragon && st.notes.length) st.notes[st.notes.length - 1].text += ' ' + dragon.note;
  st.last = m; st.hint = 0; st.overlayDismissed = false;
  clearSelection();
  persist();
  if (!dragon) { render(); runFx(m, before); schedule(); return; }
  // first the move alone; then, once its animation is done, the Dragon's own turn
  st.shown = mid.board; st.shownDrag = mid.drag;
  render();
  runFx(m, before);
  dragonTimer = setTimeout(() => {
    st.shown = null;
    render();
    fxWildDragon(dragon);
    dragonTimer = setTimeout(schedule, DRAGON_MS[dragon.kind]);
  }, moveFxMs(m));
}

let scheduleTimer = 0;
function schedule() {
  clearTimeout(scheduleTimer);
  if (st.shown) return;   // the Dragon's turn comes first
  if (ex.result()) { render(); return; }
  if (humanTurn()) {
    if (ex.actSquare() >= 0) {   // after the step's animation, keep the Wizard selected for its convert
      const n = ex.moveCount(), at = ex.actSquare();
      setTimeout(() => { if (ex.moveCount() === n && st.selected < 0) { readState(); select(at); } }, 600);
      return;
    }
    if (ex.pendingSquare() >= 0) {
      readState();
      setTimeout(async () => {
        const m = await pickPromotion(legal, ex.sideToMove(), 'Promote your pawn', 'It was swapped onto the last rank. Choose before your turn.');
        if (m) playMove(m);
      }, 300);
    }
    return;
  }
  scheduleTimer = setTimeout(think, st.mode === 'watch' ? 650 : 120);
}

function think(hint = false) {
  if (st.thinking) return;
  const lv = hint ? { ms: 1200, depth: 0 } : LEVELS[st.strength];
  pending = { id: ++reqId, moveCount: ex.moveCount(), side: ex.sideToMove(), hint };
  st.thinking = true;
  renderSide();
  worker.postMessage({ id: pending.id, layout: st.layout, moves: gameMoves(), ms: lv.ms, depth: lv.depth });
}

function cancelThinking() {
  if (st.thinking) { st.thinking = false; pending = null; startWorker(); }
}

// ------------------------------------------------------------------ sidebar
let shownMoves = '';
function renderSide() {
  const res = ex.result(), side = ex.sideToMove();
  const name = side > 0 ? 'White' : 'Black';
  let main, sub = '', warn = false;
  if (res === 1 || res === 2) { main = (res === 1 ? 'White' : 'Black') + ' wins'; sub = 'The king has fallen'; }
  else if (res === 3) { main = 'Draw'; sub = 'Threefold repetition'; }
  else if (res === 4) { main = 'Draw'; sub = '50 moves without a capture'; }
  else if (ex.pendingSquare() >= 0) { main = name + ' promotes'; sub = 'Swapped pawn on the last rank'; }
  else if (ex.actSquare() >= 0) { main = st.thinking ? 'Thinking…' : name + ' · convert'; sub = 'The Wizard may still convert beside where it landed'; }
  else {
    main = st.thinking && !pending?.hint ? 'Thinking…' : name + ' to move';
    sub = `Move ${Math.floor(ex.turns() / 2) + 1}`;
    const quiet = ex.halfmoves();
    if (quiet >= 60) sub += ` · ${100 - quiet} half-moves to a draw`;
    if (ex.inDanger()) { sub = humanTurn() ? 'Your king can be taken' : 'King exposed'; warn = true; }
  }
  $('statusMain').textContent = main;
  const sb = $('statusSub'); sb.textContent = sub; sb.className = 'sub' + (warn ? ' warn' : '');
  $('turnDot').className = 'turn ' + (res ? 'over' : side > 0 ? 'w' : 'b') + (st.thinking ? ' busy' : '');
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.v === st.mode);
  for (const b of $('colorSeg').children) b.classList.toggle('on', Number(b.dataset.v) === st.human);
  for (const b of $('strengthSeg').children) b.classList.toggle('on', Number(b.dataset.v) === st.strength);
  $('colorGroup').classList.toggle('dim', st.mode !== 'engine');
  $('hintBtn').disabled = !humanTurn() || st.thinking;
  $('undoBtn').disabled = ex.moveCount() === 0;
  const rows = [];
  let row = null, num = 1;
  for (const n of st.notes) {
    if (n.side > 0 || !row) { row = { num: num++, w: '', b: '' }; rows.push(row); }
    if (n.side > 0) row.w = n.text; else row.b = n.text;
  }
  const html = rows.length ? rows.map((r, i) => `<div class="mv${i === rows.length - 1 ? ' cur' : ''}"><span class="n">${r.num}</span><span>${r.w || '…'}</span><span>${r.b}</span></div>`).join('')
    : '<div class="empty">Your move. Tap a piece to see where it can go.</div>';
  if (html !== shownMoves) {   // the list only changes when a move is played
    const list = $('moves');
    list.innerHTML = html; shownMoves = html;
    list.scrollTop = list.scrollHeight;
  }
  const info = st.engineInfo;
  $('engineInfo').textContent = info ? `Depth ${info.depth} · ${formatNodes(info.nodes)} positions` : '';
  $('layoutInfo').textContent = `Layout ${(st.layout + 1).toLocaleString()} / ${ex.layoutCount().toLocaleString()}`;
}

function formatNodes(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }

function updateEval() {
  const v = st.evalWhite, fill = $('evalfill'), label = $('evalLabel');
  if (v == null) { fill.style.height = '50%'; label.textContent = ''; return; }
  const p = Math.abs(v) >= 29000 ? (v > 0 ? 1 : 0) : 1 / (1 + Math.exp(-v / 200));
  fill.style.height = (st.flipped ? 1 - p : p) * 100 + '%';
  $('evalbar').classList.toggle('flipped', st.flipped);
  label.textContent = Math.abs(v) >= 29000 ? (v > 0 ? 'White wins' : 'Black wins') : (v > 0 ? '+' : '') + (v / 100).toFixed(1);
}

function renderOverlay() {
  const res = ex.result(), ov = $('overlay');
  if (!res || st.overlayDismissed || st.shown) { ov.hidden = true; return; }
  if (!ov.hidden) return;
  setTimeout(() => {
    if (!ex.result() || st.overlayDismissed) return;
    ov.hidden = false;
    $('ovTitle').textContent = res === 1 ? 'White wins' : res === 2 ? 'Black wins' : 'Draw';
    $('ovSub').textContent = res <= 2 ? 'The king was taken.' : res === 3 ? 'The same position occurred three times.' : 'Fifty moves passed without a capture.';
  }, 900);
}

// ------------------------------------------------------------------ controls
function newGame(layout) {
  cancelDragon();
  cancelThinking();
  clearFx();
  st.layout = layout ?? Math.floor(Math.random() * ex.layoutCount());
  ex.newGame(st.layout);
  st.notes = []; st.last = 0; st.hint = 0; st.evalWhite = null; st.engineInfo = null; st.overlayDismissed = false;
  st.flipped = st.mode === 'engine' && st.human < 0;
  $('overlay').hidden = true;
  clearSelection(); persist(); sizeBoard(); render(); schedule();
}

function undo() {
  cancelDragon();
  cancelThinking();
  if (!ex.moveCount()) return;
  clearFx();
  ex.undo(1);
  const midTurn = () => ex.actSquare() >= 0;
  while (ex.moveCount() > 0 && midTurn()) ex.undo(1);   // a two-part turn is undone whole
  if (st.mode === 'engine') while (ex.moveCount() > 0 && (ex.sideToMove() !== st.human || midTurn())) ex.undo(1);
  rebuildNotes();
  st.last = ex.moveCount() ? ex.moveAt(ex.moveCount() - 1) : 0;
  st.hint = 0; st.overlayDismissed = false; $('overlay').hidden = true;
  if (st.mode === 'watch') st.mode = 'two';
  clearSelection(); persist(); render(); schedule();
}

// replays the game to rebuild the move list (with the Dragon's actions)
function rebuildNotes() {
  const moves = gameMoves();
  ex.newGame(st.layout);
  st.notes = [];
  for (const m of moves) {
    const before = new Int8Array(ex.memory.buffer, ex.boardPtr(), NSQ).slice(), side = ex.sideToMove(), second = ex.actSquare() >= 0;
    const mid = previewMove(m);
    if (!ex.play(m)) break;
    addNote(m, before, side, second);
    const d = readDragon(mid, new Int8Array(ex.memory.buffer, ex.boardPtr(), NSQ).slice());
    if (d) st.notes[st.notes.length - 1].text += ' ' + d.note;
  }
}

function bindSeg(id, key, parse) {
  for (const b of $(id).children) b.onclick = () => {
    const v = parse(b.dataset.v);
    if (st[key] === v) return;
    st[key] = v;
    if (key === 'mode' || key === 'human') { cancelDragon(); cancelThinking(); st.flipped = st.mode === 'engine' && st.human < 0; sizeBoard(); }
    persist(); render(); schedule();
  };
}
bindSeg('modeSeg', 'mode', v => v);
bindSeg('colorSeg', 'human', Number);
bindSeg('strengthSeg', 'strength', Number);
$('newBtn').onclick = () => newGame();
$('ovNew').onclick = () => newGame();
$('ovClose').onclick = () => { st.overlayDismissed = true; $('overlay').hidden = true; };
$('undoBtn').onclick = undo;
$('flipBtn').onclick = () => { st.flipped = !st.flipped; clearFx(); render(); };   // (the Dragon's move still follows)
$('hintBtn').onclick = () => { if (humanTurn() && !st.thinking) think(true); };
$('rulesBtn').onclick = () => $('rulesDlg').showModal();
$('rulesClose').onclick = () => $('rulesDlg').close();
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { clearSelection(); render(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
});

// Square size in whole device pixels, and the board snapped to the pixel grid, so every square
// edge is exact at any display scaling.
function sizeBoard() {
  const stage = document.querySelector('.stage'), evalCol = document.querySelector('.evalcol');
  const evalW = evalCol.offsetWidth ? evalCol.offsetWidth + 14 : 0;
  const availW = stage.clientWidth - evalW, availH = window.innerWidth <= 900 ? Infinity : stage.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const dev = Math.max(20, Math.floor(Math.min(availW / COLS, availH / ROWS) * dpr));
  document.documentElement.style.setProperty('--sq', dev / dpr + 'px');
  const wrap = $('boardWrap');
  wrap.style.transform = '';
  const r = boardEl.getBoundingClientRect();
  const fx = (r.left * dpr) % 1, fy = (r.top * dpr) % 1;
  if (fx || fy) wrap.style.transform = `translate(${(fx ? 1 - fx : 0) / dpr}px, ${(fy ? 1 - fy : 0) / dpr}px)`;
}
let resizeTimer = 0;
window.addEventListener('resize', () => {
  hidePopover();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { clearFx(); sizeBoard(); }, 60);
});

// ------------------------------------------------------------------ start
(async () => {
  await loadEngine();
  startWorker();
  buildBoard();
  sizeBoard();
  if (Number.isInteger(saved.layout) && saved.layout < ex.layoutCount() && Array.isArray(saved.moves)) {
    st.layout = saved.layout;
    ex.newGame(st.layout);
    for (const m of saved.moves) if (!ex.play(m)) break;
    rebuildNotes();
    st.last = ex.moveCount() ? ex.moveAt(ex.moveCount() - 1) : 0;
    st.flipped = st.mode === 'engine' && st.human < 0;
    render(); schedule();
  } else newGame();
  if (location.search.includes('debug')) window.__c2 = { ex, playMove, newGame, onSquare, st, legal: () => { readState(); return legal; }, K, mKind, mFrom, mTo };
  document.body.classList.add('ready');
  // offline support for the web version (the Windows app serves its files locally)
  if (!host && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
