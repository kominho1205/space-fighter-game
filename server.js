const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

server.listen(PORT, () => {
  console.log("Space Z server running on port", PORT);
});

/* ---------------- 유저 / 프로필 ---------------- */

const users = new Map(); // userId -> { userId, nickname, score, unlockedSkins:number[], preferredSkin:number }

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
  } else if (nickname && nickname !== u.nickname) {
    u.nickname = nickname;
  }
  // 항상 기본 스킨은 열려 있게
  if (!u.unlockedSkins.includes(0)) u.unlockedSkins.push(0);
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

/* ---------------- 매칭 / 게임 상태 ---------------- */

let waitingPlayer = null; // { socket, user, timeout }

const games = new Map(); // matchId -> game
const socketMatch = new Map(); // socket.id -> matchId

function generateMatchId() {
  return "m_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getUserBySocket(socket) {
  const userId = socket._userId;
  if (!userId) return null;
  return users.get(userId);
}

function findGameBySocketId(socketId) {
  const matchId = socketMatch.get(socketId);
  if (!matchId) return null;
  return games.get(matchId) || null;
}

/* ---------------- 게임 생성 ---------------- */

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
    itemSpawnTimer: 0
  };

  players.forEach((p) => {
    const isBottom = p.role === "bottom";
    const baseHp = 3;
    let hp = baseHp;

    const skinId = p.user.preferredSkin ?? 0;
    if (skinId === 1) hp = 4; // 와이드 스킨

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
      scoreSnapshot: p.user.score ?? 0,
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

  // AI용 가짜 유저 (랭킹에는 반영 안 됨: users Map에 안 넣음)
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

/* ---------------- 게임 종료 / 이탈 처리 ---------------- */

function finishGame(game, winnerSocketId) {
  // 점수 반영
  game.players.forEach((p) => {
    const u = users.get(p.userId);
    if (!u) return; // AI는 여기서 스킵

    if (p.socketId === winnerSocketId) {
      u.score += 10;
    } else {
      u.score = Math.max(0, u.score - 5);
    }
  });

  // game_over 이벤트
  game.players.forEach((p) => {
    if (p.socket) {
      p.socket.emit("game_over", { winner: winnerSocketId });
      const u = users.get(p.userId);
      if (u) {
        p.socket.emit("profile", serializeProfile(u));
      }
    }
    if (p.socket) {
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

function leaveCurrentGame(socket, options = {}) {
  const { countAsLose = false } = options;
  const game = findGameBySocketId(socket.id);
  if (!game) return;

  const leaver = game.players.find((p) => p.socketId === socket.id);
  const other = game.players.find((p) => p.socketId !== socket.id);

  if (!leaver) return;

  if (countAsLose && other) {
    finishGame(game, other.socketId);
    if (other.socket) {
      other.socket.emit("opponent_left");
    }
  } else {
    destroyGame(game);
  }
}

/* ---------------- 게임 루프 ---------------- */

const TICK_MS = 50;
setInterval(() => {
  const now = Date.now();
  for (const game of games.values()) {
    const dt = (now - game.lastUpdate) / 1000;
    game.lastUpdate = now;
    updateGame(game, dt);
    broadcastState(game);
  }
}, TICK_MS);

function updateGame(game, dt) {
  // 플레이어 이동/회복/타이머
  game.players.forEach((p) => {
    const baseSpeed = 220;
    let speed = baseSpeed;
    if (p.skinId === 1) speed = 180; // 와이드 느림
    if (p.skinId === 2) speed = 260; // 다트 빠름

    const m = p.moveInput;
    let vx = 0;
    let vy = 0;
    if (m.left) vx -= speed;
    if (m.right) vx += speed;
    if (m.up) vy -= speed;
    if (m.down) vy += speed;

    p.x += vx * dt;
    p.y += vy * dt;

    p.x = Math.max(40, Math.min(760, p.x));
    p.y = Math.max(40, Math.min(560, p.y));

    const regen = 22;
    p.ammo = Math.min(100, p.ammo + regen * dt);

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

  /* ----------------- 개선된 AI ----------------- */
if (game.ai) {
  const ai = game.players.find(p => !p.socket);
  const human = game.players.find(p => p.socket);

  if (ai && human) {

    // -------------------
    // 1) 목표 선택: 플레이어 vs 아이템
    // -------------------
    let targetX = human.x;
    let targetY = human.y;

    // 가까운 아이템 먹기
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
      if (nearest && best < 260) {  // 일정 거리 안의 아이템만 먹으러 감
        targetX = nearest.x;
        targetY = nearest.y;
      }
    }

    // -------------------
    // 2) 상하좌우 이동
    // -------------------
    const dx = targetX - ai.x;
    const dy = targetY - ai.y;

    ai.moveInput.left = dx < -8;
    ai.moveInput.right = dx > 8;
    ai.moveInput.up = dy < -8;
    ai.moveInput.down = dy > 8;

    // -------------------
    // 3) 사격: 수직 정렬 + 랜덤 요소
    // -------------------
    const aligned = Math.abs(dx) < 60;

    if (aligned && ai._shootCooldown <= 0 && ai.ammo >= 25) {
      spawnBullet(game, ai);
      ai.ammo -= 25;
      ai._shootCooldown = 0.5 + Math.random() * 0.8;
    }
  }
}


  // 아이템 스폰
  game.itemSpawnTimer -= dt;
  if (game.itemSpawnTimer <= 0) {
    game.itemSpawnTimer = 4 + Math.random() * 3;
    spawnRandomItem(game);
  }

  // 총알 이동/충돌
  const newBullets = [];
  game.bullets.forEach((b) => {
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0) return;
    if (b.y < -20 || b.y > 620) return;

    let hitSomething = false;
    game.players.forEach((p) => {
      if (p.socketId === b.ownerId) return;

      const dx = p.x - b.x;
      const dy = p.y - b.y;
      const dist = Math.hypot(dx, dy);
      const hitRadius = 24;

      if (dist < hitRadius) {
        hitSomething = true;
        if (p.shieldActive) {
          // 방어막이 맞고 끝
        } else if (p.hitInvActive) {
          // 무적 중이면 무시
        } else {
          p.hp -= 1;
          p.hitInvActive = true;
          p.hitInvTimer = 1.0;

          game.explosions.push({
            x: b.x,
            y: b.y,
            age: 0
          });

          if (p.hp <= 0) {
            finishGame(game, b.ownerId);
          }
        }
      }
    });

    if (!hitSomething) newBullets.push(b);
  });
  game.bullets = newBullets;

  // 폭발 이펙트
  const newExplosions = [];
  game.explosions.forEach((ex) => {
    ex.age += dt;
    if (ex.age < 0.5) newExplosions.push(ex);
  });
  game.explosions = newExplosions;

  // 아이템 획득
  const newItems = [];
  game.items.forEach((item) => {
    let taken = false;
    game.players.forEach((p) => {
      const dx = p.x - item.x;
      const dy = p.y - item.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 26) {
        taken = true;
        if (item.type === "heart") {
          if (p.hp < p.maxHp) p.hp += 1;
        } else if (item.type === "shield") {
          p.shieldActive = true;
          p.shieldTimer = 2.0;
        } else if (item.type === "ammo") {
          p.ammo = 100;
        }
      }
    });
    if (!taken) newItems.push(item);
  });
  game.items = newItems;
}

function spawnRandomItem(game) {
  const x = 80 + Math.random() * 640;
  const y = 120 + Math.random() * 360;
  const r = Math.random();
  let type = "heart";
  if (r < 0.33) type = "heart";
  else if (r < 0.66) type = "shield";
  else type = "ammo";

  game.items.push({
    id: "it_" + Math.random().toString(36).slice(2),
    type,
    x,
    y
  });
}

function spawnBullet(game, shooter) {
  const dir = shooter.role === "bottom" ? -1 : 1;
  const BULLET_SPEED = 420;
  const skinId = shooter.skinId ?? 0;

  let vy = BULLET_SPEED * dir;
  let life = 2.0;

  if (skinId === 3) {
    vy = BULLET_SPEED * 1.1 * dir;
    life = 2.2;
  }

  game.bullets.push({
    x: shooter.x,
    y: shooter.y + dir * -20,
    vy,
    ownerId: shooter.socketId,
    skinId,
    life
  });
}

function broadcastState(game) {
  const state = {
    players: game.players.map((p) => {
      const u = users.get(p.userId);
      return {
        socketId: p.socketId,
        role: p.role,
        x: p.x,
        y: p.y,
        hp: p.hp,
        ammo: p.ammo,
        shieldActive: p.shieldActive,
        hitInvActive: p.hitInvActive,
        skinId: p.skinId,
        score: u ? u.score : p.scoreSnapshot
      };
    }),
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
    explosions: game.explosions.map((ex) => ({
      x: ex.x,
      y: ex.y,
      age: ex.age
    }))
  };

  io.to(game.id).emit("state", state);
}

/* ---------------- 소켓 이벤트 ---------------- */

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket._userId = null;

  socket.on("identify", ({ userId, nickname }) => {
    if (!userId) return;
    const u = getOrCreateUser(userId, nickname);
    socket._userId = userId;
    socket.emit("profile", serializeProfile(u));
  });

  socket.on("set_skin", ({ skinId }) => {
    const u = getUserBySocket(socket);
    if (!u) return;
    if (!u.unlockedSkins.includes(skinId)) return;
    u.preferredSkin = skinId;
    socket.emit("profile", serializeProfile(u));
  });

  socket.on("get_leaderboard", (cb) => {
    const list = Array.from(users.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((u) => ({
        nickname: u.nickname,
        score: u.score
      }));
    cb(list);
  });

  socket.on("find_match", () => {
    leaveCurrentGame(socket); // 이전 게임이 있으면 정리

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

  socket.on("move", (input) => {
    const game = findGameBySocketId(socket.id);
    if (!game) return;
    const player = game.players.find((p) => p.socketId === socket.id);
    if (!player) return;

    player.moveInput = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right
    };
  });

  socket.on("shoot", () => {
    const game = findGameBySocketId(socket.id);
    if (!game) return;
    const player = game.players.find((p) => p.socketId === socket.id);
    if (!player) return;

    if (player._shootCooldown > 0) return;
    if (player.ammo < 25) return;

    player._shootCooldown = 0.15;
    player.ammo -= 25;
    spawnBullet(game, player);
  });

  socket.on("restart_request", () => {
    const game = findGameBySocketId(socket.id);
    if (!game) return;

    if (!game.restartStatus) game.restartStatus = {};
    game.restartStatus[socket.id] = true;

    const statusCopy = { ...game.restartStatus };
    game.players.forEach((p) => {
      if (p.socket) p.socket.emit("restart_status", statusCopy);
    });

    const allReady = game.players
      .filter((p) => p.socket)
      .every((p) => game.restartStatus[p.socket.id]);

    if (allReady) {
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
        if (p.socket) {
          p.socket.emit("restart");
        }
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);

    if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
      clearTimeout(waitingPlayer.timeout);
      waitingPlayer = null;
    }

    leaveCurrentGame(socket, { countAsLose: true });
  });
});
