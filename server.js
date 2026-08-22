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

// 「この時間だけ人間の相手を待って、見つからなければAI対戦に切り替える」ためのタイマー
const aiFallbackTimers = new Map(); // socketId -> timeout handle

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0/O, 1/I)は除外
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
const HANDS_LIST = ['rock', 'scissors', 'paper'];
const WIN_SCORE = 5; // 先取本数
const AI_KEY = '__AI__'; // AI用のスコア管理キー（socketIdと衝突しない特殊キー）
const AI_MATCH_WAIT_MS = 6000; // この時間、人間の相手が見つからなければAI対戦にする

function randomAIHand() {
  return HANDS_LIST[Math.floor(Math.random() * HANDS_LIST.length)];
}

function clearAiFallbackTimer(socketId) {
  const timer = aiFallbackTimers.get(socketId);
  if (timer) {
    clearTimeout(timer);
    aiFallbackTimers.delete(socketId);
  }
}

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
  clearAiFallbackTimer(socket.id);
}

function startAIMatch(io, socket) {
  const code = generateRoomCode();
  rooms.set(code, {
    players: [socket.id],
    choices: {},
    scores: { [socket.id]: 0, [AI_KEY]: 0 },
    matchOver: false,
    rematchRequests: new Set(),
    vsAI: true,
  });
  socket.join(code);
  socket.data.room = code;
  socket.emit('opponentJoined', { vsAI: true });
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
  // 合言葉なしのランダムマッチング（見つからない場合は一定時間後にAI対戦へ）
  socket.on('findRandomMatch', () => {
    leaveCurrentRoom(socket);
    leaveQueue(socket);

    // 待機中に切断済みの相手が残っていないか掃除する
    waitingQueue = waitingQueue.filter((id) => io.sockets.sockets.has(id));

    const opponentId = waitingQueue.shift();
    const opponentSocket = opponentId ? io.sockets.sockets.get(opponentId) : null;

    if (opponentSocket) {
      clearAiFallbackTimer(opponentId); // 相手はもうAI待機タイマーが不要になった
      const code = generateRoomCode();
      rooms.set(code, {
        players: [opponentId, socket.id],
        choices: {},
        scores: { [opponentId]: 0, [socket.id]: 0 },
        matchOver: false,
        rematchRequests: new Set(),
        vsAI: false,
      });
      opponentSocket.join(code);
      opponentSocket.data.room = code;
      socket.join(code);
      socket.data.room = code;

      io.to(code).emit('opponentJoined', { vsAI: false });
    } else {
      waitingQueue.push(socket.id);
      socket.emit('waitingForMatch');

      const timer = setTimeout(() => {
        aiFallbackTimers.delete(socket.id);
        // タイムアウトまでに人間の相手が見つからなければAI対戦を開始する
        if (waitingQueue.includes(socket.id)) {
          waitingQueue = waitingQueue.filter((id) => id !== socket.id);
          startAIMatch(io, socket);
        }
      }, AI_MATCH_WAIT_MS);
      aiFallbackTimers.set(socket.id, timer);
    }
  });

  socket.on('cancelMatch', () => leaveQueue(socket));

  socket.on('chooseHand', (hand) => {
    if (!['rock', 'scissors', 'paper'].includes(hand)) return;

    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room || room.matchOver) return;

    // --- AI対戦の場合 ---
    if (room.vsAI) {
      const you = socket.id;
      const aiHand = randomAIHand();
      const result = judge(hand, aiHand); // 'p1' = you, 'p2' = AI

      if (result === 'p1') room.scores[you]++;
      else if (result === 'p2') room.scores[AI_KEY]++;

      const matchOver = room.scores[you] >= WIN_SCORE || room.scores[AI_KEY] >= WIN_SCORE;
      if (matchOver) room.matchOver = true;

      // 少し間を置いてから結果を返す（考えているような演出のため）
      setTimeout(() => {
        socket.emit('roundResult', {
          yourHand: hand,
          opponentHand: aiHand,
          outcome: result === 'draw' ? 'draw' : result === 'p1' ? 'win' : 'lose',
          yourScore: room.scores[you],
          opponentScore: room.scores[AI_KEY],
          matchOver,
          youWonMatch: matchOver ? room.scores[you] >= WIN_SCORE : null,
        });
      }, 500 + Math.floor(Math.random() * 400));
      return;
    }

    // --- 人間同士の対戦の場合 ---
    if (room.players.length < 2) return;

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
    if (!room) return;

    if (room.vsAI) {
      room.scores = { [socket.id]: 0, [AI_KEY]: 0 };
      room.choices = {};
      room.matchOver = false;
      socket.emit('rematchStart');
      return;
    }

    if (room.players.length < 2) return;

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
