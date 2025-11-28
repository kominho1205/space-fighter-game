// ---------------- 익명 유저/닉네임 ----------------

function getOrCreateUserId() {
  const KEY = "spacezUserId";
  let id = localStorage.getItem(KEY);
  if (!id) {
    const random = Math.random().toString(36).slice(2);
    const time = Date.now().toString(36);
    id = "spacez_" + time + "_" + random;
    localStorage.setItem(KEY, id);
  }
  return id;
}

const userId = getOrCreateUserId();
let nickname = localStorage.getItem("spacezNickname") || "";

// 화면 제어
const screens = {
  nickname: document.getElementById("screen-nickname"),
  home: document.getElementById("screen-home"),
  ranking: document.getElementById("screen-ranking"),
  skins: document.getElementById("screen-skins"),
  game: document.getElementById("screen-game")
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    if (key === name) el.classList.remove("hidden");
    else el.classList.add("hidden");
  });
}

// 초기 화면 결정
if (nickname) {
  showScreen("home");
} else {
  showScreen("nickname");
}

// ---------------- 소켓 연결 ----------------

const socket = io();

socket.emit("identify", { userId, nickname });

socket.on("connect", () => {
  // 재연결 시에도 identify
  socket.emit("identify", { userId, nickname });
});

// 최신 프로필
let latestProfile = null;

socket.on("profile", (p) => {
  latestProfile = p;

  const homeNicknameEl = document.getElementById("homeNickname");
  const homeScoreEl = document.getElementById("homeScore");
  const skinsScoreEl = document.getElementById("skinsScore");
  const rankScoreEl = document.getElementById("rankScore");

  if (homeNicknameEl) homeNicknameEl.textContent = p.nickname;
  if (homeScoreEl) homeScoreEl.textContent = p.score;
  if (skinsScoreEl) skinsScoreEl.textContent = p.score;
  if (rankScoreEl) rankScoreEl.textContent = p.score;

  renderSkinList();
});

// 닉네임 입력 화면
document.getElementById("nicknameConfirmBtn").addEventListener("click", () => {
  const input = document.getElementById("nicknameInput");
  const value = input.value.trim();
  if (!value) return;
  nickname = value;
  localStorage.setItem("spacezNickname", nickname);
  socket.emit("identify", { userId, nickname });
  showScreen("home");
});

// 홈 화면 버튼
document.getElementById("btnPlay").addEventListener("click", () => {
  showScreen("game");
  socket.emit("find_match");
});

document.getElementById("btnSkins").addEventListener("click", () => {
  showScreen("skins");
});

document.getElementById("btnRanking").addEventListener("click", () => {
  showScreen("ranking");
  socket.emit("get_leaderboard", (list) => {
    renderLeaderboard(list);
  });
});

// 랭킹 화면
document.getElementById("btnRankingBack").addEventListener("click", () => {
  showScreen("home");
});

// 스킨 화면
document.getElementById("btnSkinsBack").addEventListener("click", () => {
  showScreen("home");
});

// 게임 화면 → 홈
document.getElementById("btnGameBack").addEventListener("click", () => {
  showScreen("home");
});

// 랭킹 렌더링
function renderLeaderboard(list) {
  const ul = document.getElementById("rankingList");
  ul.innerHTML = "";
  list.forEach((p, idx) => {
    const li = document.createElement("li");
    li.textContent = `${idx + 1}. ${p.nickname} - ${p.score}`;
    ul.appendChild(li);
  });
}

// ---------------- 스킨 선택 ----------------

const SKIN_DATA = [
  { id: 0, name: "기본", requiredScore: 0, desc: "기본 전투기" },
  { id: 1, name: "와이드", requiredScore: 200, desc: "넓은 날개, 황금탄" },
  { id: 2, name: "다트", requiredScore: 400, desc: "날렵한 삼각형, 초록탄" },
  { id: 3, name: "레이저", requiredScore: 700, desc: "레이저 탄환" }
];

function renderSkinList() {
  if (!latestProfile) return;
  const unlocked = new Set(latestProfile.unlockedSkins || []);
  const container = document.getElementById("skinList");
  container.innerHTML = "";

  SKIN_DATA.forEach((skin) => {
    const div = document.createElement("div");
    div.className = "skinCard";

    const locked = !unlocked.has(skin.id);

    const btnLabel = locked
      ? `잠김`
      : latestProfile.preferredSkin === skin.id
      ? "선택됨"
      : "선택";

    div.innerHTML = `
      <div>
        <div class="skinName">${skin.name}</div>
        <div class="skinReq">필요 점수: ${skin.requiredScore}점</div>
        <div style="font-size:12px;color:#b9c2ff;">${skin.desc}</div>
      </div>
      <button class="skinSelectBtn" data-id="${skin.id}" ${
      locked ? "disabled" : ""
    }>${btnLabel}</button>
    `;

    container.appendChild(div);
  });

  container.querySelectorAll(".skinSelectBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      socket.emit("set_skin", { skinId: id });
    });
  });
}

// ------------------- 게임 부분 -------------------

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const matchStatusEl = document.getElementById("matchStatus");
const overlayEl = document.getElementById("overlay");
const overlayTextEl = document.getElementById("overlayText");
const myHeartsEl = document.getElementById("myHearts");
const enemyHeartsEl = document.getElementById("enemyHearts");
const ammoFillEl = document.getElementById("ammoFill");
const restartBtn = document.getElementById("restartBtn");
const quickMatchBtn = document.getElementById("quickMatchBtn");

let mySocketId = null;
let myRole = null;
let currentState = null;

let keys = {
  ArrowUp: false,
  ArrowDown: false,
  ArrowLeft: false,
  ArrowRight: false,
  Space: false
};

let canShootAgain = true;
const SHOOT_KEY_COOLDOWN_MS = 150;

let restartStatus = {
  me: false,
  other: false
};

socket.on("connect", () => {
  mySocketId = socket.id;
});

socket.on("waiting", () => {
  if (screens.game.classList.contains("hidden")) return;
  matchStatusEl.textContent = "상대 플레이어를 기다리는 중입니다...";
  showOverlay("상대 플레이어를 기다리는 중입니다...");
});

socket.on("match_found", (data) => {
  myRole = data.role;
  matchStatusEl.textContent =
    myRole === "bottom"
      ? "매칭 완료! 아래 전투기를 조종합니다."
      : "매칭 완료! 위 전투기를 조종합니다.";
  hideOverlay();
});

socket.on("state", (state) => {
  currentState = state;
  updateUI();
});

socket.on("game_over", ({ winner }) => {
  const isWinner = winner === mySocketId;
  const text = isWinner
    ? "승리했습니다!\n\n다시 시작 버튼을 눌러 같은 상대와 재대전을 요청하세요."
    : "패배했습니다...\n\n다시 시작 버튼을 눌러 같은 상대와 재대전을 요청하세요.";
  showOverlay(text);
  restartBtn.disabled = false;
});

socket.on("restart_status", (status) => {
  restartStatus.me = status[mySocketId] || false;
  const otherId = Object.keys(status).find((id) => id !== mySocketId);
  restartStatus.other = otherId ? status[otherId] : false;

  let msg = "";
  if (restartStatus.me && !restartStatus.other) {
    msg = "내가 다시 시작을 눌렀습니다.\n상대의 준비를 기다리는 중...";
  } else if (!restartStatus.me && restartStatus.other) {
    msg =
      "상대가 다시 시작을 눌렀습니다.\n내가 다시 시작을 누르면 재대전이 시작됩니다.";
  } else if (restartStatus.me && restartStatus.other) {
    msg = "곧 재대전이 시작됩니다...";
  }
  if (msg) showOverlay(msg);
});

socket.on("restart", () => {
  restartStatus.me = false;
  restartStatus.other = false;
  restartBtn.disabled = true;
  hideOverlay();
});

socket.on("opponent_left", () => {
  showOverlay(
    "상대가 게임을 떠났습니다.\n페이지를 새로고침하거나 새 상대 찾기를 눌러주세요."
  );
  matchStatusEl.textContent = "상대가 떠났습니다.";
  restartBtn.disabled = true;
});

// 입력 처리
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") e.preventDefault();

  if (
    e.key === "ArrowUp" ||
    e.key === "ArrowDown" ||
    e.key === "ArrowLeft" ||
    e.key === "ArrowRight" ||
    e.code === "Space"
  ) {
    if (e.repeat) return;
    keys[e.key] = true;
    if (e.code === "Space") {
      tryShoot();
    } else {
      sendMoveInput();
    }
  }
});

window.addEventListener("keyup", (e) => {
  if (
    e.key === "ArrowUp" ||
    e.key === "ArrowDown" ||
    e.key === "ArrowLeft" ||
    e.key === "ArrowRight" ||
    e.code === "Space"
  ) {
    keys[e.key] = false;
    if (e.code !== "Space") {
      sendMoveInput();
    }
  }
});

function sendMoveInput() {
  const input = {
    up: keys["ArrowUp"],
    down: keys["ArrowDown"],
    left: keys["ArrowLeft"],
    right: keys["ArrowRight"]
  };
  socket.emit("move", input);
}

function tryShoot() {
  if (!canShootAgain) return;
  canShootAgain = false;
  socket.emit("shoot");
  setTimeout(() => {
    canShootAgain = true;
  }, SHOOT_KEY_COOLDOWN_MS);
}

restartBtn.addEventListener("click", () => {
  socket.emit("restart_request");
  restartBtn.disabled = true;
});

// 새 상대 찾기: 새로고침
quickMatchBtn.addEventListener("click", () => {
  window.location.reload();
});

// ---------------- 렌더링 ----------------

function gameLoop() {
  requestAnimationFrame(gameLoop);
  draw();
}
gameLoop();

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 배경
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, "#0e1635");
  g.addColorStop(1, "#050814");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 별
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  for (let i = 0; i < 40; i++) {
    const x = (i * 123) % canvas.width;
    const y = (i * 57 + Math.floor(performance.now() * 0.02)) % canvas.height;
    ctx.fillRect(x, y, 2, 2);
  }

  if (!currentState) {
    drawCenteredText("게임을 시작하면 전장이 표시됩니다.", canvas.width / 2, canvas.height / 2);
    return;
  }

  // 아이템
  currentState.items.forEach((item) => {
    if (item.type === "heart") {
      drawHeartItem(item.x, item.y);
    } else if (item.type === "shield") {
      drawShieldItem(item.x, item.y);
    } else if (item.type === "ammo") {
      drawAmmoItem(item.x, item.y);
    }
  });

  // 폭발 이펙트
  if (currentState.explosions) {
    currentState.explosions.forEach((ex) => drawExplosion(ex));
  }

  // 총알
  currentState.bullets.forEach((b) => {
    drawBullet(b);
  });

  // 전투기
  currentState.players.forEach((p) => {
    drawFighter(p);
  });
}

function drawBullet(b) {
  let color;
  switch (b.skinId) {
    case 1:
      color = "#ffd24d"; // 와이드: 노란 탄
      break;
    case 2:
      color = "#7bffb2"; // 다트: 초록 탄
      break;
    case 3:
      color = "#f279ff"; // 레이저형: 보라 탄
      break;
    default:
      color = "#ffdf5e"; // 기본
  }
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFighter(p) {
  const isMe = p.socketId === mySocketId;

  const bodyColor = isMe ? "#4be1ff" : "#ff5e7a";
  const accentColor = isMe ? "#c4f4ff" : "#ffd2dd";

  ctx.save();
  ctx.translate(p.x, p.y);

  if (p.role === "top") {
    ctx.rotate(Math.PI);
  }

  // 방어막
  if (p.shieldActive) {
    ctx.beginPath();
    ctx.arc(0, 0, 28, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(144, 226, 255, 0.8)";
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const skinId = p.skinId ?? 0;

  switch (skinId) {
    case 1:
      drawWideShip(bodyColor, accentColor);
      break;
    case 2:
      drawDartShip(bodyColor, accentColor);
      break;
    case 3:
      drawLaserShip(bodyColor, accentColor);
      break;
    default:
      drawDefaultShip(bodyColor, accentColor);
  }

  ctx.restore();
}

// 기본 스킨
function drawDefaultShip(bodyColor, accentColor) {
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.lineTo(18, 16);
  ctx.lineTo(-18, 16);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.ellipse(0, -6, 7, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = bodyColor;
  ctx.fillRect(-26, 4, 52, 6);

  ctx.fillStyle = "rgba(255, 209, 138, 0.85)";
  ctx.beginPath();
  ctx.moveTo(-10, 16);
  ctx.lineTo(0, 30);
  ctx.lineTo(10, 16);
  ctx.closePath();
  ctx.fill();
}

// 와이드
function drawWideShip(bodyColor, accentColor) {
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.moveTo(0, -20);
  ctx.lineTo(26, 10);
  ctx.lineTo(0, 18);
  ctx.lineTo(-26, 10);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.ellipse(0, -4, 8, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 209, 138, 0.9)";
  ctx.beginPath();
  ctx.moveTo(-6, 18);
  ctx.lineTo(0, 30);
  ctx.lineTo(6, 18);
  ctx.closePath();
  ctx.fill();
}

// 다트
function drawDartShip(bodyColor, accentColor) {
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.lineTo(14, 18);
  ctx.lineTo(0, 12);
  ctx.lineTo(-14, 18);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.ellipse(0, -8, 6, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = bodyColor;
  ctx.fillRect(-12, 4, 24, 4);

  ctx.fillStyle = "rgba(255, 209, 138, 0.9)";
  ctx.beginPath();
  ctx.moveTo(-5, 18);
  ctx.lineTo(0, 30);
  ctx.lineTo(5, 18);
  ctx.closePath();
  ctx.fill();
}

// 레이저형
function drawLaserShip(bodyColor, accentColor) {
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.lineTo(10, 0);
  ctx.lineTo(6, 20);
  ctx.lineTo(-6, 20);
  ctx.lineTo(-10, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.ellipse(0, -6, 5, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillRect(-3, 20, 6, 10);
}

// 아이템 하트 (체력 하트와 동일 구조)
function drawHeartItem(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = "#ff4b69";

  ctx.fillRect(-9, -9, 18, 18);

  ctx.beginPath();
  ctx.arc(-9, 0, 9, 0, Math.PI * 2);
  ctx.arc(0, -9, 9, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawShieldItem(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = "#77f5ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(10, -4);
  ctx.lineTo(6, 10);
  ctx.lineTo(-6, 10);
  ctx.lineTo(-10, -4);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawAmmoItem(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#2f7bff";
  ctx.strokeStyle = "#c4ddff";
  ctx.lineWidth = 2;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(-10, -10, 20, 20, 4);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(-10, -10, 20, 20);
    ctx.strokeRect(-10, -10, 20, 20);
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(-2, -6, 4, 12);
  ctx.restore();
}

// 폭발 이펙트
function drawExplosion(ex) {
  const age = Math.min(ex.age, 1);
  const alpha = 1 - age;
  const radius = 10 + 10 * (1 - age);

  ctx.save();
  ctx.translate(ex.x, ex.y);
  ctx.globalAlpha = alpha;

  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,180,140,0.9)");
  g.addColorStop(1, "rgba(255,120,120,0)");
  ctx.fillStyle = g;

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawCenteredText(text, x, y) {
  ctx.fillStyle = "#f5f5f5";
  ctx.font =
    "20px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

// UI 업데이트
function updateUI() {
  if (!currentState) return;
  const me = currentState.players.find((p) => p.socketId === mySocketId);
  const enemy = currentState.players.find((p) => p.socketId !== mySocketId);

  renderHearts(myHeartsEl, me ? me.hp : 0);
  renderHearts(enemyHeartsEl, enemy ? enemy.hp : 0);

  if (me) {
    const ratio = Math.max(0, Math.min(1, me.ammo / 100));
    ammoFillEl.style.width = (ratio * 100).toFixed(0) + "%";

    const rankScoreEl = document.getElementById("rankScore");
    if (rankScoreEl && typeof me.score === "number") {
      rankScoreEl.textContent = me.score;
    }
  }
}

function renderHearts(container, hp) {
  container.innerHTML = "";
  for (let i = 0; i < hp; i++) {
    const el = document.createElement("span");
    el.className = "heart";
    container.appendChild(el);
  }
}

function showOverlay(text) {
  overlayTextEl.textContent = text;
  overlayEl.classList.remove("hidden");
}

function hideOverlay() {
  overlayEl.classList.add("hidden");
}
