// server.js
const path = require("path");
const express = require("express");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
server.listen(PORT, () => console.log("Space Z server running:", PORT));

/* --------------------------------------
   파일 기반 유저 데이터 저장/로드
-------------------------------------- */

const DATA_FILE = "./users.json";

/** users: Map<userId, profile> */
let users = new Map();

function loadUsersFromFile() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      users = new Map(raw); // 배열 → 맵 복원
      console.log("[LOAD] users.json 로드 완료. 유저 수:", users.size);
    } else {
      console.log("[LOAD] users.json 없음. 새 파일 생성 예정");
    }
  } catch (err) {
    console.error("[ERROR] users.json 로드 실패:", err);
  }
}

function saveUsersToFile() {
  try {
    const arr = [...users.entries()];
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr));
    //console.log("[SAVE] users.json 저장됨");
  } catch (err) {
    console.error("[ERROR] users.json 저장 실패:", err);
  }
}

// 서버 시작 시 로드
loadUsersFromFile();

/* --------------------------------------
   유저 관리
-------------------------------------- */

function getOrCreateUser(userId, nickname) {
  let u = users.get(userId);
  if (!u) {
    u = {
      userId,
      nickname: nickname || "Guest",
      score: 0,
      unlockedSkins: [0],
      preferredSkin: 0
    };
    users.set(userId, u);
    saveUsersToFile(); // 신규 생성 시 저장
  } else {
    if (nickname) u.nickname = nickname;
    if (!u.unlockedSkins.includes(0)) u.unlockedSkins.push(0);
  }
  return u;
}

function serializeProfile(u) {
  return {
    userId: u.userId,
    nickname: u.nickname,
    score: u.score,
    unlockedSkins: u.unlockedSkins,
    preferredSkin: u.preferredSkin
  };
}

/* --------------------------------------
   매칭/게임 상태
-------------------------------------- */

let waitingPlayer = null;
const games = new Map();
const socketMatch = new Map();

function generateMatchId() {
  return "m_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getUserBySocket(socket) {
  return users.get(socket._userId);
}

function findGameBySocketId(socketId) {
  const matchId = socketMatch.get(socketId);
  if (!matchId) return null;
  return games.get(matchId) || null;
}

/* --------------------------------------
   게임 생성
-------------------------------------- */

function makeNewGame(matchId, players, options) {
  const now = Date.now();

  const game = {
    id: matchId,
    ai: !!options.ai,

    // 3초 카운트다운
    countdown: 3,

    players: [],
    bullets: [],
    items: [],
    explosions: [],

    lastUpdate: now,
    itemSpawnTimer: 0,
    restartStatus: {},

    // 파괴 연출 후 딜레이 종료
    ended: false,
    winnerSocketId: null,
    endTimer: 0,

    // 점수/게임오버 중복 방지 플래그
    _scoresSettled: false,
    _gameOverSent: false
  };

  players.forEach((p) => {
    const isBottom = p.role === "bottom";
    let hp = 3;
    const skinId = p.user.preferredSkin ?? 0;
    if (skinId === 1) hp = 4;

    const obj = {
      socket: p.socket || null,
      socketId: p.socket ? p.socket.id : "ai_" + matchId,
      userId: p.user.userId,
      nickname: p.user.nickname,
      role: p.role,
      skinId,

      x: 400,
      y: isBottom ? 520 : 80,
      vx: 0,
      vy: 0,

      hp,
      maxHp: hp,
      ammo: 100,

      shieldActive: false,
      shieldTimer: 0,

      hitInvActive: false,
      hitInvTimer: 0,

      moveInput: { up: false, down: false, left: false, right: false },

      scoreSnapshot: p.user.score,

      _shootCooldown: 0
    };

    game.players.push(obj);

    if (p.socket) {
      p.socket.join(matchId);
      socketMatch.set(p.socket.id, matchId);
    }
  });

  return game;
}

function createHumanMatch(p1, p2) {
  const matchId = generateMatchId();
  const game = makeNewGame(
    matchId,
    [
      { socket: p1.socket, user: p1.user, role: "bottom" },
      { socket: p2.socket, user: p2.user, role: "top" }
    ],
    { ai: false }
  );
  games.set(matchId, game);

  p1.socket.emit("match_found", { role: "bottom" });
  p2.socket.emit("match_found", { role: "top" });
}

function createAIMatch(entry) {
  const matchId = generateMatchId();

  const aiUser = {
    userId: "ai_" + matchId,
    nickname: "AI",
    score: 0,
    unlockedSkins: [0],
    preferredSkin: 0
  };

  const game = makeNewGame(
    matchId,
    [
      { socket: entry.socket, user: entry.user, role: "bottom" },
      { socket: null, user: aiUser, role: "top" }
    ],
    { ai: true }
  );

  games.set(matchId, game);
  entry.socket.emit("match_found", { role: "bottom", vsAI: true });
}

/* --------------------------------------
   점수 정산/게임오버/정리 헬퍼
-------------------------------------- */

function settleScores(game, winnerSocketId) {
  if (game._scoresSettled) return;
  game._scoresSettled = true;

  game.players.forEach((p) => {
    const u = users.get(p.userId);
    if (!u) return;

    if (p.socketId === winnerSocketId) {
      u.score += 25;
    } else {
      u.score = Math.max(0, u.score - 20);
    }
  });

  saveUsersToFile();
}

function sendGameOver(game, winnerSocketId) {
  if (game._gameOverSent) return;
  game._gameOverSent = true;

  game.players.forEach((p) => {
    if (p.socket) {
      p.socket.emit("game_over", {
        winner: winnerSocketId,
        vsAI: game.ai
      });

      const u = users.get(p.userId);
      if (u) p.socket.emit("profile", serializeProfile(u));
    }
  });
}

function destroyGame(game) {
  game.players.forEach((p) => {
    if (p.socket) {
      p.socket.leave(game.id);
      socketMatch.delete(p.socket.id);
    }
  });
  games.delete(game.id);
}

/* --------------------------------------
   게임 종료 처리 (강제 종료용)
-------------------------------------- */

function finishGame(game, winnerSocketId) {
  settleScores(game, winnerSocketId);
  sendGameOver(game, winnerSocketId);
  destroyGame(game);
}

function leaveCurrentGame(socket, opt = {}) {
  const { countAsLose = false } = opt;
  const game = findGameBySocketId(socket.id);
  if (!game) return;

  const leaver = game.players.find((p) => p.socketId === socket.id);
  const other = game.players.find((p) => p.socketId !== socket.id);

  if (countAsLose && other) {
    finishGame(game, other.socketId);
    if (other.socket) other.socket.emit("opponent_left");
  } else {
    destroyGame(game);
  }
}

/* --------------------------------------
   게임 루프
-------------------------------------- */

const TICK = 50;
setInterval(() => {
  const now = Date.now();
  for (const game of games.values()) {
    const dt = (now - game.lastUpdate) / 1000;
    game.lastUpdate = now;
    updateGame(game, dt);
    broadcastState(game);
  }
}, TICK);

/* --------------------------------------
   updateGame (AI 포함 + 파괴 딜레이)
-------------------------------------- */

function updateGame(game, dt) {
  // 파괴 후 연출 단계
  if (game.ended) {
    const ex2 = [];
    game.explosions.forEach((e) => {
      e.age += dt;
      if (e.age < 0.6) ex2.push(e);
    });
    game.explosions = ex2;

    game.endTimer -= dt;
    // 폭발 끝날 때 점수/게임오버만 보내고, 게임은 유지 (재대전용)
    if (game.endTimer <= 0 && game.winnerSocketId && !game._gameOverSent) {
      settleScores(game, game.winnerSocketId);
      sendGameOver(game, game.winnerSocketId);
    }
    return;
  }

  // 카운트다운 중이면 이동/공격 금지
  if (game.countdown > 0) {
    game.countdown -= dt;
    if (game.countdown < 0) game.countdown = 0;
    return;
  }

  /* --- 플레이어 이동/상태 업데이트 --- */

  game.players.forEach((p) => {
    let speed = 220;
    if (p.skinId === 1) speed = 180;
    if (p.skinId === 2) speed = 260;

    // AI 약화
    if (!p.socket) speed = 160;

    const m = p.moveInput;
    let vx = 0,
      vy = 0;
    if (m.left) vx -= speed;
    if (m.right) vx += speed;
    if (m.up) vy -= speed;
    if (m.down) vy += speed;

    p.x += vx * dt;
    p.y += vy * dt;

    p.x = Math.max(40, Math.min(760, p.x));
    p.y = Math.max(40, Math.min(560, p.y));

    p.ammo = Math.min(100, p.ammo + 22 * dt);

    if (p.shieldActive) {
      p.shieldTimer -= dt;
      if (p.shieldTimer <= 0) p.shieldActive = false;
    }
    if (p.hitInvActive) {
      p.hitInvTimer -= dt;
      if (p.hitInvTimer <= 0) p.hitInvActive = false;
    }
    if (p._shootCooldown > 0) p._shootCooldown -= dt;
  });

  /* --- AI 동작 --- */

  if (game.ai) {
    const ai = game.players.find((p) => !p.socket);
    const human = game.players.find((p) => p.socket);

    if (ai && human) {
      let targetX = human.x;
      let targetY = human.y;

      // 아이템 먹기 우선
      if (game.items.length > 0) {
        let nearest = null;
        let best = 99999;
        for (const it of game.items) {
          const d = Math.hypot(ai.x - it.x, ai.y - it.y);
          if (d < best) {
            best = d;
            nearest = it;
          }
        }
        if (nearest && best < 180 && Math.random() < 0.5) {
          targetX = nearest.x;
          targetY = nearest.y;
        }
      }

      const dx = targetX - ai.x;
      const dy = targetY - ai.y;
      const MOVE_DEAD = 25;

      ai.moveInput.left = dx < -MOVE_DEAD;
      ai.moveInput.right = dx > MOVE_DEAD;
      ai.moveInput.up = dy < -MOVE_DEAD;
      ai.moveInput.down = dy > MOVE_DEAD;

      const aligned = Math.abs(dx) < 40;

      if (aligned && ai._shootCooldown <= 0 && ai.ammo >= 25) {
        if (Math.random() < 0.6) {
          spawnBullet(game, ai);
          ai.ammo -= 25;
        }
        ai._shootCooldown = 1.2 + Math.random() * 0.8;
      }
    }
  }

  /* --- 아이템 스폰 --- */

  game.itemSpawnTimer -= dt;
  if (game.itemSpawnTimer <= 0) {
    game.itemSpawnTimer = 4 + Math.random() * 3;
    spawnRandomItem(game);
  }

  /* --- 총알 이동/충돌 --- */

  const newBullets = [];
  game.bullets.forEach((b) => {
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0) return;

    let hit = false;

    game.players.forEach((p) => {
      if (p.socketId === b.ownerId) return;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (Math.hypot(dx, dy) < 24) {
        hit = true;

        if (!p.shieldActive && !p.hitInvActive) {
          p.hp -= 1;
          p.hitInvActive = true;
          p.hitInvTimer = 1.0;

          // 피격 폭발
          game.explosions.push({ x: b.x, y: b.y, age: 0 });

          if (p.hp <= 0 && !game.ended) {
            // 전투기 파괴 위치 폭발
            game.explosions.push({ x: p.x, y: p.y, age: 0 });

            // 파괴 후 딜레이
            game.ended = true;
            game.winnerSocketId = b.ownerId;
            game.endTimer = 0.7;
          }
        }
      }
    });

    if (!hit) newBullets.push(b);
  });
  game.bullets = newBullets;

  /* --- 폭발 업데이트(일반 폭발) --- */
  const ex2 = [];
  game.explosions.forEach((e) => {
    e.age += dt;
    if (e.age < 0.5) ex2.push(e);
  });
  game.explosions = ex2;

  /* --- 아이템 획득 --- */

  const items2 = [];
  game.items.forEach((it) => {
    let taken = false;

    game.players.forEach((p) => {
      const dx = p.x - it.x;
      const dy = p.y - it.y;
      if (Math.hypot(dx, dy) < 26) {
        taken = true;
        if (it.type === "heart") {
          if (p.hp < p.maxHp) p.hp++;
        } else if (it.type === "shield") {
          p.shieldActive = true;
          p.shieldTimer = 2.0;
        } else if (it.type === "ammo") {
          p.ammo = 100;
        }
      }
    });

    if (!taken) items2.push(it);
  });

  game.items = items2;
}

/* --------------------------------------
   아이템/총알 생성
-------------------------------------- */

function spawnRandomItem(game) {
  const x = 80 + Math.random() * 640;
  const y = 120 + Math.random() * 360;
  const r = Math.random();
  const type = r < 0.33 ? "heart" : r < 0.66 ? "shield" : "ammo";

  game.items.push({
    id: "it_" + Math.random().toString(36).slice(2),
    type,
    x,
    y
  });
}

function spawnBullet(game, shooter) {
  const dir = shooter.role === "bottom" ? -1 : 1;
  const BASE = 420;

  let vy = BASE * dir;
  let life = 2.0;

  if (shooter.skinId === 3) {
    vy = BASE * 1.1 * dir;
    life = 2.2;
  }

  game.bullets.push({
    x: shooter.x,
    y: shooter.y + dir * -20,
    vy,
    ownerId: shooter.socketId,
    skinId: shooter.skinId,
    life
  });
}

/* --------------------------------------
   상태 전송
-------------------------------------- */

function broadcastState(game) {
  const state = {
    countdown: game.countdown,
    players: game.players.map((p) => ({
      socketId: p.socketId,
      role: p.role,
      x: p.x,
      y: p.y,
      hp: p.hp,
      ammo: p.ammo,
      shieldActive: p.shieldActive,
      hitInvActive: p.hitInvActive,
      skinId: p.skinId,
      score: users.get(p.userId)?.score ?? p.scoreSnapshot
    })),
    bullets: game.bullets.map((b) => ({
      x: b.x,
      y: b.y,
      skinId: b.skinId
    })),
    items: game.items.map((it) => ({
      type: it.type,
      x: it.x,
      y: it.y
    })),
    explosions: game.explosions.map((e) => ({
      x: e.x,
      y: e.y,
      age: e.age
    }))
  };

  io.to(game.id).emit("state", state);
}

/* --------------------------------------
   소켓 이벤트
-------------------------------------- */

io.on("connection", (socket) => {
  socket._userId = null;

  // 클라이언트 identify (userId + nickname)
  socket.on("identify", ({ userId, nickname }) => {
    const u = getOrCreateUser(userId, nickname);
    socket._userId = userId;
    socket.emit("profile", serializeProfile(u));
  });

  // 랭킹
  socket.on("get_leaderboard", (cb) => {
    const list = [...users.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((u) => ({ nickname: u.nickname, score: u.score }));
    cb(list);
  });

  // 스킨 선택
  socket.on("set_skin", ({ skinId }) => {
    const u = getUserBySocket(socket);
    if (!u) return;
    if (!u.unlockedSkins.includes(skinId)) return;
    u.preferredSkin = skinId;
    saveUsersToFile();
    socket.emit("profile", serializeProfile(u));
  });

  // 매칭 찾기
  socket.on("find_match", () => {
    // 기존 게임 있으면 정리
    leaveCurrentGame(socket);

    const user = getUserBySocket(socket);
    if (!user) return;

    // 이미 누가 대기 중이면 붙여서 매칭
    if (waitingPlayer && waitingPlayer.socket.id !== socket.id) {
      clearTimeout(waitingPlayer.timeout);
      const p1 = waitingPlayer;
      const p2 = { socket, user };
      createHumanMatch(p1, p2);
      waitingPlayer = null;
    } else {
      // 본인이 이미 대기 중이면 무시
      if (waitingPlayer && waitingPlayer.socket.id === socket.id) return;

      // 새 대기자 등록 + 15초 후 AI 매칭
      waitingPlayer = {
        socket,
        user,
        timeout: setTimeout(() => {
          if (!waitingPlayer || waitingPlayer.socket.id !== socket.id) return;
          createAIMatch(waitingPlayer);
          waitingPlayer = null;
        }, 15000)
      };
      socket.emit("waiting");
    }
  });

  // 홈으로/포기 등으로 매치 떠날 때
  socket.on("leave_match", () => {
    // 매칭 대기열에 있던 상태면 AI 15초 타이머 제거
    if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
      clearTimeout(waitingPlayer.timeout);
      waitingPlayer = null;
    }
    // 이미 게임 중이었다면 패배 처리
    leaveCurrentGame(socket, { countAsLose: true });
  });

  // 이동 입력
  socket.on("move", (m) => {
    const game = findGameBySocketId(socket.id);
    if (!game) return;
    const p = game.players.find((p) => p.socketId === socket.id);
    if (!p) return;

    p.moveInput = {
      up: !!m.up,
      down: !!m.down,
      left: !!m.left,
      right: !!m.right
    };
  });

  // 발사 입력
  socket.on("shoot", () => {
    const game = findGameBySocketId(socket.id);
    if (!game) return;

    // 카운트다운 동안은 공격 불가
    if (game.countdown > 0) return;

    const p = game.players.find((p) => p.socketId === socket.id);
    if (!p) return;
    if (p._shootCooldown > 0 || p.ammo < 25) return;

    p._shootCooldown = 0.15;
    p.ammo -= 25;
    spawnBullet(game, p);
  });

  // 다시 시작 요청
  socket.on("restart_request", () => {
    const game = findGameBySocketId(socket.id);
    if (!game) return;

    game.restartStatus[socket.id] = true;

    const readyAll = game.players
      .filter((p) => p.socket)
      .every((p) => game.restartStatus[p.socket.id]);

    if (readyAll) {
      const matchId = game.id;

      const playersInfo = game.players.map((p) => ({
        socket: p.socket,
        user: users.get(p.userId) || {
          userId: p.userId,
          nickname: p.nickname,
          score: p.scoreSnapshot,
          unlockedSkins: [p.skinId],
          preferredSkin: p.skinId
        },
        role: p.role
      }));

      destroyGame(game);
      const newGame = makeNewGame(matchId, playersInfo, { ai: game.ai });
      games.set(matchId, newGame);

      newGame.players.forEach((p) => {
        if (p.socket) p.socket.emit("restart");
      });
    } else {
      // 각 소켓별 준비 상태 전송
      const status = {};
      game.players.forEach((p) => {
        if (p.socket) status[p.socket.id] = !!game.restartStatus[p.socket.id];
      });
      game.players.forEach((p) => {
        if (p.socket) p.socket.emit("restart_status", status);
      });
    }
  });

  // 연결 종료
  socket.on("disconnect", () => {
    // 대기 중이던 사람이면 AI 타이머 제거
    if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
      clearTimeout(waitingPlayer.timeout);
      waitingPlayer = null;
    }
    // 게임 중이면 패배 처리
    leaveCurrentGame(socket, { countAsLose: true });
  });
});
