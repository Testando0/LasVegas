const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== BANCO EM MEMÓRIA =====
const db = {
  users: new Map(),
  sessions: new Map(),
  rooms: new Map(),
  onlineUsers: new Map() // userId -> ws
};

// ===== AUTH MIDDLEWARE =====
function authenticate(req, res, next) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !db.sessions.has(sessionId)) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  req.user = db.users.get(db.sessions.get(sessionId).userId);
  next();
}

// ===== AUTENTICAÇÃO =====
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username e senha obrigatórios' });
    if (username.length < 3) return res.status(400).json({ error: 'Username mínimo 3 caracteres' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha mínimo 6 caracteres' });

    for (const u of db.users.values()) {
      if (u.username.toLowerCase() === username.toLowerCase()) {
        return res.status(400).json({ error: 'Username já existe' });
      }
    }

    const userId = uuidv4();
    const user = {
      id: userId,
      username,
      password: await bcrypt.hash(password, 10),
      coins: 1000,
      friends: [],
      wins: 0,
      losses: 0,
      musicDownloads: 0,
      videoDownloads: 0,
      avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`,
      createdAt: Date.now()
    };
    db.users.set(userId, user);

    const sessionId = uuidv4();
    db.sessions.set(sessionId, { userId, createdAt: Date.now() });

    res.json({
      sessionId,
      user: sanitizeUser(user)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao registrar' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    let user = null;
    for (const u of db.users.values()) {
      if (u.username.toLowerCase() === username.toLowerCase()) { user = u; break; }
    }
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Senha incorreta' });

    const sessionId = uuidv4();
    db.sessions.set(sessionId, { userId: user.id, createdAt: Date.now() });
    res.json({ sessionId, user: sanitizeUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// ===== USUÁRIO =====
app.get('/api/me', authenticate, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.get('/api/leaderboard', (req, res) => {
  const list = Array.from(db.users.values())
    .map(u => ({ username: u.username, coins: u.coins, wins: u.wins, avatar: u.avatar }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 50);
  res.json({ leaderboard: list });
});

app.get('/api/users/search', authenticate, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (q.length < 2) return res.json({ users: [] });
  const users = Array.from(db.users.values())
    .filter(u => u.id !== req.user.id && u.username.toLowerCase().includes(q))
    .slice(0, 10)
    .map(u => ({ id: u.id, username: u.username, avatar: u.avatar, coins: u.coins }));
  res.json({ users });
});

// ===== AMIGOS =====
app.post('/api/friends/add', authenticate, (req, res) => {
  const { userId } = req.body;
  const friend = db.users.get(userId);
  if (!friend) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (userId === req.user.id) return res.status(400).json({ error: 'Não pode adicionar a si mesmo' });
  if (req.user.friends.includes(userId)) return res.status(400).json({ error: 'Já é seu amigo' });
  req.user.friends.push(userId);
  const friends = req.user.friends.map(id => {
    const u = db.users.get(id);
    return u ? { id: u.id, username: u.username, avatar: u.avatar, coins: u.coins } : null;
  }).filter(Boolean);
  res.json({ success: true, friends });
});

app.post('/api/friends/remove', authenticate, (req, res) => {
  const { userId } = req.body;
  req.user.friends = req.user.friends.filter(id => id !== userId);
  res.json({ success: true, friends: req.user.friends });
});

app.get('/api/friends', authenticate, (req, res) => {
  const friends = req.user.friends.map(id => {
    const u = db.users.get(id);
    if (!u) return null;
    const online = db.onlineUsers.has(id);
    return { id: u.id, username: u.username, avatar: u.avatar, coins: u.coins, online };
  }).filter(Boolean);
  res.json({ friends });
});

// ===== DOWNLOADS =====
app.post('/api/download/music', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const response = await fetch(`https://kuromi-system-tech.onrender.com/api/play-audio?name=${encodeURIComponent(name)}`);
    if (!response.ok) return res.status(500).json({ error: 'Erro na API de música' });
    const data = await response.json();
    const reward = 15;
    req.user.coins += reward;
    req.user.musicDownloads += 1;
    res.json({ success: true, data, reward, newBalance: req.user.coins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao baixar música' });
  }
});

app.post('/api/download/video', authenticate, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });
    const response = await fetch(`https://kuromi-system-tech.onrender.com/api/insta?url=${encodeURIComponent(url)}`);
    if (!response.ok) return res.status(500).json({ error: 'Erro na API de Instagram' });
    const data = await response.json();
    const reward = 25;
    req.user.coins += reward;
    req.user.videoDownloads += 1;
    res.json({ success: true, data, reward, newBalance: req.user.coins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao baixar vídeo' });
  }
});

function sanitizeUser(u) {
  return {
    id: u.id, username: u.username, coins: u.coins, avatar: u.avatar,
    friends: u.friends, wins: u.wins, losses: u.losses,
    musicDownloads: u.musicDownloads, videoDownloads: u.videoDownloads
  };
}

// ===== WEBSOCKET =====
wss.on('connection', (ws, req) => {
  let currentUser = null;
  let currentRoom = null;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'auth': {
          const session = db.sessions.get(msg.sessionId);
          if (!session) return ws.send(JSON.stringify({ type: 'error', message: 'Sessão inválida' }));
          currentUser = db.users.get(session.userId);
          db.onlineUsers.set(currentUser.id, ws);
          ws.send(JSON.stringify({ type: 'authed', user: sanitizeUser(currentUser) }));
          broadcastOnline();
          break;
        }

        case 'create-room': {
          if (!currentUser) return;
          const roomId = uuidv4();
          const room = {
            id: roomId, game: msg.game, host: currentUser.id,
            players: [{ id: currentUser.id, username: currentUser.username, avatar: currentUser.avatar, ws, ready: true }],
            state: null, status: 'waiting', maxPlayers: 2
          };
          db.rooms.set(roomId, room);
          currentRoom = room;
          ws.send(JSON.stringify({ type: 'room-created', room: serializeRoom(room) }));
          break;
        }

        case 'join-room': {
          if (!currentUser) return;
          const room = db.rooms.get(msg.roomId);
          if (!room) return ws.send(JSON.stringify({ type: 'error', message: 'Sala não encontrada' }));
          if (room.players.length >= room.maxPlayers) return ws.send(JSON.stringify({ type: 'error', message: 'Sala cheia' }));
          room.players.push({ id: currentUser.id, username: currentUser.username, avatar: currentUser.avatar, ws, ready: true });
          currentRoom = room;
          broadcastRoom(room, { type: 'player-joined', room: serializeRoom(room) });
          if (room.players.length === 2) startGame(room);
          break;
        }

        case 'play-bot': {
          if (!currentUser) return;
          const roomId = uuidv4();
          const room = {
            id: roomId, game: msg.game, host: currentUser.id,
            players: [
              { id: currentUser.id, username: currentUser.username, avatar: currentUser.avatar, ws, ready: true },
              { id: 'bot', username: '🤖 Robô Cassino', avatar: '🤖', ws: null, ready: true, isBot: true }
            ],
            state: null, status: 'waiting', maxPlayers: 2
          };
          db.rooms.set(roomId, room);
          currentRoom = room;
          ws.send(JSON.stringify({ type: 'room-created', room: serializeRoom(room) }));
          setTimeout(() => startGame(room), 600);
          break;
        }

        case 'invite-friend': {
          if (!currentUser) return;
          const friend = db.users.get(msg.friendId);
          if (!friend) return;
          const friendWs = db.onlineUsers.get(friend.id);
          if (!friendWs) return ws.send(JSON.stringify({ type: 'error', message: 'Amigo offline' }));
          // Cria sala
          const roomId = uuidv4();
          const room = {
            id: roomId, game: msg.game, host: currentUser.id,
            players: [{ id: currentUser.id, username: currentUser.username, avatar: currentUser.avatar, ws, ready: true }],
            state: null, status: 'waiting', maxPlayers: 2
          };
          db.rooms.set(roomId, room);
          currentRoom = room;
          ws.send(JSON.stringify({ type: 'room-created', room: serializeRoom(room) }));
          friendWs.send(JSON.stringify({
            type: 'invite', from: currentUser.username, roomId, game: msg.game, avatar: currentUser.avatar
          }));
          break;
        }

        case 'game-action': {
          if (!currentRoom) return;
          handleGameAction(currentRoom, ws, currentUser, msg.action, msg.data);
          break;
        }

        case 'leave-room': {
          if (!currentRoom) return;
          leaveRoom(currentRoom, currentUser);
          currentRoom = null;
          ws.send(JSON.stringify({ type: 'left-room' }));
          break;
        }
      }
    } catch (err) {
      console.error('WS error:', err);
    }
  });

  ws.on('close', () => {
    if (currentUser) {
      db.onlineUsers.delete(currentUser.id);
      if (currentRoom) leaveRoom(currentRoom, currentUser);
      broadcastOnline();
    }
  });
});

function broadcastOnline() {
  for (const ws of db.onlineUsers.values()) {
    ws.send(JSON.stringify({ type: 'online-count', count: db.onlineUsers.size }));
  }
}

function broadcastRoom(room, msg) {
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(msg));
    }
  }
}

function serializeRoom(room) {
  return {
    id: room.id, game: room.game, status: room.status,
    players: room.players.map(p => ({ id: p.id, username: p.username, avatar: p.avatar })),
    state: room.state
  };
}

function leaveRoom(room, user) {
  room.players = room.players.filter(p => p.id !== user.id);
  if (room.players.length === 0) {
    db.rooms.delete(room.id);
  } else {
    broadcastRoom(room, { type: 'player-left', userId: user.id, room: serializeRoom(room) });
  }
}

// ===== LÓGICA DOS JOGOS =====
function startGame(room) {
  room.status = 'playing';
  if (room.game === 'blackjack') {
    room.state = initBlackjack();
  } else if (room.game === 'slots') {
    room.state = initSlots();
  } else if (room.game === 'roulette') {
    room.state = initRoulette();
  } else if (room.game === 'dice') {
    room.state = initDice();
  }
  broadcastRoom(room, { type: 'game-started', room: serializeRoom(room) });
}

function initBlackjack() {
  const deck = createDeck();
  const playerHand = [deck.pop(), deck.pop()];
  const dealerHand = [deck.pop(), deck.pop()];
  return {
    game: 'blackjack', deck,
    hands: {},
    dealerHand: dealerHand,
    phase: 'playing',
    result: null
  };
}

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const vals = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const d = [];
  for (let k = 0; k < 6; k++) { // 6 decks
    for (const s of suits) for (const v of vals) d.push({ s, v });
  }
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function calcHand(hand) {
  let s = 0, aces = 0;
  for (const c of hand) {
    if (c.v === 'A') { aces++; s += 11; }
    else if (['K', 'Q', 'J'].includes(c.v)) s += 10;
    else s += parseInt(c.v);
  }
  while (s > 21 && aces > 0) { s -= 10; aces--; }
  return s;
}

function initSlots() {
  return { game: 'slots', reels: null, result: null, win: 0 };
}

function initRoulette() {
  return { game: 'roulette', number: null, color: null, bets: {}, phase: 'betting' };
}

function initDice() {
  return {
    game: 'dice',
    scores: {},
    round: 1,
    maxRounds: 5,
    currentTurn: null,
    lastRoll: null
  };
}

function handleGameAction(room, ws, user, action, data) {
  if (room.game === 'blackjack') handleBlackjack(room, ws, user, action, data);
  else if (room.game === 'slots') handleSlots(room, ws, user, action, data);
  else if (room.game === 'roulette') handleRoulette(room, ws, user, action, data);
  else if (room.game === 'dice') handleDice(room, ws, user, action, data);
}

function handleBlackjack(room, ws, user, action, data) {
  if (room.state.phase !== 'playing') return;
  if (!room.state.hands[user.id]) {
    room.state.hands[user.id] = [room.state.deck.pop(), room.state.deck.pop()];
  }
  const hand = room.state.hands[user.id];

  if (action === 'hit') {
    hand.push(room.state.deck.pop());
    const score = calcHand(hand);
    if (score > 21) {
      finishBlackjack(room, user, 'bust');
      return;
    }
  } else if (action === 'stand') {
    while (calcHand(room.state.dealerHand) < 17) {
      room.state.dealerHand.push(room.state.deck.pop());
    }
    const ps = calcHand(hand);
    const ds = calcHand(room.state.dealerHand);
    if (ds > 21) finishBlackjack(room, user, 'win');
    else if (ps > ds) finishBlackjack(room, user, 'win');
    else if (ps < ds) finishBlackjack(room, user, 'lose');
    else finishBlackjack(room, user, 'push');
    return;
  } else if (action === 'double') {
    hand.push(room.state.deck.pop());
    hand.push(room.state.deck.pop());
    const score = calcHand(hand);
    if (score > 21) {
      finishBlackjack(room, user, 'bust', 2);
      return;
    }
    while (calcHand(room.state.dealerHand) < 17) {
      room.state.dealerHand.push(room.state.deck.pop());
    }
    const ps = calcHand(hand);
    const ds = calcHand(room.state.dealerHand);
    if (ds > 21) finishBlackjack(room, user, 'win', 2);
    else if (ps > ds) finishBlackjack(room, user, 'win', 2);
    else if (ps < ds) finishBlackjack(room, user, 'lose', 2);
    else finishBlackjack(room, user, 'push', 2);
    return;
  }
  broadcastRoom(room, { type: 'game-state', state: room.state });
}

function finishBlackjack(room, user, result, mult = 1) {
  room.state.phase = 'finished';
  room.state.result = { userId: user.id, result };
  let reward = 0;
  if (result === 'win') reward = 100 * mult;
  else if (result === 'lose') reward = -50 * mult;
  else if (result === 'bust') reward = -50 * mult;

  applyReward(user, reward, result === 'win');

  // Bot também recebe resultado
  const botPlayer = room.players.find(p => p.isBot);
  if (botPlayer) {
    // Simples: bot tem resultado oposto (se player ganhou, bot perde)
  }

  broadcastRoom(room, { type: 'game-finished', state: room.state, reward, newBalance: user.coins });

  setTimeout(() => {
    db.rooms.delete(room.id);
  }, 8000);
}

function handleSlots(room, ws, user, action, data) {
  if (action !== 'spin') return;
  const symbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣'];
  const reels = [
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)]
  ];
  room.state.reels = reels;
  let win = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    if (reels[0] === '💎') win = 1000;
    else if (reels[0] === '7️⃣') win = 500;
    else if (reels[0] === '⭐') win = 250;
    else win = 150;
  } else if (reels[0] === reels[1] || reels[1] === reels[2]) {
    win = 30;
  }
  room.state.result = reels;
  room.state.win = win;
  applyReward(user, win, win > 0);
  broadcastRoom(room, { type: 'slots-result', reels, win, newBalance: user.coins });
}

function handleRoulette(room, ws, user, action, data) {
  if (action === 'bet') {
    if (!room.state.bets[user.id]) room.state.bets[user.id] = [];
    room.state.bets[user.id].push(data);
    broadcastRoom(room, { type: 'bet-placed', userId: user.id, bet: data });
  } else if (action === 'spin') {
    const number = Math.floor(Math.random() * 37);
    const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    const color = number === 0 ? 'green' : (reds.includes(number) ? 'red' : 'black');
    room.state.number = number;
    room.state.color = color;

    const userBets = room.state.bets[user.id] || [];
    let totalWin = 0;
    for (const b of userBets) {
      if (b.type === 'color' && b.value === color) totalWin += 50;
      else if (b.type === 'parity' && number !== 0) {
        const isEven = number % 2 === 0;
        if ((b.value === 'even' && isEven) || (b.value === 'odd' && !isEven)) totalWin += 50;
      } else if (b.type === 'number' && b.value === number) totalWin += 500;
    }
    applyReward(user, totalWin, totalWin > 0);
    broadcastRoom(room, {
      type: 'roulette-result', number, color, win: totalWin, newBalance: user.coins
    });
  }
}

function handleDice(room, ws, user, action, data) {
  if (action === 'roll') {
    const roll = Math.floor(Math.random() * 6) + 1;
    if (!room.state.scores[user.id]) room.state.scores[user.id] = 0;
    room.state.scores[user.id] += roll;
    room.state.lastRoll = { userId: user.id, value: roll };
    broadcastRoom(room, { type: 'dice-rolled', userId: user.id, value: roll, scores: room.state.scores });

    // Se for vs bot, bot joga também
    const botPlayer = room.players.find(p => p.isBot);
    if (botPlayer) {
      setTimeout(() => {
        const botRoll = Math.floor(Math.random() * 6) + 1;
        if (!room.state.scores['bot']) room.state.scores['bot'] = 0;
        room.state.scores['bot'] += botRoll;
        room.state.round++;
        broadcastRoom(room, { type: 'dice-rolled', userId: 'bot', value: botRoll, scores: room.state.scores });
        if (room.state.round > room.state.maxRounds) {
          finishDice(room);
        }
      }, 1200);
    }
  }
}

function finishDice(room) {
  const human = room.players.find(p => !p.isBot);
  if (!human) return;
  const user = db.users.get(human.id);
  const botScore = room.state.scores['bot'] || 0;
  const userScore = room.state.scores[user.id] || 0;
  let result, reward = 0;
  if (userScore > botScore) { result = 'win'; reward = 200; }
  else if (userScore < botScore) { result = 'lose'; reward = -80; }
  else { result = 'push'; reward = 0; }
  applyReward(user, reward, result === 'win');
  broadcastRoom(room, {
    type: 'dice-finished', result, reward, scores: room.state.scores, newBalance: user.coins
  });
  setTimeout(() => db.rooms.delete(room.id), 8000);
}

function applyReward(user, reward, isWin) {
  user.coins = Math.max(0, user.coins + reward);
  if (isWin) user.wins++;
  else if (reward < 0) user.losses++;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎰 Las Vegas Online rodando em http://localhost:${PORT}`);
});
