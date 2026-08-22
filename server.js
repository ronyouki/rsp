// じゃんけんオンライン対戦サーバー
// Node.js + Express + Socket.io

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// roomCode -> { players: [socketId, socketId], choices: {}, scores: {} }
const rooms = new Map();

// ランダムマッチング待ちの socketId 一覧（合言葉コードなしで対戦相手を探す用）
let waitingQueue = [];

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0/O, 1/I)は除外
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
const WIN_SCORE = 10; // 先取本数

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

// h1 が h2 に勝てば 'p1'、負ければ 'p2'、同じ手なら 'draw'
function judge(h1, h2) {
  if (h1 === h2) return 'draw';
  return BEATS[h1] === h2 ? 'p1' : 'p2';
}

function leaveQueue(socket) {
  waitingQueue = waitingQueue.filter((id) => id !== socket.id);
}

function leaveCurrentRoom(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;

  room.players = room.players.filter((id) => id !== socket.id);
  delete room.choices[socket.id];

  if (room.players.length === 0) {
    rooms.delete(code);
  } else {
    io.to(code).emit('opponentLeft');
  }
  socket.leave(code);
  socket.data.room = null;
}

io.on('connection', (socket) => {
  socket.on('createRoom', () => {
    leaveCurrentRoom(socket);
    const code = generateRoomCode();
    rooms.set(code, {
      players: [socket.id],
      choices: {},
      scores: { [socket.id]: 0 },
      matchOver: false,
      rematchRequests: new Set(),
    });
    socket.join(code);
    socket.data.room = code;
    socket.emit('roomCreated', { code });
  });

  socket.on('joinRoom', (rawCode) => {
    const code = String(rawCode || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('joinError', '部屋が見つかりません。コードを確認してください。');
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('joinError', 'この部屋はすでに満員です。');
      return;
    }

    leaveCurrentRoom(socket);
    room.players.push(socket.id);
    room.scores[socket.id] = 0;
    socket.join(code);
    socket.data.room = code;

    io.to(code).emit('opponentJoined');
  });

  // 合言葉なしのランダムマッチング
  socket.on('findRandomMatch', () => {
    leaveCurrentRoom(socket);
    leaveQueue(socket);

    // 待機中に切断済みの相手が残っていないか掃除する
    waitingQueue = waitingQueue.filter((id) => io.sockets.sockets.has(id));

    const opponentId = waitingQueue.shift();
    const opponentSocket = opponentId ? io.sockets.sockets.get(opponentId) : null;

    if (opponentSocket) {
      const code = generateRoomCode();
      rooms.set(code, {
        players: [opponentId, socket.id],
        choices: {},
        scores: { [opponentId]: 0, [socket.id]: 0 },
        matchOver: false,
        rematchRequests: new Set(),
      });
      opponentSocket.join(code);
      opponentSocket.data.room = code;
      socket.join(code);
      socket.data.room = code;

      io.to(code).emit('opponentJoined');
    } else {
      waitingQueue.push(socket.id);
      socket.emit('waitingForMatch');
    }
  });

  socket.on('cancelMatch', () => leaveQueue(socket));

  socket.on('chooseHand', (hand) => {
    if (!['rock', 'scissors', 'paper'].includes(hand)) return;

    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room || room.players.length < 2 || room.matchOver) return;

    room.choices[socket.id] = hand;
    const otherId = room.players.find((id) => id !== socket.id);
    if (otherId) io.to(otherId).emit('opponentChose');

    const [p1, p2] = room.players;
    if (room.choices[p1] && room.choices[p2]) {
      const h1 = room.choices[p1];
      const h2 = room.choices[p2];
      const result = judge(h1, h2);

      if (result === 'p1') room.scores[p1]++;
      else if (result === 'p2') room.scores[p2]++;

      const matchOver = room.scores[p1] >= WIN_SCORE || room.scores[p2] >= WIN_SCORE;
      if (matchOver) room.matchOver = true;

      io.to(p1).emit('roundResult', {
        yourHand: h1,
        opponentHand: h2,
        outcome: result === 'draw' ? 'draw' : result === 'p1' ? 'win' : 'lose',
        yourScore: room.scores[p1],
        opponentScore: room.scores[p2],
        matchOver,
        youWonMatch: matchOver ? room.scores[p1] >= WIN_SCORE : null,
      });
      io.to(p2).emit('roundResult', {
        yourHand: h2,
        opponentHand: h1,
        outcome: result === 'draw' ? 'draw' : result === 'p2' ? 'win' : 'lose',
        yourScore: room.scores[p2],
        opponentScore: room.scores[p1],
        matchOver,
        youWonMatch: matchOver ? room.scores[p2] >= WIN_SCORE : null,
      });

      room.choices = {};
    }
  });

  socket.on('requestRematch', () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room || room.players.length < 2) return;

    room.rematchRequests.add(socket.id);

    if (room.rematchRequests.size >= 2) {
      const [p1, p2] = room.players;
      room.scores = { [p1]: 0, [p2]: 0 };
      room.choices = {};
      room.matchOver = false;
      room.rematchRequests.clear();
      io.to(code).emit('rematchStart');
    } else {
      const otherId = room.players.find((id) => id !== socket.id);
      if (otherId) io.to(otherId).emit('opponentWantsRematch');
    }
  });

  socket.on('leaveRoom', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => {
    leaveQueue(socket);
    leaveCurrentRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`じゃんけんオンライン対戦サーバー起動: http://localhost:${PORT}`);
});
