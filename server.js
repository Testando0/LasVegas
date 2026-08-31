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
app.use(express.json({ limit: '50mb' }));

const db = {
  users: new Map(),
  sessions: new Map(),
  rooms: new Map(),
  onlineUsers: new Map()
};

function authenticate(req, res, next) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !db.sessions.has(sessionId)) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  req.user = db.users.get(db.sessions.get(sessionId).userId);
  next();
}

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
      avatar: `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(username)}`,
      createdAt: Date.now()
    };
    db.users.set(userId, user);

    const sessionId = uuidv4();
    db.sessions.set(sessionId, { userId, createdAt: Date.now() });

    res.json({ sessionId, user: sanitizeUser(user) });
  } catch (err) {
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

app.post('/api/friends/add', authenticate, (req, res) => {
  const { userId } = req.body;
  const friend = db.users.get(userId);
  if (!friend) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (userId === req.user.id) return res.status(400).json({ error: 'Não pode adicionar a si mesmo' });
  if (req.user.friends.includes(userId)) return res.status(400).json({ error: 'Já é seu amigo' });
  req.user.friends.push(userId);
  res.json({ success: true });
});

app.post('/api/friends/remove', authenticate, (req, res) => {
  const { userId } = req.body;
  req.user.friends = req.user.friends.filter(id => id !== userId);
  res.json({ success: true });
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

// DOWNLOAD DE MÚSICA COM PROXYCORS.IO
app.post('/api/download/music', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    
    const apiUrl = `https://kuromi-system-tech.onrender.com/api/play-audio?name=${encodeURIComponent(name)}`;
    const proxyUrl = `https://proxycors.io/?url=${encodeURIComponent(apiUrl)}`;
    
    console.log('Buscando música via proxycors.io:', proxyUrl);
    
    const response = await fetch(proxyUrl, { 
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    if (!response.ok) {
      console.error('Erro na API:', response.status, response.statusText);
      return res.status(500).json({ error: `API retornou erro ${response.status}` });
    }
    
    const contentType = response.headers.get('content-type');
    console.log('Content-Type:', contentType);
    
    // Se for JSON
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      console.log('Resposta JSON:', JSON.stringify(data).substring(0, 300));
      
      // Extrair URL de áudio
      let audioUrl = data.url || data.audio_url || data.download_url || data.link || data.audio;
      
      if (audioUrl) {
        const reward = 15;
        req.user.coins += reward;
        req.user.musicDownloads += 1;
        return res.json({ 
          success: true, 
          downloadUrl: audioUrl,
          filename: `${name}.mp3`,
          reward, 
          newBalance: req.user.coins 
        });
      }
      
      return res.status(500).json({ error: 'URL de áudio não encontrada na resposta' });
    }
    
    // Se for áudio direto
    const buffer = await response.buffer();
    const base64 = buffer.toString('base64');
    const mimeType = contentType || 'audio/mpeg';
    const dataUrl = `data:${mimeType};base64,${base64}`;
    
    const reward = 15;
    req.user.coins += reward;
    req.user.musicDownloads += 1;
    
    res.json({ 
      success: true, 
      downloadUrl: dataUrl,
      filename: `${name}.mp3`,
      reward, 
      newBalance: req.user.coins 
    });
  } catch (err) {
    console.error('Erro completo:', err);
    res.status(500).json({ error: `Erro: ${err.message}` });
  }
});

// DOWNLOAD DE VÍDEO COM PROXYCORS.IO
app.post('/api/download/video', authenticate, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });
    
    const apiUrl = `https://kuromi-system-tech.onrender.com/api/insta?url=${encodeURIComponent(url)}`;
    const proxyUrl = `https://proxycors.io/?url=${encodeURIComponent(apiUrl)}`;
    
    console.log('Buscando vídeo via proxycors.io:', proxyUrl);
    
    const response = await fetch(proxyUrl, { 
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    if (!response.ok) {
      return res.status(500).json({ error: `API retornou erro ${response.status}` });
    }
    
    const contentType = response.headers.get('content-type');
    console.log('Content-Type vídeo:', contentType);
    
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      console.log('Resposta vídeo:', JSON.stringify(data).substring(0, 300));
      
      let videoUrl = null;
      
      // Tentar várias estruturas possíveis
      if (data.video_url) videoUrl = data.video_url;
      else if (data.url) videoUrl = data.url;
      else if (data.download_url) videoUrl = data.download_url;
      else if (data.link) videoUrl = data.link;
      else if (data.video) videoUrl = data.video;
      else if (data.result?.video_url) videoUrl = data.result.video_url;
      else if (data.data?.video_url) videoUrl = data.data.video_url;
      else if (Array.isArray(data) && data[0]?.video_url) videoUrl = data[0].video_url;
      else if (data.hd) videoUrl = data.hd;
      else if (data.sd) videoUrl = data.sd;
      
      if (videoUrl) {
        const reward = 25;
        req.user.coins += reward;
        req.user.videoDownloads += 1;
        return res.json({ 
          success: true, 
          downloadUrl: videoUrl,
          filename: `reel_${Date.now()}.mp4`,
          reward, 
          newBalance: req.user.coins 
        });
      }
      
      return res.status(500).json({ error: 'URL de vídeo não encontrada' });
    }
    
    // Se for vídeo direto
    const buffer = await response.buffer();
    const base64 = buffer.toString('base64');
    const mimeType = contentType || 'video/mp4';
    const dataUrl = `data:${mimeType};base64,${base64}`;
    
    const reward = 25;
    req.user.coins += reward;
    req.user.videoDownloads += 1;
    
    res.json({ 
      success: true, 
      downloadUrl: dataUrl,
      filename: `reel_${Date.now()}.mp4`,
      reward, 
      newBalance: req.user.coins 
    });
  } catch (err) {
    console.error('Erro vídeo:', err);
    res.status(500).json({ error: `Erro: ${err.message}` });
  }
});

function sanitizeUser(u) {
  return {
    id: u.id, username: u.username, coins: u.coins, avatar: u.avatar,
    friends: u.friends, wins: u.wins, losses: u.losses,
    musicDownloads: u.musicDownloads, videoDownloads: u.videoDownloads
  };
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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
          break;
        }
        case 'play-bot': {
          if (!currentUser) return;
          const roomId = uuidv4();
          const room = {
            id: roomId, game: msg.game, host: currentUser.id,
            players: [
              { id: currentUser.id, username: currentUser.username, avatar: currentUser.avatar, ws, ready: true },
              { id: 'bot', username: '🤖 Robô', avatar: '🤖', ws: null, ready: true, isBot: true }
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
            type: 'invite', from: currentUser.username, roomId, game: msg.game
          }));
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
    }
  });
});

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
  if (room.players.length === 0) db.rooms.delete(room.id);
}

function startGame(room) {
  room.status = 'playing';
  if (room.game === 'blackjack') room.state = initBlackjack();
  else if (room.game === 'slots') room.state = initSlots();
  else if (room.game === 'roulette') room.state = initRoulette();
  else if (room.game === 'dice') room.state = initDice();
  broadcastRoom(room, { type: 'game-started', room: serializeRoom(room) });
}

function initBlackjack() {
  const deck = createDeck();
  return { game: 'blackjack', deck, hands: {}, dealerHand: [deck.pop(), deck.pop()], phase: 'playing', result: null };
}

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const vals = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const d = [];
  for (let k = 0; k < 6; k++) for (const s of suits) for (const v of vals) d.push({ s, v });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

function calcHand(hand) {
  let s = 0, aces = 0;
  for (const c of hand) { if (c.v === 'A') { aces++; s += 11; } else if (['K','Q','J'].includes(c.v)) s += 10; else s += parseInt(c.v); }
  while (s > 21 && aces > 0) { s -= 10; aces--; }
  return s;
}

function initSlots() { return { game: 'slots', reels: null, win: 0 }; }
function initRoulette() { return { game: 'roulette', number: null, color: null, bets: {} }; }
function initDice() { return { game: 'dice', scores: {}, round: 1, maxRounds: 5, lastRoll: null }; }

function handleGameAction(room, ws, user, action, data) {
  if (room.game === 'blackjack') handleBlackjack(room, ws, user, action);
  else if (room.game === 'slots') handleSlots(room, ws, user, action);
  else if (room.game === 'roulette') handleRoulette(room, ws, user, action, data);
  else if (room.game === 'dice') handleDice(room, ws, user, action);
}

function handleBlackjack(room, ws, user, action) {
  if (room.state.phase !== 'playing') return;
  if (!room.state.hands[user.id]) room.state.hands[user.id] = [room.state.deck.pop(), room.state.deck.pop()];
  const hand = room.state.hands[user.id];

  if (action === 'hit') {
    hand.push(room.state.deck.pop());
    if (calcHand(hand) > 21) { finishBlackjack(room, user, 'bust'); return; }
  } else if (action === 'stand') {
    while (calcHand(room.state.dealerHand) < 17) room.state.dealerHand.push(room.state.deck.pop());
    const ps = calcHand(hand), ds = calcHand(room.state.dealerHand);
    if (ds > 21) finishBlackjack(room, user, 'win');
    else if (ps > ds) finishBlackjack(room, user, 'win');
    else if (ps < ds) finishBlackjack(room, user, 'lose');
    else finishBlackjack(room, user, 'push');
    return;
  }
  broadcastRoom(room, { type: 'game-state', state: room.state });
}

function finishBlackjack(room, user, result) {
  room.state.phase = 'finished';
  room.state.result = { userId: user.id, result };
  let reward = result === 'win' ? 100 : (result === 'lose' || result === 'bust') ? -50 : 0;
  user.coins = Math.max(0, user.coins + reward);
  if (result === 'win') user.wins++;
  else if (reward < 0) user.losses++;
  broadcastRoom(room, { type: 'game-finished', state: room.state, reward, newBalance: user.coins });
  setTimeout(() => db.rooms.delete(room.id), 8000);
}

function handleSlots(room, ws, user, action) {
  if (action !== 'spin') return;
  const symbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣'];
  const reels = Array(3).fill(null).map(() => symbols[Math.floor(Math.random() * symbols.length)]);
  let win = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    if (reels[0] === '💎') win = 1000;
    else if (reels[0] === '7️⃣') win = 500;
    else if (reels[0] === '⭐') win = 250;
    else win = 150;
  } else if (reels[0] === reels[1] || reels[1] === reels[2]) win = 30;
  user.coins += win;
  if (win > 0) user.wins++;
  broadcastRoom(room, { type: 'slots-result', reels, win, newBalance: user.coins });
}

function handleRoulette(room, ws, user, action, data) {
  if (action === 'bet') {
    if (!room.state.bets[user.id]) room.state.bets[user.id] = [];
    room.state.bets[user.id].push(data);
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
    user.coins += totalWin;
    if (totalWin > 0) user.wins++;
    broadcastRoom(room, { type: 'roulette-result', number, color, win: totalWin, newBalance: user.coins });
  }
}

function handleDice(room, ws, user, action) {
  if (action === 'roll') {
    const roll = Math.floor(Math.random() * 6) + 1;
    if (!room.state.scores[user.id]) room.state.scores[user.id] = 0;
    room.state.scores[user.id] += roll;
    room.state.lastRoll = { userId: user.id, value: roll };
    broadcastRoom(room, { type: 'dice-rolled', userId: user.id, value: roll, scores: room.state.scores });
    const botPlayer = room.players.find(p => p.isBot);
    if (botPlayer) {
      setTimeout(() => {
        const botRoll = Math.floor(Math.random() * 6) + 1;
        if (!room.state.scores['bot']) room.state.scores['bot'] = 0;
        room.state.scores['bot'] += botRoll;
        room.state.round++;
        broadcastRoom(room, { type: 'dice-rolled', userId: 'bot', value: botRoll, scores: room.state.scores });
        if (room.state.round > room.state.maxRounds) finishDice(room);
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
  user.coins = Math.max(0, user.coins + reward);
  if (result === 'win') user.wins++;
  else if (reward < 0) user.losses++;
  broadcastRoom(room, { type: 'dice-finished', result, reward, scores: room.state.scores, newBalance: user.coins });
  setTimeout(() => db.rooms.delete(room.id), 8000);
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎰 Las Vegas Online rodando em http://localhost:${PORT}`);
});
