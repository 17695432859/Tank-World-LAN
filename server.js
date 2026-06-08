const http = require('http');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const DISCOVERY_HTTP_PORT = 3002;

// Get LAN IP
function getLanIP() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

const LAN_IP = getLanIP();

// HTTP server to serve the game HTML
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ===== LAN Discovery: UDP Broadcast =====
const udpSocket = dgram.createSocket('udp4');

function sendBroadcast() {
  const msg = Buffer.from(JSON.stringify({
    type: 'tankworld-server',
    ip: LAN_IP,
    port: PORT,
    players: Object.keys(players).length,
    maxPlayers: 2,
    timestamp: Date.now()
  }));
  try { udpSocket.send(msg, 0, msg.length, 3001, '255.255.255.255'); } catch(e) {}
}

udpSocket.bind(() => {
  udpSocket.setBroadcast(true);
  setInterval(sendBroadcast, 2000);
  sendBroadcast();
});

// ===== LAN Discovery: HTTP endpoint =====
const discoveryServer = http.createServer((req, res) => {
  if (req.url === '/discover') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify({
      type: 'tankworld-server',
      ip: LAN_IP,
      port: PORT,
      players: Object.keys(players).length,
      maxPlayers: 2
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// WebSocket server
const wss = new WebSocketServer({ server });

let players = {}; // { ws, id, ready }
let playerCount = 0;
let gameState = null;
let gameLoop = null;

const TICK_RATE = 60; // server tick rate
const W = 900, H = 600;

// Obstacle templates (generated once per game)
let obstacles = [];

function generateObstacles() {
  obstacles = [];
  for (let i = 0; i < 12; i++) {
    let x, y, w, h, valid;
    for (let attempt = 0; attempt < 50; attempt++) {
      w = 40 + Math.random() * 60;
      h = 40 + Math.random() * 60;
      x = 80 + Math.random() * (W - 160 - w);
      y = 80 + Math.random() * (H - 160 - h);
      valid = true;
      if (x < 120 && y < 120) valid = false;
      if (x > W - 120 - w && y > H - 120 - h) valid = false;
      for (const o of obstacles) {
        if (x < o.x + o.w + 15 && x + w + 15 > o.x && y < o.y + o.h + 15 && y + h + 15 > o.y) {
          valid = false; break;
        }
      }
      if (valid) break;
    }
    if (valid) obstacles.push({ x, y, w, h });
  }
}

function createTank(x, y, angle) {
  return { x, y, angle, hp: 100, alive: true, shootCooldown: 0, score: 0 };
}

function initState() {
  generateObstacles();
  gameState = {
    t1: createTank(100, H - 100, -Math.PI / 2),
    t2: createTank(W - 100, 100, Math.PI / 2),
    bullets: [],
    obstacles,
    tick: 0,
  };
}

function collidesRect(px, py, r, rect) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const hw = rect.w / 2 + r;
  const hh = rect.h / 2 + r;
  return Math.abs(px - cx) < hw && Math.abs(py - cy) < hh;
}

function pushOutRect(tank, o) {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const hw = o.w / 2 + 18;
  const hh = o.h / 2 + 18;
  if (Math.abs(tank.x - cx) < hw && Math.abs(tank.y - cy) < hh) {
    const dx = tank.x - cx, dy = tank.y - cy;
    if (Math.abs(dx / hw) > Math.abs(dy / hh)) {
      tank.x += dx > 0 ? 1.5 : -1.5;
    } else {
      tank.y += dy > 0 ? 1.5 : -1.5;
    }
  }
}

function updateTank(tank, input) {
  if (!tank.alive) return;
  const speed = 3, rotSpeed = 0.045;

  if (input.left) tank.angle -= rotSpeed;
  if (input.right) tank.angle += rotSpeed;
  if (input.up) {
    tank.x += Math.cos(tank.angle) * speed;
    tank.y += Math.sin(tank.angle) * speed;
  }
  if (input.down) {
    tank.x -= Math.cos(tank.angle) * speed * 0.6;
    tank.y -= Math.sin(tank.angle) * speed * 0.6;
  }

  // Obstacle collision
  for (const o of obstacles) pushOutRect(tank, o);

  // Bounds
  tank.x = Math.max(18, Math.min(W - 18, tank.x));
  tank.y = Math.max(18, Math.min(H - 18, tank.y));

  // Shoot
  if (tank.shootCooldown > 0) tank.shootCooldown--;
  if (input.shoot && tank.shootCooldown <= 0) {
    const bx = tank.x + Math.cos(tank.angle) * 28;
    const by = tank.y + Math.sin(tank.angle) * 28;
    gameState.bullets.push({
      x: bx, y: by,
      dx: Math.cos(tank.angle) * 6,
      dy: Math.sin(tank.angle) * 6,
      owner: tank === gameState.t1 ? 1 : 2,
      life: 120,
    });
    tank.shootCooldown = 18;
  }
}

function gameTick() {
  if (!gameState) return;
  gameState.tick++;

  const inputs = {};
  for (const [id, p] of Object.entries(players)) {
    if (p.input) inputs[p.slot] = p.input;
  }

  if (inputs[1]) updateTank(gameState.t1, inputs[1]);
  if (inputs[2]) updateTank(gameState.t2, inputs[2]);

  // Update bullets
  for (let i = gameState.bullets.length - 1; i >= 0; i--) {
    const b = gameState.bullets[i];
    b.x += b.dx; b.y += b.dy; b.life--;

    // Wall bounce
    if (b.x <= 0 || b.x >= W) { b.dx *= -1; b.x = Math.max(0, Math.min(W, b.x)); }
    if (b.y <= 0 || b.y >= H) { b.dy *= -1; b.y = Math.max(0, Math.min(H, b.y)); }

    let remove = b.life <= 0;

    // Obstacle hit
    if (!remove) {
      for (const o of obstacles) {
        if (b.x > o.x && b.x < o.x + o.w && b.y > o.y && b.y < o.y + o.h) {
          remove = true; break;
        }
      }
    }

    // Tank hit
    if (!remove) {
      const targets = [{ tank: gameState.t1, slot: 1 }, { tank: gameState.t2, slot: 2 }];
      for (const { tank, slot } of targets) {
        if (b.owner === slot || !tank.alive) continue;
        const dx = b.x - tank.x, dy = b.y - tank.y;
        if (Math.sqrt(dx * dx + dy * dy) < 18) {
          tank.hp -= 18;
          remove = true;
          if (tank.hp <= 0) {
            tank.alive = false;
            const winner = slot === 1 ? 2 : 1;
            (slot === 1 ? gameState.t2 : gameState.t1).score++;
            broadcast({ type: 'death', winner, scores: [gameState.t1.score, gameState.t2.score] });
          }
          break;
        }
      }
    }

    if (remove) gameState.bullets.splice(i, 1);
  }

  // Tank-tank push
  const t1 = gameState.t1, t2 = gameState.t2;
  if (t1.alive && t2.alive) {
    const dx = t1.x - t2.x, dy = t1.y - t2.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 36 && dist > 0) {
      const push = (36 - dist) / 2;
      const nx = dx / dist, ny = dy / dist;
      t1.x += nx * push; t1.y += ny * push;
      t2.x -= nx * push; t2.y -= ny * push;
    }
  }

  // Broadcast state
  broadcast({
    type: 'state',
    t1: { x: round(t1.x), y: round(t1.y), a: round(t1.angle), hp: t1.hp, alive: t1.alive },
    t2: { x: round(t2.x), y: round(t2.y), a: round(t2.angle), hp: t2.hp, alive: t2.alive },
    bullets: gameState.bullets.map(b => ({ x: round(b.x), y: round(b.y), o: b.owner })),
    scores: [t1.score, t2.score],
    tick: gameState.tick,
  });
}

function round(n) { return Math.round(n * 100) / 100; }

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function startGameLoop() {
  if (gameLoop) clearInterval(gameLoop);
  gameLoop = setInterval(gameTick, 1000 / TICK_RATE);
}

function stopGameLoop() {
  if (gameLoop) { clearInterval(gameLoop); gameLoop = null; }
}

wss.on('connection', (ws) => {
  if (Object.keys(players).length >= 2) {
    ws.send(JSON.stringify({ type: 'error', msg: '房间已满（最多2人）' }));
    ws.close();
    return;
  }

  playerCount++;
  const id = playerCount;
  const slot = Object.values(players).find(p => p.slot === 1) ? 2 : 1;

  players[id] = { ws, id, slot, input: null };
  ws.send(JSON.stringify({ type: 'welcome', id, slot, obstacles }));
  broadcast({ type: 'playerJoined', count: Object.keys(players).length });

  console.log(`Player ${slot} connected (${Object.keys(players).length}/2)`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input') {
        players[id].input = msg.keys;
      } else if (msg.type === 'start') {
        if (Object.keys(players).length === 2) {
          initState();
          broadcast({ type: 'gameStart', obstacles });
          startGameLoop();
          console.log('Game started!');
        }
      } else if (msg.type === 'restart') {
        if (Object.keys(players).length === 2) {
          initState();
          broadcast({ type: 'gameStart', obstacles });
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    delete players[id];
    stopGameLoop();
    broadcast({ type: 'playerLeft', count: Object.keys(players).length });
    console.log(`Player ${slot} disconnected (${Object.keys(players).length}/2)`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ 双人坦克大战 - 局域网联机版`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`本机访问:    http://localhost:${PORT}`);
  console.log(`局域网访问:  http://${LAN_IP}:${PORT}`);
  console.log(`UDP 广播端口: 3001`);
  console.log(`发现接口端口: ${DISCOVERY_HTTP_PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`同局域网其他设备打开 http://${LAN_IP}:${PORT} 即可自动发现并加入`);
  console.log(`等待玩家加入...\n`);
});

discoveryServer.listen(DISCOVERY_HTTP_PORT, '0.0.0.0', () => {
  console.log(`✓ 局域网发现服务已启动 (端口 ${DISCOVERY_HTTP_PORT})\n`);
});
