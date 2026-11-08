'use strict';
/*
 * Escuadrones y guerras de escuadrones de Halcones del Alba.
 * - Un jugador crea un escuadrón (nombre + etiqueta de 2 a 4 letras) o se une con la etiqueta.
 * - El líder busca guerra: se empareja con otro escuadrón que también busque. Si en ~8 s nadie
 *   más busca, se le asigna el escuadrón rival de práctica "[PI] Piloti Italiani" (controlado por el servidor).
 * - La guerra dura WAR_HOURS horas. Los puntos de cada partida 2v2 multijugador se suman al escuadrón.
 * - Al terminar, cada piloto reclama cofres según los hitos alcanzados por su escuadrón.
 * Se guarda en un archivo JSON (SQUADS_FILE). En hosting gratuito sin disco permanente se reinicia al reiniciar el servidor.
 */
const fs = require('fs');
const path = require('path');

const FILE = process.env.SQUADS_FILE || path.join(__dirname, 'squads.json');
const WAR_MS = Math.max(0.0001, parseFloat(process.env.WAR_HOURS || '24')) * 3600 * 1000;
const SEARCH_MS = parseInt(process.env.WAR_SEARCH_MS || '1800000', 10);
const MAX_MEMBERS = 30;
const MAX_PTS_REPORT = 4000;
const MILESTONES = [{ pts: 30000, id: 'plata' }, { pts: 100000, id: 'oro' }, { pts: 300000, id: 'platino' }, { pts: 1000000, id: 'diamante' }]; // cofres por puntos del escuadrón
const BOT = { tag: 'PI', name: 'Piloti Italiani', members: 12 };

let db = { squads: {}, wars: {}, queue: [], seq: 1, pend: {} };
try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (d && d.squads) db = Object.assign(db, d); } catch (e) {}
let saveT = null;
function save() {
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null; try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {} }, 1500);
  if (saveT.unref) saveT.unref();
}

const cleanPid = (s) => (typeof s === 'string' && /^[a-z0-9]{8,40}$/.test(s)) ? s : '';
const cleanName = (s, n) => String(s || '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, n || 18);
const cleanTag = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

function squadOf(pid) {
  for (const t in db.squads) if (db.squads[t].members[pid]) return db.squads[t];
  return null;
}
function warOf(sq) { return sq && sq.war ? db.wars[sq.war] : null; }

function botPts(w) {
  const f = Math.min(1, (Date.now() - w.start) / (w.end - w.start));
  return Math.round(w.botTarget * f);
}
function squadPts(w, tag) {
  if (tag === BOT.tag && w.bot) return botPts(w);
  let n = 0;
  for (const pid in w.pts) if (w.pts[pid].tag === tag) n += w.pts[pid].pts;
  return n;
}
function chestsFor(pts) { return MILESTONES.filter((m) => pts >= m.pts).map((m) => m.id); }

function finish(w) {
  if (w.done || Date.now() < w.end) return;
  w.done = true;
  const pa = squadPts(w, w.a), pb = squadPts(w, w.b);
  w.winner = pa === pb ? '' : (pa > pb ? w.a : w.b);
  [w.a, w.b].forEach((tag) => {
    const sq = db.squads[tag];
    if (!sq) return;
    const pts = squadPts(w, tag), win = w.winner === tag;
    const medals = win ? 33 : (w.winner ? 10 : 20);
    sq.medals = (sq.medals | 0) + medals;
    for (const pid in sq.members) {
      if (!w.pts[pid] || w.pts[pid].tag !== tag) continue; // solo quienes jugaron la guerra
      (db.pend[pid] = db.pend[pid] || []).push({ chests: chestsFor(pts), medals });
    }
  });
  save();
}

function tryMatch() {
  db.queue = db.queue.filter((q) => db.squads[q.tag] && !warOf(db.squads[q.tag]) || (db.squads[q.tag] && warOf(db.squads[q.tag]).done));
  if (db.queue.length >= 2) {
    const a = db.queue.shift(), b = db.queue.shift();
    startWar(a.tag, b.tag, false);
  }
}
function startWar(a, b, bot) {
  const id = 'w' + (db.seq++);
  const w = { id, a, b, start: Date.now(), end: Date.now() + WAR_MS, pts: {}, mids: [], done: false, winner: '', bot: !!bot, botTarget: bot ? Math.round(25000 + Math.random() * 125000) : 0 };
  db.wars[id] = w;
  [a, b].forEach((t) => { if (db.squads[t]) { const old = db.squads[t].war; if (old && db.wars[old] && db.wars[old].done) delete db.wars[old]; db.squads[t].war = id; } });
  save();
}

function view(pid) {
  const sq = squadOf(pid);
  const out = { pid, squad: null, war: null, pend: (db.pend[pid] || []).length };
  if (!sq) return out;
  const w = warOf(sq);
  if (w) finish(w);
  out.squad = {
    tag: sq.tag, name: sq.name, medals: sq.medals | 0, owner: sq.owner === pid,
    members: Object.keys(sq.members).map((p) => ({ name: sq.members[p].name, owner: p === sq.owner })),
    searching: db.queue.some((q) => q.tag === sq.tag)
  };
  if (!w) {
    if (out.squad.searching) {
      const q = db.queue.find((x) => x.tag === sq.tag);
      if (q && Date.now() - q.t >= SEARCH_MS) { db.queue = db.queue.filter((x) => x.tag !== sq.tag); startWar(sq.tag, BOT.tag, true); return view(pid); }
    }
    return out;
  }
  const other = w.a === sq.tag ? w.b : w.a, os = db.squads[other];
  const mine = squadPts(w, sq.tag), theirs = squadPts(w, other);
  const board = [];
  for (const p in w.pts) board.push({ tag: w.pts[p].tag, name: w.pts[p].name, pts: w.pts[p].pts, me: p === pid });
  if (w.bot) for (let i = 0; i < 6; i++) board.push({ tag: BOT.tag, name: ['Lupo', 'Falco', 'Aquila', 'Corvo', 'Sparviero', 'Nibbio'][i], pts: Math.round(botPts(w) * [0.26, 0.2, 0.17, 0.14, 0.12, 0.11][i]), me: false });
  board.sort((x, y) => y.pts - x.pts);
  out.war = {
    id: w.id, left: Math.max(0, w.end - Date.now()), done: w.done, winner: w.winner, total: WAR_MS,
    me: { tag: sq.tag, name: sq.name, pts: mine, members: Object.keys(sq.members).length, medals: sq.medals | 0 },
    them: { tag: other, name: other === BOT.tag ? BOT.name : (os ? os.name : other), pts: theirs, members: other === BOT.tag ? BOT.members : (os ? Object.keys(os.members).length : 0), medals: os ? (os.medals | 0) : 0 },
    milestones: MILESTONES, myPts: w.pts[pid] ? w.pts[pid].pts : 0, board: board.slice(0, 10)
  };
  return out;
}

function handle(m) {
  const pid = cleanPid(m.pid);
  if (!pid) return { ok: false, err: 'Identificador no válido.' };
  const pname = cleanName(m.name, 16) || 'Piloto';
  const op = m.op;
  let sq = squadOf(pid);
  if (op === 'create') {
    if (sq) return { ok: false, err: 'Ya estás en un escuadrón.' };
    const tag = cleanTag(m.tag), name = cleanName(m.sname, 20);
    if (tag.length < 2 || name.length < 3) return { ok: false, err: 'Pon un nombre (3+ letras) y una etiqueta de 2 a 4 letras.' };
    if (db.squads[tag] || tag === BOT.tag) return { ok: false, err: 'Esa etiqueta ya existe.' };
    db.squads[tag] = { tag, name, owner: pid, members: { [pid]: { name: pname } }, medals: 0, war: '' };
    save();
  } else if (op === 'join') {
    if (sq) return { ok: false, err: 'Ya estás en un escuadrón.' };
    const t = db.squads[cleanTag(m.tag)];
    if (!t) return { ok: false, err: 'No existe ese escuadrón.' };
    if (Object.keys(t.members).length >= MAX_MEMBERS) return { ok: false, err: 'El escuadrón está lleno.' };
    t.members[pid] = { name: pname }; save();
  } else if (op === 'leave') {
    if (!sq) return { ok: false, err: 'No estás en un escuadrón.' };
    delete sq.members[pid];
    const ids = Object.keys(sq.members);
    if (!ids.length) { delete db.squads[sq.tag]; db.queue = db.queue.filter((q) => q.tag !== sq.tag); }
    else if (sq.owner === pid) sq.owner = ids[0];
    save();
  } else if (op === 'search') {
    if (!sq) return { ok: false, err: 'No estás en un escuadrón.' };
    if (sq.owner !== pid) return { ok: false, err: 'Solo el líder puede buscar guerra.' };
    const w = warOf(sq);
    if (w) finish(w);
    if (w && !w.done) return { ok: false, err: 'Tu escuadrón ya está en guerra.' };
    if (!db.queue.some((q) => q.tag === sq.tag)) db.queue.push({ tag: sq.tag, t: Date.now() });
    tryMatch(); save();
  } else if (op === 'cancel') {
    if (sq) db.queue = db.queue.filter((q) => q.tag !== sq.tag);
  } else if (op === 'pts') {
    if (!sq) return { ok: false, err: 'Sin escuadrón.' };
    const w = warOf(sq);
    if (!w || w.done || Date.now() >= w.end) return { ok: true, ignored: true, ...view(pid) };
    const mid = String(m.mid || '').slice(0, 40), pts = Math.max(0, Math.min(MAX_PTS_REPORT, Math.floor(+m.pts || 0)));
    if (!mid || w.mids.indexOf(pid + mid) >= 0) return { ok: true, ignored: true, ...view(pid) };
    w.mids.push(pid + mid); if (w.mids.length > 400) w.mids.shift();
    const e = w.pts[pid] = w.pts[pid] || { tag: sq.tag, name: pname, pts: 0 };
    e.pts += pts; e.name = pname; save();
  } else if (op === 'claim') {
    const list = db.pend[pid] || [];
    if (!list.length) return { ok: true, chests: [], medals: 0, ...view(pid) };
    const r = list.reduce((a, x) => ({ chests: a.chests.concat(x.chests), medals: a.medals + x.medals }), { chests: [], medals: 0 });
    delete db.pend[pid]; save();
    return { ok: true, ...r, ...view(pid) };
  } else if (op !== 'info') return { ok: false, err: 'Operación desconocida.' };
  return { ok: true, ...view(pid) };
}

module.exports = { handle, _db: () => db };
