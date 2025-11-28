const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
server.listen(PORT, () => console.log("Space Z server running:", PORT));

/* --------------------------------------
   유저 데이터
-------------------------------------- */

const users = new Map(); // userId -> profile

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
   매칭 / 게임 상태
-------------------------------------- */

let waitingPlayer = null; // {socket,user,timeout}
const games = new Map(); // matchId -> game
const socketMatch = new Map(); // socket.id -> matchId

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
    players: [],
    bullets: [],
    items: [],
    explosions: [],
    lastUpdate: now,
    itemSpawnTimer: 0,
    restartStatus: {}
  };

  players.forEach((p) => {
    const isBottom = p.role === "bottom";
    let hp = 3;

    const skinId = p.user.preferredSkin ?? 0;
    if (skinId === 1) hp = 4;  // 와이드 스킨

    // AI HP 할인
    if (!p.socket) hp = Math.max(1, hp - 1);

    const obj = {
      socket: p.socket || null,
      socketId: p.socket ? p.socket.id : `ai_${matchId}`,
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
   게임 종료 처리
-------------------------------------- */

function finishGame(game, winnerSocketId) {
  game.players.forEach((p) => {
    const u = users.get(p.userId);
    if (!u) return;

    if (p.socketId === winnerSocketId) {
      u.score += 10;
    } else {
      u.score = Math.max(0, u.score - 5);
    }
  });

  game.players.forEach((p) => {
    if (p.socket) {
      p.socket.emit("game_over", { winner: winnerSocketId });
      const u = users.get(p.userId);
      if (u) p.socket.emit("profile", serializeProfile(u));
      p.socket.leave(game.id);
      socketMatch.delete(p.socket.id);
    }
  });

  games.delete(game.id);
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
   updateGame (AI 난이도 포함)
-------------------------------------- */

function updateGame(game, dt) {
  /* --- 플레이어 이동/상태 --- */
  game.players.forEach((p) => {
    let speed = 220;
    if (p.skinId === 1) speed = 180;
    if (p.skinId === 2) speed = 260;

    if (!p.socket) speed = 160; // AI 약화

    const m = p.moveInput;
    let vx = 0, vy = 0;
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

  /* --- AI 동작 (상하 이동 + 아이템 먹기 + 난이도 낮춤) --- */
  if (game.ai) {
    const ai = game.players.find(p => !p.socket);
    const human = game.players.find(p => p.socket);

    if (ai && human) {
      let targetX = human.x;
      let targetY = human.y;

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
      ai.moveInput.left  = dx < -MOVE_DEAD;
      ai.moveInput.right = dx >  MOVE_DEAD;
      ai.moveInput.up    = dy < -MOVE_DEAD;
      ai.moveInput.down  = dy >  MOVE_DEAD;

      const aligned = Math.abs(dx) < 40;

      if (aligned && ai._shootCooldown <= 0 && ai.ammo >= 25) {
        if (Math.random() < 0.6) { // 60% 확률만 사격
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
          game.explosions.push({ x: b.x, y: b.y, age: 0 });
          if (p.hp <= 0) {
            finishGame(game, b.ownerId);
          }
        }
      }
    });

    if (!hit) newBullets.push(b);
  });
  game.bullets = newBullets;

  /* --- 폭발 --- */
  const ex2 = [];
  game.explosions.forEach((e) => {
    e.age += dt;
    if (e.age < 0.5) ex2.push(e);
  });
  game.explosions = ex2;

  /* --- 아이템 먹기 --- */
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

  socket.on("identify", ({ userId, nickname }) => {
    const u = getOrCreateUser(userId, nickname);
    socket._userId = userId;
    socket.emit("profile", serializeProfile(u));
  });

  socket.on("get_leaderboard", (cb) => {
    const list = [...users.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((u) => ({ nickname: u.nickname, score: u.score }));
    cb(list);
  });

  socket.on("set_skin", ({ skinId }) => {
    const u = getUserBySocket(socket);
    if (!u) return;
    if (!u.unlockedSkins.includes(skinId)) return;
    u.preferredSkin = skinId;
    socket.emit("profile", serializeProfile(u));
  });

  socket.on("find_match", () => {
    leaveCurrentGame(socket);

    const user = getUserBySocket(socket);
    if (!user) return;

    if (waitingPlayer && waitingPlayer.socket.id !== socket.id) {
      clearTimeout(waitingPlayer.timeout);
      const p1 = waitingPlayer;
      const p2 = { socket, user };
      createHumanMatch(p1, p2);
      waitingPlayer = null;
    } else {
      if (waitingPlayer && waitingPlayer.socket.id === socket.id) return;

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

  socket.on("leave_match", () => {
    leaveCurrentGame(socket, { countAsLose: true });
  });

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

  socket.on("shoot", () => {
    const game = findGameBySocketId(socket.id);
    if (!game) return;
    const p = game.players.find((p) => p.socketId === socket.id);
    if (!p) return;
    if (p._shootCooldown > 0 || p.ammo < 25) return;

    p._shootCooldown = 0.15;
    p.ammo -= 25;
    spawnBullet(game, p);
  });

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
    }
  });

  socket.on("disconnect", () => {
    if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
      clearTimeout(waitingPlayer.timeout);
      waitingPlayer = null;
    }
    leaveCurrentGame(socket, { countAsLose: true });
  });
});
