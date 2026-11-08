'use strict';
/*
 * Servidor de Halcones del Alba (2 contra 2).
 * No necesita instalar paquetes: solo Node.js 18 o más nuevo.
 *   - Sirve el juego (public/index.html) en "/".
 *   - Atiende las partidas por WebSocket en la misma dirección.
 *
 * El servidor es un "relevo": reparte jugadores en salas, retransmite posiciones,
 * disparos y daños, y cuenta el marcador. Cada jugador calcula sus propios impactos.
 */
const http = require('http');
const crypto = require('crypto');
const squads = require('./squads');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const LOBBY_SECS = parseInt(process.env.LOBBY_SECS || '20', 10);
const KILLS_TO_WIN = parseInt(process.env.KILLS_TO_WIN || '10', 10);
const TIME_LIMIT = parseInt(process.env.TIME_LIMIT || '180', 10); // segundos
const TEAM_SIZE = 2;
const MAX_MSG = 4096;
const MAX_FRAME = 16384;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let nextId = 1, nextBot = 1000, nextRoom = 1;
const allClients = new Set();
const waiting = { players: [], timer: null, secs: 0 };
const rooms = new Map();

// ---------- HTTP ----------
const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, waiting: waiting.players.length, rooms: rooms.size, clients: allClients.size }));
    return;
  }
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Servidor de Halcones del Alba en marcha. Falta el archivo public/index.html.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('No encontrado');
});

server.on('upgrade', (req, socket) => {
  const up = String(req.headers.upgrade || '').toLowerCase();
  const key = req.headers['sec-websocket-key'];
  if (up !== 'websocket' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  new Client(socket);
});

// ---------- WebSocket (RFC 6455, solo lo necesario) ----------
class Client {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.id = nextId++;
    this.open = true;
    this.room = null;
    this.inLobby = false;
    this.name = 'Piloto';
    this.team = 0;
    this.msgs = 0;
    this.msgWindow = Date.now();
    this.lastPong = Date.now();
    this.frag = null;
    this.fragLen = 0;
    allClients.add(this);
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.destroy());
    this.send({ t: 'hello', id: this.id });
  }

  onData(d) {
    if (!this.open) return;
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_FRAME * 4) { this.close(1009); return; }
    while (this.open && this.parse()) { /* sigue */ }
  }

  parse() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = !!(b[0] & 0x80);
    const op = b[0] & 0x0f;
    const masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) { this.close(1009); return false; }
      len = Number(big); off = 10;
    }
    if (!masked) { this.close(1002); return false; }
    if (len > MAX_FRAME) { this.close(1009); return false; }
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    this.onFrame(fin, op, payload);
    return true;
  }

  onFrame(fin, op, payload) {
    if (op === 0x8) { this.close(1000); return; }
    if (op === 0x9) { this.sendFrame(0xA, payload); return; }
    if (op === 0xA) { this.lastPong = Date.now(); return; }
    if (op === 0x1) {
      if (fin) this.onText(payload.toString('utf8'));
      else { this.frag = [payload]; this.fragLen = payload.length; }
    } else if (op === 0x0) {
      if (!this.frag) return;
      this.frag.push(payload);
      this.fragLen += payload.length;
      if (this.fragLen > MAX_MSG * 2) { this.close(1009); return; }
      if (fin) {
        const full = Buffer.concat(this.frag);
        this.frag = null;
        this.onText(full.toString('utf8'));
      }
    }
  }

  sendFrame(op, payload) {
    if (!this.open || !this.socket.writable) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch (e) { this.destroy(); }
  }

  send(obj) {
    if (!this.open) return;
    if (this.socket.writableLength > 1000000) return; // cliente lento: se omite
    this.sendFrame(0x1, Buffer.from(JSON.stringify(obj)));
  }

  close(code) {
    if (!this.open) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code || 1000, 0);
    this.sendFrame(0x8, p);
    try { this.socket.end(); } catch (e) {}
    setTimeout(() => this.destroy(), 500).unref();
    this.onClose();
  }

  destroy() {
    try { this.socket.destroy(); } catch (e) {}
    this.onClose();
  }

  onClose() {
    if (!this.open && !allClients.has(this)) return;
    this.open = false;
    allClients.delete(this);
    leave(this);
  }

  onText(str) {
    if (str.length > MAX_MSG) return;
    const now = Date.now();
    if (now - this.msgWindow > 1000) { this.msgWindow = now; this.msgs = 0; }
    if (++this.msgs > 160) return; // demasiados mensajes por segundo
    let m;
    try { m = JSON.parse(str); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    handle(this, m);
  }
}

// ---------- Utilidades ----------
function num(v, lo, hi) {
  v = Number(v);
  if (!Number.isFinite(v)) return null;
  return Math.max(lo, Math.min(hi, v));
}
function pickNums(m, keys) {
  const out = {};
  for (const k of keys) {
    const v = num(m[k], -1e6, 1e6);
    if (v === null) { if (m[k] !== undefined) return null; continue; }
    out[k] = v;
  }
  return out;
}
function humans(room) { return room.players.filter((p) => !p.bot && p.client && p.client.open).map((p) => p.client); }
function toAll(room, obj) { humans(room).forEach((c) => c.send(obj)); }
function toOthers(room, from, obj) { humans(room).forEach((c) => { if (c !== from) c.send(obj); }); }

// ---------- Sala de espera ----------
function lobbyInfo() {
  return { t: 'lobby', n: waiting.players.length, max: TEAM_SIZE * 2, secs: waiting.secs };
}
function broadcastLobby() {
  const info = lobbyInfo();
  waiting.players.forEach((c) => c.send(info));
}
function lobbyTick() {
  waiting.secs--;
  if (waiting.players.length >= TEAM_SIZE * 2 && waiting.secs > 3) waiting.secs = 3;
  if (waiting.secs <= 0) { startRoom(); return; }
  broadcastLobby();
}
function joinLobby(c, name) {
  if (c.room || c.inLobby) return;
  c.name = String(name || 'Piloto').replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 14) || 'Piloto';
  c.inLobby = true;
  waiting.players.push(c);
  if (waiting.players.length === 1) {
    waiting.secs = LOBBY_SECS;
    waiting.timer = setInterval(lobbyTick, 1000);
  }
  if (waiting.players.length >= TEAM_SIZE * 2 && waiting.secs > 3) waiting.secs = 3;
  broadcastLobby();
}

function startRoom() {
  clearInterval(waiting.timer);
  waiting.timer = null;
  const list = waiting.players.filter((c) => c.open);
  waiting.players = [];
  if (!list.length) return;
  const room = { id: nextRoom++, players: [], score: [0, 0], host: list[0].id, over: false, byId: new Map(), endAt: Date.now() + TIME_LIMIT * 1000 };
  list.forEach((c, i) => {
    c.inLobby = false;
    c.room = room;
    c.team = i % 2;
    const p = { id: c.id, name: c.name, team: c.team, bot: false, client: c, lastDie: 0 };
    room.players.push(p);
  });
  for (let team = 0; team < 2; team++) {
    const have = room.players.filter((p) => p.team === team).length;
    for (let k = have; k < TEAM_SIZE; k++) {
      room.players.push({ id: nextBot++, name: 'IA ' + (k + 1), team, bot: true, client: null, lastDie: 0 });
    }
  }
  room.players.forEach((p) => room.byId.set(p.id, p));
  rooms.set(room.id, room);
  const roster = room.players.map((p) => ({ id: p.id, name: p.name, team: p.team, bot: p.bot }));
  list.forEach((c) => c.send({ t: 'start', you: c.id, team: c.team, host: room.host, players: roster, kills: KILLS_TO_WIN, secs: TIME_LIMIT }));
}

function ownerOf(room, p) {
  if (!p) return null;
  if (!p.bot) return p.client && p.client.open ? p.client : null;
  return (room.byId.get(room.host) || {}).client || null;
}

// ---------- Mensajes de partida ----------
function handle(c, m) {
  if (m.t === 'join') { joinLobby(c, m.name); return; }
  if (m.t === 'lv') { leave(c); return; }
  if (m.t === 'sq') { let r; try { r = squads.handle(m); } catch (e) { r = { ok: false, err: 'Error del servidor.' }; } r.t = 'sq'; r.rid = m.rid; c.send(r); return; }
  const room = c.room;
  if (!room || room.over) return;
  const me = room.byId.get(c.id);
  if (!me) return;

  if (m.t === 's') {
    const f = pickNums(m, ['x', 'y', 'z', 'p', 'h', 'v', 'b', 'hp', 'al', 'rv', 'tr']);
    if (!f) return;
    f.t = 's'; f.i = c.id;
    toOthers(room, c, f);
  } else if (m.t === 'bs') {
    if (c.id !== room.host || !Array.isArray(m.l)) return;
    const l = [];
    for (const e of m.l.slice(0, 4)) {
      const f = pickNums(e || {}, ['i', 'x', 'y', 'z', 'p', 'h', 'v', 'b', 'hp', 'al', 'rv', 'tr']);
      if (f && room.byId.has(f.i) && room.byId.get(f.i).bot) l.push(f);
    }
    toOthers(room, c, { t: 'bs', l });
  } else if (m.t === 'f') {
    const f = pickNums(m, ['x', 'y', 'z', 'dx', 'dy', 'dz', 'v', 'tm', 'tg']);
    if (!f) return;
    f.t = 'f'; f.k = m.k === 'm' ? 'm' : 'g';
    toOthers(room, c, f);
  } else if (m.t === 'hit') {
    const f = pickNums(m, ['to', 'dmg', 'by']);
    if (!f || f.dmg === undefined || f.to === undefined) return;
    const target = room.byId.get(f.to);
    const owner = ownerOf(room, target);
    if (!target || !owner || owner === c || f.dmg <= 0 || f.dmg > 400) return;
    owner.send({ t: 'hit', to: f.to, dmg: f.dmg, by: f.by || 0 });
  } else if (m.t === 'die') {
    const f = pickNums(m, ['id', 'by']);
    if (!f || f.id === undefined) return;
    const dead = room.byId.get(f.id);
    if (!dead || ownerOf(room, dead) !== c) return;
    const now = Date.now();
    if (now - dead.lastDie < 1500) return;
    dead.lastDie = now;
    const killer = room.byId.get(f.by);
    if (killer && killer.team !== dead.team) room.score[killer.team]++;
    toAll(room, { t: 'die', id: f.id, by: f.by || 0, sc: room.score.slice() });
    if (room.score[0] >= KILLS_TO_WIN || room.score[1] >= KILLS_TO_WIN) endRoom(room, room.score[0] >= KILLS_TO_WIN ? 0 : 1);
  }
}

function endRoom(room, win, why) {
  if (room.over) return;
  room.over = true;
  toAll(room, { t: 'end', win, sc: room.score.slice(), why: why || '' });
  humans(room).forEach((c) => { c.room = null; });
  rooms.delete(room.id);
}

function leave(c) {
  if (c.inLobby) {
    c.inLobby = false;
    waiting.players = waiting.players.filter((x) => x !== c);
    if (!waiting.players.length && waiting.timer) { clearInterval(waiting.timer); waiting.timer = null; }
    else broadcastLobby();
  }
  const room = c.room;
  if (!room) return;
  c.room = null;
  const p = room.byId.get(c.id);
  if (room.over || !p) return;
  if (!humans(room).length) { room.over = true; rooms.delete(room.id); return; }
  if (c.id === room.host) { endRoom(room, -1, 'host'); return; }
  // un jugador se fue: su lugar lo toma una IA que controla el anfitrión
  p.bot = true;
  p.client = null;
  toAll(room, { t: 'left', id: p.id, team: p.team });
}

// ---------- Tiempo límite: gana quien lleve más derribos; si empatan, es empate (win = -2) ----------
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room) => {
    if (!room.over && now >= room.endAt) {
      const a = room.score[0], b = room.score[1];
      endRoom(room, a > b ? 0 : (b > a ? 1 : -2), 'time');
    }
  });
}, 500).unref();

// ---------- Latido ----------
setInterval(() => {
  const now = Date.now();
  allClients.forEach((c) => {
    if (now - c.lastPong > 70000) { c.destroy(); return; }
    c.sendFrame(0x9, Buffer.alloc(0));
  });
}, 25000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log('Halcones del Alba: servidor escuchando en el puerto ' + PORT);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
