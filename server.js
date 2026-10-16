// ZOMBIES multiplayer relay server.
// Host-authoritative: one player's browser runs the simulation; this server only
// manages rooms and relays messages. It also serves the game page itself.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const GAME = path.join(__dirname, 'game.html');
const rooms = new Map(); // code -> { code, host, guests: Map(id -> ws), started }

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html' || url === '/game.html') {
    fs.readFile(GAME, (err, buf) => {
      if (err) { res.writeHead(500); res.end('game.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

function code4() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let t = 0; t < 50; t++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function roster(room) { return [0, ...room.guests.keys()]; }

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  if (ws.pid === 0) {
    for (const g of room.guests.values()) { send(g, { t: 'closed' }); g.room = null; }
    rooms.delete(room.code);
  } else {
    room.guests.delete(ws.pid);
    send(room.host, { t: 'peer', id: ws.pid, join: false });
  }
}

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'host') {
      if (ws.room) leave(ws);
      const code = code4();
      if (!code) { send(ws, { t: 'err', msg: 'Server is full, try again later' }); return; }
      const room = { code, host: ws, guests: new Map(), started: false };
      rooms.set(code, room);
      ws.room = room; ws.pid = 0;
      send(ws, { t: 'room', code, id: 0 });
    } else if (m.t === 'join') {
      if (ws.room) leave(ws);
      const room = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!room) { send(ws, { t: 'err', msg: 'Room not found' }); return; }
      if (room.started) { send(ws, { t: 'err', msg: 'Game already started' }); return; }
      let id = 1;
      while (room.guests.has(id)) id++;
      if (id >= MAX_PLAYERS) { send(ws, { t: 'err', msg: 'Room is full (4 players)' }); return; }
      room.guests.set(id, ws);
      ws.room = room; ws.pid = id;
      send(ws, { t: 'joined', code: room.code, id });
      send(room.host, { t: 'peer', id, join: true });
    } else if (m.t === 'lock') {
      if (ws.room && ws.pid === 0) ws.room.started = !!m.on;
    } else if (m.t === 'in') { // guest -> host
      const room = ws.room;
      if (room && ws.pid > 0) send(room.host, { t: 'from', id: ws.pid, d: m.d });
    } else if (m.t === 'to') { // host -> one guest
      const room = ws.room;
      if (room && ws.pid === 0) send(room.guests.get(Number(m.id)), { t: 'msg', d: m.d });
    } else if (m.t === 'all') { // host -> every guest
      const room = ws.room;
      if (room && ws.pid === 0) for (const g of room.guests.values()) send(g, { t: 'msg', d: m.d });
    } else if (m.t === 'leave') {
      leave(ws);
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 15000);

server.listen(PORT, () => console.log('ZOMBIES server on :' + PORT));
