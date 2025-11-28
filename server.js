const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

// ---------------- 프로필 / 랭크 ----------------

const profiles = new Map();
// userId -> { userId, nickname, score, unlockedSkins:Set, preferredSkin }

function getOrCreateProfile(userId) {
  let p = profiles.get(userId);
  if (!p) {
    p = {
      userId,
      nickname: "게스트",
      score: 0,
      unlockedSkins: new Set([0]), // 처음엔 기본 스킨만
      preferredSkin: 0
    };
    profiles.set(userId, p);
  }
  return p;
}

function updateSkinUnlocks(profile) {
  const s = profile.score;
  if (s >= 0) profile.unlockedSkins.add(0);   // 기본
  if (s >= 200) profile.unlockedSkins.add(1); // 와이드
  if (s >= 400) profile.unlockedSkins.add(2); // 다트
  if (s >= 700) profile.unlockedSkins.add(3); // 레이저형 등
}

// ---------------- 게임 상수 ----------------

let waitingPlayer = null;
const rooms = new Map();

let roomCounter = 1;
function createRoomId() {
  return "room_" + roomCounter++;
}

const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;
const PLAYER_SPEED = 260;
const BULLET_SPEED = 420;
const PLAYER_WIDTH = 40;
const PLAYER_HEIGHT = 40;
const MAX_HP = 3;
const AMMO_MAX = 100;
const AMMO_REGEN_PER_SEC = 20;
const AMMO_COST_PER_SHOT = 35;
const SHIELD_DURATION_MS = 2000;
const ITEM_SPAWN_INTERVAL_MS = 7000;
const ITEM_RADIUS = 15;
const PLAYER_RADIUS = 22;
const EXPLOSION_DURATION_MS = 350;

// ---------------- 방 상태 초기화 ----------------

function initRoomState(roomId, socketId1, socketId2) {
  const middleX = GAME_WIDTH / 2;
  const bottomY = GAME_HEIGHT - 80;
  const topY = 80;
  const now = Date.now();

  const players = {};

  const s1 = io.sockets.sockets.get(socketId1);
  const s2 = io.sockets.sockets.get(socketId2);

  const skin1 = s1?.data.profile?.preferredSkin ?? 0;
  const skin2 = s2?.data.profile?.preferredSkin ?? 0;

  players[socketId1] = {
    socketId: socketId1,
    role: "bottom",
    x: middleX,
    y: bottomY,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    hp: MAX_HP,
    ammo: AMMO_MAX,
    input: { up: false, down: false, left: false, right: false },
    shieldUntil: 0,
    skinId: skin1
  };

  players[socketId2] = {
    socketId: socketId2,
    role: "top",
    x: middleX,
    y: topY,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    hp: MAX_HP,
    ammo: AMMO_MAX,
    input: { up: false, down: false, left: false, right: false },
    shieldUntil: 0,
    skinId: skin2
  };

  const roomState = {
    id: roomId,
    sockets: [socketId1, socketId2],
    players,
    bullets: [],
    items: [],
    explosions: [],
    lastItemSpawnAt: now,
    restartReady: {},
    lastUpdateAt: now,
    gameOver: false,
    loopTimer: null
  };

  rooms.set(roomId, roomState);
  startGameLoop(roomState);
  return roomState;
}

function startGameLoop(roomState) {
  const TICK_RATE = 60;
  const tickInterval = 1000 / TICK_RATE;

  roomState.lastUpdateAt = Date.now();
  roomState.loopTimer = setInterval(() => {
    stepRoom(roomState);
  }, tickInterval);
}

function stopGameLoop(roomState) {
  if (roomState.loopTimer) {
    clearInterval(roomState.loopTimer);
    roomState.loopTimer = null;
  }
}

// ---------------- 메인 게임 루프 ----------------

function stepRoom(roomState) {
  const now = Date.now();
  const dt = (now - roomState.lastUpdateAt) / 1000;
  roomState.lastUpdateAt = now;

  if (roomState.gameOver) return;

  // 플레이어 이동 + 탄약 회복
  for (const socketId of roomState.sockets) {
    const p = roomState.players[socketId];
    if (!p) continue;

    let vx = 0;
    let vy = 0;
    if (p.input.left) vx -= 1;
    if (p.input.right) vx += 1;
    if (p.input.up) vy -= 1;
    if (p.input.down) vy += 1;

    const len = Math.sqrt(vx * vx + vy * vy);
    if (len > 0) {
      vx /= len;
      vy /= len;
    }

    p.x += vx * PLAYER_SPEED * dt;
    p.y += vy * PLAYER_SPEED * dt;

    const halfW = p.width / 2;
    const halfH = p.height / 2;
    if (p.x < halfW) p.x = halfW;
    if (p.x > GAME_WIDTH - halfW) p.x = GAME_WIDTH - halfW;
    if (p.y < halfH) p.y = halfH;
    if (p.y > GAME_HEIGHT - halfH) p.y = GAME_HEIGHT - halfH;

    p.ammo += AMMO_REGEN_PER_SEC * dt;
    if (p.ammo > AMMO_MAX) p.ammo = AMMO_MAX;
  }

  // 총알 이동
  for (const bullet of roomState.bullets) {
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
  }

  // 화면 밖 총알 제거
  roomState.bullets = roomState.bullets.filter(
    (b) =>
      b.x >= 0 &&
      b.x <= GAME_WIDTH &&
      b.y >= 0 &&
      b.y <= GAME_HEIGHT
  );

  // 총알 - 플레이어 충돌
  for (const bullet of roomState.bullets) {
    for (const socketId of roomState.sockets) {
      const p = roomState.players[socketId];
      if (!p) continue;
      if (bullet.owner === socketId) continue;

      const dx = bullet.x - p.x;
      const dy = bullet.y - p.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= PLAYER_RADIUS * PLAYER_RADIUS) {
        bullet._hit = true;

        roomState.explosions.push({
          x: bullet.x,
          y: bullet.y,
          createdAt: now
        });

        if (now < p.shieldUntil) {
          // 방어막이 막음
        } else {
          p.hp -= 1;
          if (p.hp <= 0) {
            p.hp = 0;
            roomState.gameOver = true;
            const winnerId = roomState.sockets.find(
              (id) => id !== socketId
            );

            // 승패에 따라 점수 업데이트
            const loserSocket = io.sockets.sockets.get(socketId);
            const winnerSocket = io.sockets.sockets.get(winnerId);

            if (winnerSocket?.data.profile) {
              const pf = winnerSocket.data.profile;
              pf.score += 25;
              updateSkinUnlocks(pf);
              winnerSocket.emit("profile", {
                nickname: pf.nickname,
                score: pf.score,
                unlockedSkins: Array.from(pf.unlockedSkins),
                preferredSkin: pf.preferredSkin
              });
            }
            if (loserSocket?.data.profile) {
              const pf = loserSocket.data.profile;
              pf.score = Math.max(0, pf.score - 15);
              updateSkinUnlocks(pf);
              loserSocket.emit("profile", {
                nickname: pf.nickname,
                score: pf.score,
                unlockedSkins: Array.from(pf.unlockedSkins),
                preferredSkin: pf.preferredSkin
              });
            }

            io.to(roomState.id).emit("game_over", {
              winner: winnerId,
              loser: socketId
            });
          }
        }
      }
    }
  }
  roomState.bullets = roomState.bullets.filter((b) => !b._hit);

  // 아이템 생성
  if (
    now - roomState.lastItemSpawnAt >= ITEM_SPAWN_INTERVAL_MS &&
    !roomState.gameOver
  ) {
    roomState.lastItemSpawnAt = now;
    if (roomState.items.length < 2) {
      const itemId = "item_" + now + "_" + Math.floor(Math.random() * 10000);
      const x = 80 + Math.random() * (GAME_WIDTH - 160);
      const y = 120 + Math.random() * (GAME_HEIGHT - 240);

      const r = Math.random();
      let type;
      if (r < 0.4) type = "heart";
      else if (r < 0.8) type = "shield";
      else type = "ammo";

      roomState.items.push({ id: itemId, x, y, type });
    }
  }

  // 아이템 획득
  for (const socketId of roomState.sockets) {
    const p = roomState.players[socketId];
    if (!p) continue;
    roomState.items.forEach((item) => {
      const dx = item.x - p.x;
      const dy = item.y - p.y;
      const distSq = dx * dx + dy * dy;
      const r = ITEM_RADIUS + PLAYER_RADIUS;
      if (distSq <= r * r && !item._takenBy) {
        item._takenBy = socketId;
        if (item.type === "heart") {
          p.hp += 1;
          if (p.hp > MAX_HP) p.hp = MAX_HP;
        } else if (item.type === "shield") {
          p.shieldUntil = now + SHIELD_DURATION_MS;
        } else if (item.type === "ammo") {
          p.ammo = AMMO_MAX;
        }
      }
    });
  }
  roomState.items = roomState.items.filter((item) => !item._takenBy);

  // 폭발 이펙트 수명 정리
  roomState.explosions = roomState.explosions.filter(
    (ex) => now - ex.createdAt < EXPLOSION_DURATION_MS
  );

  // 상태 전송
  const statePlayers = roomState.sockets
    .map((socketId) => {
      const p = roomState.players[socketId];
      if (!p) return null;
      const s = io.sockets.sockets.get(socketId);
      const prof = s?.data.profile;
      return {
        socketId: p.socketId,
        role: p.role,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        hp: p.hp,
        ammo: p.ammo,
        shieldActive: now < p.shieldUntil,
        skinId: p.skinId ?? 0,
        nickname: prof?.nickname || "플레이어",
        score: prof?.score ?? 0
      };
    })
    .filter(Boolean);

  const stateBullets = roomState.bullets.map((b) => ({
    x: b.x,
    y: b.y,
    skinId: b.skinId ?? 0
  }));

  const state = {
    gameWidth: GAME_WIDTH,
    gameHeight: GAME_HEIGHT,
    players: statePlayers,
    bullets: stateBullets,
    items: roomState.items.map((i) => ({
      id: i.id,
      x: i.x,
      y: i.y,
      type: i.type
    })),
    explosions: roomState.explosions.map((ex) => ({
      x: ex.x,
      y: ex.y,
      age: Math.min(
        (now - ex.createdAt) / EXPLOSION_DURATION_MS,
        1
      )
    }))
  };

  io.to(roomState.id).emit("state", state);
}

// ---------------- 유틸 ----------------

function handleShoot(socket, roomState) {
  const player = roomState.players[socket.id];
  if (!player || roomState.gameOver) return;

  if (player.ammo < AMMO_COST_PER_SHOT) return;
  player.ammo -= AMMO_COST_PER_SHOT;

  const dirY = player.role === "bottom" ? -1 : 1;

  const bullet = {
    x: player.x,
    y: player.y + (dirY * -player.height) / 2,
    vx: 0,
    vy: player.role === "bottom" ? -BULLET_SPEED : BULLET_SPEED,
    owner: socket.id,
    skinId: player.skinId ?? 0
  };

  roomState.bullets.push(bullet);
}

function resetRoomState(roomState) {
  const now = Date.now();
  for (const socketId of roomState.sockets) {
    const p = roomState.players[socketId];
    if (!p) continue;
    p.hp = MAX_HP;
    p.ammo = AMMO_MAX;
    p.shieldUntil = 0;
    p.input = { up: false, down: false, left: false, right: false };
    if (p.role === "bottom") {
      p.x = GAME_WIDTH / 2;
      p.y = GAME_HEIGHT - 80;
    } else {
      p.x = GAME_WIDTH / 2;
      p.y = 80;
    }
  }
  roomState.bullets = [];
  roomState.items = [];
  roomState.explosions = [];
  roomState.lastItemSpawnAt = now;
  roomState.restartReady = {};
  roomState.gameOver = false;
}

// ---------------- 소켓 이벤트 ----------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // 익명 계정 식별
  socket.on("identify", ({ userId, nickname }) => {
    if (!userId || typeof userId !== "string") return;
    const profile = getOrCreateProfile(userId);
    if (nickname && typeof nickname === "string") {
      profile.nickname = nickname.slice(0, 16);
    }
    socket.data.userId = userId;
    socket.data.profile = profile;
    updateSkinUnlocks(profile);

    socket.emit("profile", {
      nickname: profile.nickname,
      score: profile.score,
      unlockedSkins: Array.from(profile.unlockedSkins),
      preferredSkin: profile.preferredSkin
    });
  });

  // 리더보드
  socket.on("get_leaderboard", (cb) => {
    const list = Array.from(profiles.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((p) => ({
        nickname: p.nickname || "게스트",
        score: p.score
      }));
    if (typeof cb === "function") cb(list);
  });

  socket.on("find_match", () => {
    if (waitingPlayer && waitingPlayer !== socket.id) {
      const otherId = waitingPlayer;
      waitingPlayer = null;

      const roomId = createRoomId();
      socket.join(roomId);
      io.sockets.sockets.get(otherId)?.join(roomId);

      initRoomState(roomId, otherId, socket.id);
      console.log(`Room created: ${roomId} with ${otherId} and ${socket.id}`);

      io.to(otherId).emit("match_found", { roomId, role: "bottom" });
      io.to(socket.id).emit("match_found", { roomId, role: "top" });
    } else {
      waitingPlayer = socket.id;
      socket.emit("waiting", {
        message: "Waiting for another player..."
      });
    }
  });

  socket.on("move", (input) => {
    const roomsJoined = Array.from(socket.rooms).filter((r) =>
      r.startsWith("room_")
    );
    if (roomsJoined.length === 0) return;
    const roomId = roomsJoined[0];
    const roomState = rooms.get(roomId);
    if (!roomState) return;

    const player = roomState.players[socket.id];
    if (!player) return;

    player.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right
    };
  });

  socket.on("shoot", () => {
    const roomsJoined = Array.from(socket.rooms).filter((r) =>
      r.startsWith("room_")
    );
    if (roomsJoined.length === 0) return;
    const roomId = roomsJoined[0];
    const roomState = rooms.get(roomId);
    if (!roomState) return;

    handleShoot(socket, roomState);
  });

  // 스킨 설정
  socket.on("set_skin", ({ skinId }) => {
    const profile = socket.data.profile;
    if (!profile) return;
    const id = Number(skinId);
    if (!profile.unlockedSkins.has(id)) return;

    profile.preferredSkin = id;

    socket.emit("profile", {
      nickname: profile.nickname,
      score: profile.score,
      unlockedSkins: Array.from(profile.unlockedSkins),
      preferredSkin: profile.preferredSkin
    });

    const roomsJoined = Array.from(socket.rooms).filter((r) =>
      r.startsWith("room_")
    );
    if (roomsJoined.length === 0) return;
    const roomId = roomsJoined[0];
    const roomState = rooms.get(roomId);
    if (!roomState) return;
    const player = roomState.players[socket.id];
    if (!player) return;
    player.skinId = id;
  });

  socket.on("restart_request", () => {
    const roomsJoined = Array.from(socket.rooms).filter((r) =>
      r.startsWith("room_")
    );
    if (roomsJoined.length === 0) return;
    const roomId = roomsJoined[0];
    const roomState = rooms.get(roomId);
    if (!roomState) return;

    roomState.restartReady[socket.id] = true;
    const otherId = roomState.sockets.find((id) => id !== socket.id);

    io.to(roomId).emit("restart_status", {
      [socket.id]: true,
      [otherId]: !!roomState.restartReady[otherId]
    });

    if (
      otherId &&
      roomState.restartReady[socket.id] &&
      roomState.restartReady[otherId]
    ) {
      resetRoomState(roomState);
      io.to(roomId).emit("restart");
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    if (waitingPlayer === socket.id) {
      waitingPlayer = null;
    }

    const joinedRooms = Array.from(socket.rooms).filter((r) =>
      r.startsWith("room_")
    );
    joinedRooms.forEach((roomId) => {
      const roomState = rooms.get(roomId);
      if (!roomState) return;

      const otherId = roomState.sockets.find((id) => id !== socket.id);
      if (otherId) {
        io.to(otherId).emit("opponent_left");
      }

      stopGameLoop(roomState);
      rooms.delete(roomId);
    });
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
