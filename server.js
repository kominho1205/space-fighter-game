const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static("public"));

/**
 * Matchmaking & room management
 */
let waitingPlayer = null; // socket id of waiting player, if any
const rooms = new Map();  // roomId -> roomState

let roomCounter = 1;

function createRoomId() {
  return "room_" + (roomCounter++);
}

// Game constants
const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;
const PLAYER_SPEED = 260; // pixels per second
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
const PLAYER_RADIUS = 22; // for collision approx

// Room state structure:
// {
//   id,
//   sockets: [socketId1, socketId2],
//   players: {
//       [socketId]: {
//         socketId, role: "bottom"|"top",
//         x,y, width,height, hp, ammo,
//         input: {up,down,left,right},
//         shieldUntil: timestamp or 0
//       }
//   },
//   bullets: [{x,y,vx,vy,owner}],
//   items: [{id,x,y,type}],
//   lastItemSpawnAt: timestamp,
//   loopTimer: NodeJS.Timeout,
//   restartReady: { [socketId]: boolean }
// }

function initRoomState(roomId, socketId1, socketId2) {
  const middleX1 = GAME_WIDTH / 2;
  const bottomY = GAME_HEIGHT - 80;
  const topY = 80;

  const now = Date.now();

  const players = {};
  players[socketId1] = {
    socketId: socketId1,
    role: "bottom",
    x: middleX1,
    y: bottomY,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    hp: MAX_HP,
    ammo: AMMO_MAX,
    input: { up: false, down: false, left: false, right: false },
    shieldUntil: 0
  };

  players[socketId2] = {
    socketId: socketId2,
    role: "top",
    x: middleX1,
    y: topY,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    hp: MAX_HP,
    ammo: AMMO_MAX,
    input: { up: false, down: false, left: false, right: false },
    shieldUntil: 0
  };

  const roomState = {
    id: roomId,
    sockets: [socketId1, socketId2],
    players,
    bullets: [],
    items: [],
    lastItemSpawnAt: now,
    restartReady: {},
    lastUpdateAt: now,
    gameOver: false
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

function stepRoom(roomState) {
  const now = Date.now();
  const dt = (now - roomState.lastUpdateAt) / 1000; // seconds
  roomState.lastUpdateAt = now;

  if (roomState.gameOver) {
    // no updates, just wait for restart / disconnect
    return;
  }

  // Update players movement & ammo regen
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

    // Clamp positions
    const halfW = p.width / 2;
    const halfH = p.height / 2;
    if (p.x < halfW) p.x = halfW;
    if (p.x > GAME_WIDTH - halfW) p.x = GAME_WIDTH - halfW;
    if (p.y < halfH) p.y = halfH;
    if (p.y > GAME_HEIGHT - halfH) p.y = GAME_HEIGHT - halfH;

    // Ammo regen
    p.ammo += AMMO_REGEN_PER_SEC * dt;
    if (p.ammo > AMMO_MAX) p.ammo = AMMO_MAX;
  }

  // Update bullets
  for (const bullet of roomState.bullets) {
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
  }

  // Remove bullets out of bounds
  roomState.bullets = roomState.bullets.filter(b => {
    return b.x >= 0 && b.x <= GAME_WIDTH && b.y >= 0 && b.y <= GAME_HEIGHT;
  });

  // Bullet vs player collisions
  for (const bullet of roomState.bullets) {
    for (const socketId of roomState.sockets) {
      const p = roomState.players[socketId];
      if (!p) continue;
      if (bullet.owner === socketId) continue; // don't hit self
      const dx = bullet.x - p.x;
      const dy = bullet.y - p.y;
      const distSq = dx * dx + dy * dy;
      const r = PLAYER_RADIUS;
      if (distSq <= r * r) {
        // Hit!
        bullet._hit = true;
        if (now < p.shieldUntil) {
          // shield absorbs, no hp loss
        } else {
          p.hp -= 1;
          if (p.hp <= 0) {
            p.hp = 0;
            // game over
            roomState.gameOver = true;
            const winnerId = roomState.sockets.find(id => id !== socketId);
            io.to(roomState.id).emit("game_over", {
              winner: winnerId,
              loser: socketId
            });
          }
        }
      }
    }
  }

  roomState.bullets = roomState.bullets.filter(b => !b._hit);

  // Spawn items
  if (now - roomState.lastItemSpawnAt >= ITEM_SPAWN_INTERVAL_MS && !roomState.gameOver) {
    roomState.lastItemSpawnAt = now;
    // max 2 items at a time
    if (roomState.items.length < 2) {
      const itemId = "item_" + now + "_" + Math.floor(Math.random() * 10000);
      const x = 80 + Math.random() * (GAME_WIDTH - 160);
      const y = 120 + Math.random() * (GAME_HEIGHT - 240);
      const type = Math.random() < 0.5 ? "heart" : "shield";
      roomState.items.push({ id: itemId, x, y, type });
    }
  }

  // Item pickups
  for (const socketId of roomState.sockets) {
    const p = roomState.players[socketId];
    if (!p) continue;
    roomState.items.forEach(item => {
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
        }
      }
    });
  }

  roomState.items = roomState.items.filter(item => !item._takenBy);

  // Broadcast state
  const state = {
    gameWidth: GAME_WIDTH,
    gameHeight: GAME_HEIGHT,
    players: roomState.sockets.map(socketId => {
      const p = roomState.players[socketId];
      if (!p) return null;
      return {
        socketId: p.socketId,
        role: p.role,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        hp: p.hp,
        ammo: p.ammo,
        shieldActive: now < p.shieldUntil
      };
    }).filter(Boolean),
    bullets: roomState.bullets.map(b => ({ x: b.x, y: b.y })),
    items: roomState.items.map(i => ({ id: i.id, x: i.x, y: i.y, type: i.type }))
  };

  io.to(roomState.id).emit("state", state);
}

function handleShoot(socket, roomState) {
  const player = roomState.players[socket.id];
  if (!player) return;
  if (roomState.gameOver) return;

  if (player.ammo < AMMO_COST_PER_SHOT) {
    return;
  }
  player.ammo -= AMMO_COST_PER_SHOT;

  let dirY = -1;
  if (player.role === "bottom") {
    dirY = -1;
  } else {
    dirY = 1;
  }

  const bullet = {
    x: player.x,
    y: player.y + (dirY * -player.height / 2), // start slightly in front
    vx: 0,
    vy: dirY * -BULLET_SPEED // Negative because canvas y+ is down; adjust so that bottom fires up
  };

  // Correct bullet direction: bottom should go up (negative y), top should go down (positive y)
  bullet.vy = player.role === "bottom" ? -BULLET_SPEED : BULLET_SPEED;

  bullet.owner = socket.id;
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
  roomState.lastItemSpawnAt = now;
  roomState.restartReady = {};
  roomState.gameOver = false;
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("find_match", () => {
    if (waitingPlayer && waitingPlayer !== socket.id) {
      // Pair with waiting player
      const otherId = waitingPlayer;
      waitingPlayer = null;

      const roomId = createRoomId();
      socket.join(roomId);
      io.sockets.sockets.get(otherId)?.join(roomId);

      const roomState = initRoomState(roomId, otherId, socket.id);
      console.log(`Room created: ${roomId} with ${otherId} and ${socket.id}`);

      // Notify players
      io.to(otherId).emit("match_found", { roomId, role: "bottom" });
      io.to(socket.id).emit("match_found", { roomId, role: "top" });
    } else {
      waitingPlayer = socket.id;
      socket.emit("waiting", { message: "Waiting for another player..." });
    }
  });

  socket.on("move", (input) => {
    const roomsJoined = Array.from(socket.rooms).filter(r => r.startsWith("room_"));
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
    const roomsJoined = Array.from(socket.rooms).filter(r => r.startsWith("room_"));
    if (roomsJoined.length === 0) return;
    const roomId = roomsJoined[0];
    const roomState = rooms.get(roomId);
    if (!roomState) return;

    handleShoot(socket, roomState);
  });

  socket.on("restart_request", () => {
    const roomsJoined = Array.from(socket.rooms).filter(r => r.startsWith("room_"));
    if (roomsJoined.length === 0) return;
    const roomId = roomsJoined[0];
    const roomState = rooms.get(roomId);
    if (!roomState) return;

    roomState.restartReady[socket.id] = true;
    const otherId = roomState.sockets.find(id => id !== socket.id);

    io.to(roomId).emit("restart_status", {
      [socket.id]: true,
      [otherId]: !!roomState.restartReady[otherId]
    });

    if (otherId && roomState.restartReady[socket.id] && roomState.restartReady[otherId]) {
      resetRoomState(roomState);
      io.to(roomId).emit("restart");
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    if (waitingPlayer === socket.id) {
      waitingPlayer = null;
    }

    // Find room this socket was in
    const joinedRooms = Array.from(socket.rooms).filter(r => r.startsWith("room_"));
    joinedRooms.forEach(roomId => {
      const roomState = rooms.get(roomId);
      if (!roomState) return;

      // Inform opponent
      const otherId = roomState.sockets.find(id => id !== socket.id);
      if (otherId) {
        io.to(otherId).emit("opponent_left");
      }

      // Clean up room
      stopGameLoop(roomState);
      rooms.delete(roomId);
    });
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
