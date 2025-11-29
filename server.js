// server.js (수정됨)
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ---------- PostgreSQL 연결 ----------

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
});

// 메모리 캐시 (동일 구조 유지)
let users = new Map();

async function loadUserFromDB(userId) {
    const res = await pool.query(
        "SELECT user_id, nickname, score, unlocked_skins, preferred_skin FROM users WHERE user_id = $1",
        [userId]
    );
    if (res.rowCount === 0) return null;

    const row = res.rows[0];
    return {
        userId: row.user_id,
        nickname: row.nickname,
        score: row.score,
        unlockedSkins: (row.unlocked_skins || []).map((v) => Number(v)),
        preferredSkin: row.preferred_skin
    };
}

async function checkNicknameAvailability(nickname) {
    const res = await pool.query(
        "SELECT user_id FROM users WHERE nickname = $1",
        [nickname]
    );
    return res.rowCount === 0; // 사용 가능하면 true
}

async function saveUserToDB(u) {
    await pool.query(
        `INSERT INTO users (user_id, nickname, score, unlocked_skins, preferred_skin)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id)
       DO UPDATE SET nickname = EXCLUDED.nickname,
                       score = EXCLUDED.score,
                       unlocked_skins = EXCLUDED.unlocked_skins,
                       preferred_skin = EXCLUDED.preferred_skin`,
        [u.userId, u.nickname, u.score, u.unlockedSkins, u.preferredSkin]
    );
}

// 닉네임 중복 검사를 외부에서 처리한다는 가정하에 사용자를 생성/업데이트만 수행
async function getOrCreateUser(userId, nickname) {
    // DB에서 찾기
    let u = await loadUserFromDB(userId);
    let isNew = false;
    
    if (!u) {
        // 신규 사용자 생성
        u = {
            userId,
            nickname: nickname || "Guest",
            score: 0,
            unlockedSkins: [0],
            preferredSkin: 0
        };
        isNew = true;
    } else {
        // 기존 사용자 업데이트 (닉네임 변경 요청에 대한 처리)
        if (nickname && u.nickname !== nickname) {
            u.nickname = nickname;
        }
    }
    
    // 기본 스킨 체크 (ID 0)
    if (!u.unlockedSkins.includes(0)) {
        u.unlockedSkins.push(0);
    }

    // DB에 저장
    if (isNew || nickname) {
        await saveUserToDB(u);
    }
    
    users.set(userId, u);
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

function getUserBySocket(socket) {
    if (!socket._userId) return null;
    return users.get(socket._userId) || null;
}

// ---------- 서버/정적 파일 ----------

app.use(express.static(path.join(__dirname, "public")));
server.listen(PORT, () => console.log("Space Z server running:", PORT));

/* --------------------------------------
    매칭/게임 상태
-------------------------------------- */

let waitingPlayer = null;
const games = new Map();
const socketMatch = new Map();

function generateMatchId() {
    return "m_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
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

        countdown: 3,

        players: [],
        bullets: [],
        items: [],
        explosions: [],

        lastUpdate: now,
        itemSpawnTimer: 0,
        restartStatus: {},

        ended: false,
        winnerSocketId: null,
        endTimer: 0,

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

        // DB에 비동기 업데이트 (기다리지 않고 fire-and-forget)
        saveUserToDB(u).catch((err) =>
            console.error("[ERROR] saveUserToDB in settleScores:", err)
        );
    });
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
    if (game.ended) {
        const ex2 = [];
        game.explosions.forEach((e) => {
            e.age += dt;
            if (e.age < 0.6) ex2.push(e);
        });
        game.explosions = ex2;

        game.endTimer -= dt;
        if (game.endTimer <= 0 && game.winnerSocketId && !game._gameOverSent) {
            settleScores(game, game.winnerSocketId);
            sendGameOver(game, game.winnerSocketId);
        }
        return;
    }

    if (game.countdown > 0) {
        game.countdown -= dt;
        if (game.countdown < 0) game.countdown = 0;
        return;
    }

    game.players.forEach((p) => {
        let speed = 220;
        if (p.skinId === 1) speed = 180;
        if (p.skinId === 2) speed = 260;

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

    if (game.ai) {
        const ai = game.players.find((p) => !p.socket);
        const human = game.players.find((p) => p.socket);

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

    game.itemSpawnTimer -= dt;
    if (game.itemSpawnTimer <= 0) {
        game.itemSpawnTimer = 4 + Math.random() * 3;
        spawnRandomItem(game);
    }

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

                    if (p.hp <= 0 && !game.ended) {
                        game.explosions.push({ x: p.x, y: p.y, age: 0 });

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

    const ex2 = [];
    game.explosions.forEach((e) => {
        e.age += dt;
        if (e.age < 0.5) ex2.push(e);
    });
    game.explosions = ex2;

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
            nickname: p.nickname,
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

    // 닉네임 중복 검사 및 로그인/계정 생성 (콜백 응답 추가)
    socket.on("identify", async ({ userId, nickname }, cb) => {
        if (!cb || typeof cb !== 'function') return;

        try {
            const existingUser = await loadUserFromDB(userId);
            
            if (existingUser) {
                // A. 기존 사용자: 닉네임 변경 요청인지 확인
                if (existingUser.nickname !== nickname) {
                    const isAvailable = await checkNicknameAvailability(nickname);
                    if (!isAvailable) {
                        return cb({ success: false, reason: "NICKNAME_TAKEN" });
                    }
                }
                
                const u = await getOrCreateUser(userId, nickname); // 닉네임 업데이트
                
                socket._userId = userId;
                socket.emit("profile", serializeProfile(u));
                return cb({ success: true, user: serializeProfile(u) });

            } else {
                // B. 신규 사용자: 닉네임 중복 확인
                const isAvailable = await checkNicknameAvailability(nickname);
                if (!isAvailable) {
                    return cb({ success: false, reason: "NICKNAME_TAKEN" });
                }
                
                // 신규 계정 생성
                const newUser = await getOrCreateUser(userId, nickname);
                
                socket._userId = userId;
                socket.emit("profile", serializeProfile(newUser));
                return cb({ success: true, user: serializeProfile(newUser) });
            }
        } catch (err) {
            console.error("[ERROR] identify:", err);
            cb({ success: false, reason: "SERVER_ERROR" });
        }
    });

    socket.on("get_leaderboard", async (cb) => {
        try {
            const res = await pool.query(
                "SELECT nickname, score FROM users ORDER BY score DESC LIMIT 50"
            );
            const list = res.rows.map((r) => ({
                nickname: r.nickname,
                score: r.score
            }));
            cb(list);
        } catch (err) {
            console.error("[ERROR] get_leaderboard:", err);
            cb([]);
        }
    });

    socket.on("set_skin", async ({ skinId }) => {
        const u = getUserBySocket(socket);
        if (!u) return;
        if (!u.unlockedSkins.includes(skinId)) return;
        u.preferredSkin = skinId;
        try {
            await saveUserToDB(u);
            socket.emit("profile", serializeProfile(u));
        } catch (err) {
            console.error("[ERROR] set_skin:", err);
        }
    });

    socket.on("find_match", async () => {
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
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
            clearTimeout(waitingPlayer.timeout);
            waitingPlayer = null;
        }
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

        if (game.countdown > 0) return;

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
                user:
                    users.get(p.userId) || {
                        userId: p.userId,
                        nickname: p.nickname,
                        score: p.scoreSnapshot,
                        unlockedSkins: [p.skinId],
                        preferredSkin: p.preferredSkin
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
            const status = {};
            game.players.forEach((p) => {
                if (p.socket) status[p.socket.id] = !!game.restartStatus[p.socket.id];
            });
            game.players.forEach((p) => {
                if (p.socket) p.socket.emit("restart_status", status);
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
