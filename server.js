const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Word bank ────────────────────────────────────────────────────────────────
const WORDS = [
  'cat','dog','fish','bird','elephant','lion','penguin','butterfly','dragon','mermaid',
  'house','castle','lighthouse','bridge','pyramid','igloo','windmill','rocket','spaceship','submarine',
  'apple','banana','pizza','burger','cake','coffee','ice cream','sushi','taco','watermelon',
  'guitar','piano','drum','violin','microphone','headphones','trophy','crown','diamond','sword',
  'sun','moon','star','rainbow','cloud','volcano','mountain','island','waterfall','tornado',
  'car','bicycle','airplane','train','hot air balloon','helicopter','skateboard','sailboat','canoe','parachute',
  'pencil','scissors','umbrella','glasses','camera','clock','compass','microscope','magnet','robot',
  'heart','ghost','alien','wizard','ninja','superhero','mummy','vampire','zombie','fairy',
  'book','laptop','phone','television','lightbulb','key','lock','magnifying glass','map','lantern',
  'snowman','pumpkin','christmas tree','fireworks','beach','campfire','treasure chest','cactus','mushroom','tornado'
];

// ─── Room helpers ─────────────────────────────────────────────────────────────
const rooms = {};

function makeRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function pickWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function broadcastPlayers(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('players_update', room.players.map(p => ({
    id: p.id, name: p.name, score: p.score, isDrawing: p.isDrawing
  })));
}

function startRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < 2) return;

  clearTimeout(room.timer);
  room.state        = 'playing';
  room.currentWord  = pickWord();
  room.guessedIds   = new Set();
  room.roundStartMs = Date.now();

  const drawerIdx = room.drawerIndex % room.players.length;
  room.players.forEach((p, i) => { p.isDrawing = (i === drawerIdx); });
  const drawer = room.players[drawerIdx];

  // Tell everyone the round is starting
  room.players.forEach(p => {
    if (p.isDrawing) {
      io.to(p.id).emit('your_turn', {
        word: room.currentWord,
        round: room.round,
        maxRounds: room.maxRounds,
        duration: room.roundDuration
      });
    } else {
      io.to(p.id).emit('round_start', {
        drawerName: drawer.name,
        wordLength: room.currentWord.length,
        wordHint:   room.currentWord.replace(/[a-zA-Z]/g, '_'),
        round:      room.round,
        maxRounds:  room.maxRounds,
        duration:   room.roundDuration
      });
    }
  });

  broadcastPlayers(roomId);
  io.to(roomId).emit('clear_canvas');
  io.to(roomId).emit('system_msg', { text: `Round ${room.round} — ${drawer.name} is drawing!` });

  room.timer = setTimeout(() => endRound(roomId), room.roundDuration * 1000);
}

function endRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.state !== 'playing') return;

  clearTimeout(room.timer);
  room.state = 'roundEnd';

  io.to(roomId).emit('round_end', {
    word:   room.currentWord,
    scores: room.players.map(p => ({ name: p.name, score: p.score }))
  });

  room.drawerIndex++;
  room.round++;

  if (room.round > room.maxRounds) {
    room.timer = setTimeout(() => endGame(roomId), 6000);
  } else {
    room.timer = setTimeout(() => startRound(roomId), 6000);
  }
}

function endGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  clearTimeout(room.timer);
  room.state = 'finished';
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  io.to(roomId).emit('game_over', { scores: sorted.map(p => ({ name: p.name, score: p.score })) });
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  // CREATE ROOM
  socket.on('create_room', ({ name, maxRounds = 3, roundDuration = 90 }) => {
    const roomId = makeRoomId();
    rooms[roomId] = {
      id: roomId, host: socket.id, state: 'waiting',
      players: [{ id: socket.id, name, score: 0, isDrawing: false }],
      round: 1, maxRounds, roundDuration,
      drawerIndex: 0, currentWord: '', guessedIds: new Set(),
      roundStartMs: 0, timer: null
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room_created', { roomId });
    broadcastPlayers(roomId);
  });

  // JOIN ROOM
  socket.on('join_room', ({ name, roomId }) => {
    const room = rooms[roomId];
    if (!room)                        return socket.emit('join_error', 'Room not found');
    if (room.state !== 'waiting')     return socket.emit('join_error', 'Game already started');
    if (room.players.length >= 12)     return socket.emit('join_error', 'Room is full (max 12)');

    room.players.push({ id: socket.id, name, score: 0, isDrawing: false });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room_joined', { roomId, hostId: room.host });
    io.to(roomId).emit('system_msg', { text: `${name} joined the room!` });
    broadcastPlayers(roomId);
  });

  // START GAME (host only)
  socket.on('start_game', () => {
    const room = rooms[socket.roomId];
    if (!room || socket.id !== room.host) return;
    if (room.players.length < 2) return socket.emit('join_error', 'Need at least 2 players to start');
    startRound(socket.roomId);
  });

  // DRAWING EVENTS — relay to room (not back to sender)
  socket.on('draw_event', data => {
    socket.to(socket.roomId).emit('draw_event', data);
  });

  // CHAT / GUESS
  socket.on('guess', ({ text }) => {
    const room = rooms[socket.roomId];
    if (!room || room.state !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.isDrawing || room.guessedIds.has(socket.id)) return;

    const correct = text.trim().toLowerCase() === room.currentWord.toLowerCase();
    if (correct) {
      room.guessedIds.add(socket.id);
      const elapsed  = (Date.now() - room.roundStartMs) / 1000;
      const timeLeft = Math.max(0, room.roundDuration - elapsed);
      const pts      = Math.round(50 + timeLeft * 1.5);
      player.score  += pts;

      // Drawer earns points per guesser
      const drawer = room.players.find(p => p.isDrawing);
      if (drawer) drawer.score += 20;

      io.to(socket.roomId).emit('correct_guess', { name: player.name, pts });
      broadcastPlayers(socket.roomId);

      // End early if everyone guessed
      const guessers = room.players.filter(p => !p.isDrawing);
      if (room.guessedIds.size >= guessers.length) endRound(socket.roomId);
    } else {
      io.to(socket.roomId).emit('chat_msg', { name: player.name, text });
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      clearTimeout(room.timer);
      delete rooms[socket.roomId];
      return;
    }
    if (room.host === socket.id) {
      room.host = room.players[0].id;
      io.to(room.host).emit('you_are_host');
    }
    io.to(socket.roomId).emit('system_msg', { text: 'A player disconnected.' });
    broadcastPlayers(socket.roomId);
    if (room.state === 'playing' && !room.players.find(p => p.isDrawing)) {
      endRound(socket.roomId);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`✅ SketchParty running → http://localhost:${PORT}`));
