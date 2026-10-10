// Flappy Potato – serwer trybu BEREK
// Uruchomienie:  node server.js   (opcjonalnie: PORT=4000 node server.js)
// Protokół: TCP, jedna wiadomość JSON na linię (zakończona \n) – działa bez żadnych bibliotek,
// także po stronie iOS 6 (CFStream).

const net = require('net');
const os = require('os');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROUND_SECONDS = 60;      // długość rundy
const COUNTDOWN_MS = 3000;     // odliczanie 3..2..1 po starcie
const LOBBY_DELAY_MS = 4000;   // ile czekamy po zebraniu min. graczy
const END_PAUSE_MS = 7000;     // pauza po rundzie (wyniki)
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const TAG_IMMUNITY_MS = 2000;  // były berek nie może być od razu "oddany"
const TICK_MS = 50;            // 20 Hz

const players = new Map();     // id -> gracz
let nextId = 1;
let phase = 'lobby';           // 'lobby' | 'playing' | 'ended'
let round = null;              // dane aktualnej rundy
let startTimer = null;

function send(p, obj) {
  if (p.socket.destroyed) return;
  try { p.socket.write(JSON.stringify(obj) + '\n'); } catch (e) { /* ignoruj */ }
}
function broadcast(obj, only) {
  const list = only || Array.from(players.values());
  list.forEach(p => send(p, obj));
}
function log(...a) { console.log(new Date().toLocaleTimeString(), ...a); }

// ---------- lobby ----------
function lobbyInfo() {
  const n = players.size;
  let msg;
  if (n < MIN_PLAYERS) msg = 'Czekam na graczy (' + n + '/' + MIN_PLAYERS + ')...';
  else msg = 'Start za chwile! Graczy: ' + n;
  broadcast({ t: 'lobby', n: n, msg: msg });
}

function scheduleStart() {
  if (phase !== 'lobby') return;
  if (players.size >= MIN_PLAYERS) {
    if (!startTimer) startTimer = setTimeout(startRound, LOBBY_DELAY_MS);
  } else if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
  lobbyInfo();
}

// ---------- runda ----------
function startRound() {
  startTimer = null;
  if (phase !== 'lobby' || players.size < MIN_PLAYERS) { scheduleStart(); return; }

  const parts = Array.from(players.values());
  parts.forEach((p, i) => {
    p.slot = i; p.timeIt = 0; p.y = 0.5; p.r = 0; p.a = 1; p.immuneUntil = 0;
  });
  const it = parts[Math.floor(Math.random() * parts.length)];
  const now = Date.now();
  round = {
    ids: parts.map(p => p.id),
    it: it.id,
    startAt: now + COUNTDOWN_MS,
    endAt: now + COUNTDOWN_MS + ROUND_SECONDS * 1000,
    lastTick: now + COUNTDOWN_MS,
    tagLockUntil: 0,
    seed: Math.floor(Math.random() * 2147483646) + 1
  };
  phase = 'playing';
  log('Start rundy, graczy:', parts.length, 'berek:', it.name);

  broadcast({
    t: 'start',
    seed: round.seed,
    dur: ROUND_SECONDS,
    countdown: COUNTDOWN_MS / 1000,
    it: it.id,
    players: parts.map(p => ({ id: p.id, name: p.name, slot: p.slot }))
  }, parts);
}

function roundPlayers() {
  return round.ids.map(id => players.get(id)).filter(Boolean);
}

function endRound(reason) {
  if (phase !== 'playing') return;
  const list = roundPlayers().sort((a, b) => a.timeIt - b.timeIt);
  const ranking = list.map(p => ({ id: p.id, name: p.name, time: Math.round(p.timeIt * 10) / 10 }));
  log('Koniec rundy (' + reason + '):', ranking.map(r => r.name + ' ' + r.time + 's').join(', '));
  phase = 'ended';
  round = null;
  broadcast({ t: 'end', reason: reason, ranking: ranking });
  setTimeout(() => { phase = 'lobby'; scheduleStart(); }, END_PAUSE_MS);
}

function tick() {
  if (phase !== 'playing' || !round) return;
  const now = Date.now();
  const ps = roundPlayers();

  if (ps.length < MIN_PLAYERS) { endRound('za malo graczy'); return; }

  if (now >= round.startAt) {
    const dt = (now - round.lastTick) / 1000;
    round.lastTick = now;
    const itP = players.get(round.it);
    if (itP) itP.timeIt += dt;
  }

  if (now >= round.endAt) { endRound('koniec czasu'); return; }

  const times = {};
  ps.forEach(p => { times[p.id] = Math.round(p.timeIt * 10) / 10; });
  broadcast({
    t: 'state',
    it: round.it,
    left: Math.max(0, Math.ceil((round.endAt - Math.max(now, round.startAt)) / 1000)),
    p: ps.map(p => [p.id, Math.round(p.y * 1000) / 1000, Math.round(p.r * 100) / 100, p.a]),
    times: times
  }, ps);
}
setInterval(tick, TICK_MS);

// ---------- wiadomości od klientów ----------
function handle(p, m) {
  switch (m.t) {
    case 'ping':
      break;

    case 'pos':
      if (typeof m.y === 'number') p.y = Math.min(Math.max(m.y, -0.5), 1.5);
      if (typeof m.r === 'number') p.r = m.r;
      p.a = m.a ? 1 : 0;
      break;

    case 'tag': {
      if (phase !== 'playing' || !round) break;
      const now = Date.now();
      if (now < round.startAt || now < round.tagLockUntil) break;
      if (round.it !== p.id || !p.a) break;                    // tylko berek może łapać
      const target = players.get(m.id);
      if (!target || target.id === p.id || !round.ids.includes(target.id)) break;
      if (!target.a || now < target.immuneUntil) break;
      p.immuneUntil = now + TAG_IMMUNITY_MS;                   // oddany berek ma chwilę spokoju
      round.it = target.id;
      round.tagLockUntil = now + 500;
      log(p.name, 'zlapal', target.name);
      broadcast({ t: 'tagged', it: target.id, by: p.id });
      break;
    }
  }
}

// ---------- połączenia ----------
const server = net.createServer(socket => {
  socket.setEncoding('utf8');
  socket.setNoDelay(true);
  socket.setTimeout(30000);          // klient pinguje co 5 s

  let buf = '';
  let me = null;

  socket.on('data', chunk => {
    buf += chunk;
    if (buf.length > 20000) { socket.destroy(); return; }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (e) { continue; }
      if (!m || typeof m.t !== 'string') continue;

      if (!me) {
        if (m.t !== 'join') continue;
        if (players.size >= MAX_PLAYERS) {
          socket.write(JSON.stringify({ t: 'full' }) + '\n');
          socket.end();
          return;
        }
        const name = String(m.name || 'Gracz').replace(/[^\w \-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, '').slice(0, 14) || 'Gracz';
        me = { id: nextId++, name: name, socket: socket, slot: 0, y: 0.5, r: 0, a: 1, timeIt: 0, immuneUntil: 0 };
        players.set(me.id, me);
        log('Dolaczyl', me.name, '(id ' + me.id + ') graczy:', players.size);
        send(me, { t: 'welcome', id: me.id, phase: phase });
        scheduleStart();
        continue;
      }
      handle(me, m);
    }
  });

  function drop() {
    if (!me || !players.has(me.id)) return;
    players.delete(me.id);
    log('Wyszedl', me.name, 'graczy:', players.size);
    if (phase === 'playing' && round) {
      round.ids = round.ids.filter(id => id !== me.id);
      if (round.it === me.id && round.ids.length) {
        round.it = round.ids[Math.floor(Math.random() * round.ids.length)];
        broadcast({ t: 'tagged', it: round.it, by: 0 });
      }
    }
    broadcast({ t: 'left', id: me.id });
    if (phase === 'lobby') scheduleStart();
  }

  socket.on('timeout', () => socket.destroy());
  socket.on('error', () => socket.destroy());
  socket.on('close', drop);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('=== Flappy Potato – serwer BEREK ===');
  console.log('Port:', PORT);
  console.log('Wpisz w grze jeden z adresow:');
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(n => ifs[n].forEach(i => {
    if (i.family === 'IPv4' && !i.internal) console.log('   ' + i.address + ':' + PORT + '   (' + n + ')');
  }));
  console.log('Gra w sieci lokalnej (to samo Wi-Fi). Przez internet: przekieruj port', PORT, 'na routerze.');
});