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
  const game = makeNewGame(
    matchId,
    [{ socket: entry.socket, user: entry.user, role: "bottom" }],
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
    if (!u) return;

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
      // 최신 프로필 다시 보내기
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
    // 나간 쪽 패배, 남은 쪽 승리
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
  // 플레이어 이동
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

    // 영역 제한
    p.x = Math.max(40, Math.min(760, p.x));
    p.y = Math.max(40, Math.min(560, p.y));

    // 탄약 자동 회복
    const regen = 22;
    p.ammo = Math.min(100, p.ammo + regen * dt);

    // 방어막, 피격 무적 시간 감소
    if (p.shieldActive) {
      p.shieldTimer -= dt;
      if (p.shieldTimer <= 0) {
        p.shieldActive = false;
      }
    }
    if (p.hitInvActive) {
      p.hitInvTimer -= dt;
      if (p.hitInvTimer <= 0) {
        p.hitInvActive = false;
      }
    }

    if (p._shootCooldown > 0) p._shootCooldown -= dt;
  });

  // AI 동작
  if (game.ai) {
    const ai = game.players.find((p) => !p.socket);
    const human = game.players.find((p) => p.socket);
    if (ai && human) {
      const speed = 180;
      const dx = human.x - ai.x;
      if (Math.abs(dx) > 8) {
        ai.moveInput.left = dx < 0;
        ai.moveInput.right = dx > 0;
      } else {
        ai.moveInput.left = ai.moveInput.right = false;
      }

      // 위/아래는 거의 고정
      ai.moveInput.up = false;
      ai.moveInput.down = false;

      if (ai._shootCooldown <= 0 && ai.ammo >= 25) {
        spawnBullet(game, ai);
        ai.ammo -= 25;
        ai._shootCooldown = 0.8 + Math.random() * 0.8;
      }
    }
  }

  // 아이템 스폰
  game.itemSpawnTimer -= dt;
  if (game.itemSpawnTimer <= 0) {
    game.itemSpawnTimer = 4 + Math.random() * 3; // 4~7초
    spawnRandomItem(game);
  }

  // 총알 이동 및 충돌
  const BULLET_SPEED = 420;
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
          // 방어막이 대신 맞음
        } else if (p.hitInvActive) {
          // 무적 중이면 무시
        } else {
          p.hp -= 1;
          p.hitInvActive = true;
          p.hitInvTimer = 1.0; // 1초간 무적

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

    if (!hitSomething) {
      newBullets.push(b);
    }
  });
  game.bullets = newBullets;

  // 폭발 이펙트 나이 증가
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
    // 레이저탄은 좀 더 빠르고 오래
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
      if (waitingPlayer && waitingPlayer.socket.id === socket.id) return; // 이미 대기 중

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

    const allReady =
      game.players.filter((p) => p.socket).every((p) => game.restartStatus[p.socket.id]);

    if (allReady) {
      // 새 상태로 재시작
      const matchId = game.id;
      const playersInfo = game.players.map((p) => ({
        socket: p.socket,
        user: users.get(p.userId),
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
