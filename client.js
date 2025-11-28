const socket = io();

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const matchStatusEl = document.getElementById("matchStatus");
const overlayEl = document.getElementById("overlay");
const overlayTextEl = document.getElementById("overlayText");
const myHeartsEl = document.getElementById("myHearts");
const enemyHeartsEl = document.getElementById("enemyHearts");
const ammoFillEl = document.getElementById("ammoFill");
const restartBtn = document.getElementById("restartBtn");

let mySocketId = null;
let myRole = null; // "bottom" or "top"
let currentState = null;
let lastStateTime = 0;

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

// Request matchmaking
socket.emit("find_match");

socket.on("connect", () => {
  mySocketId = socket.id;
});

socket.on("waiting", (data) => {
  matchStatusEl.textContent = "상대 플레이어를 기다리는 중입니다...";
  showOverlay("상대 플레이어를 기다리는 중입니다...");
});

socket.on("match_found", (data) => {
  myRole = data.role;
  matchStatusEl.textContent = myRole === "bottom" ? "매칭 완료! 아래 전투기를 조종합니다." : "매칭 완료! 위 전투기를 조종합니다.";
  hideOverlay();
});

socket.on("state", (state) => {
  currentState = state;
  lastStateTime = performance.now();
  updateUI();
});

socket.on("game_over", ({ winner, loser }) => {
  const isWinner = winner === mySocketId;
  const text = isWinner ? "승리했습니다!\n\n다시 시작 버튼을 눌러 재대전을 요청하세요." : "패배했습니다...\n\n다시 시작 버튼을 눌러 재대전을 요청하세요.";
  showOverlay(text);
  restartBtn.disabled = false;
});

socket.on("restart_status", (status) => {
  restartStatus.me = status[mySocketId] || false;
  const otherId = Object.keys(status).find(id => id !== mySocketId);
  restartStatus.other = otherId ? status[otherId] : false;

  let msg = "";
  if (restartStatus.me && !restartStatus.other) {
    msg = "내가 다시 시작을 눌렀습니다.\n상대의 준비를 기다리는 중...";
  } else if (!restartStatus.me && restartStatus.other) {
    msg = "상대가 다시 시작을 눌렀습니다.\n내가 다시 시작을 누르면 재대전이 시작됩니다.";
  } else if (restartStatus.me && restartStatus.other) {
    msg = "곧 재대전이 시작됩니다...";
  }
  if (msg) {
    showOverlay(msg);
  }
});

socket.on("restart", () => {
  restartStatus.me = false;
  restartStatus.other = false;
  restartBtn.disabled = true;
  hideOverlay();
});

socket.on("opponent_left", () => {
  showOverlay("상대가 게임을 떠났습니다.\n페이지를 새로고침하여 다시 매칭을 시작하세요.");
  matchStatusEl.textContent = "상대가 떠났습니다.";
  restartBtn.disabled = true;
});

// Input handling
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight" || e.code === "Space") {
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
  if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight" || e.code === "Space") {
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

// Rendering
function gameLoop() {
  requestAnimationFrame(gameLoop);
  draw();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, "#0e1635");
  g.addColorStop(1, "#050814");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Starfield
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  for (let i = 0; i < 40; i++) {
    const x = (i * 123) % canvas.width;
    const y = (i * 57 + Math.floor(performance.now() * 0.02)) % canvas.height;
    ctx.fillRect(x, y, 2, 2);
  }

  if (!currentState) {
    drawCenteredText("매칭 대기 중...", canvas.width / 2, canvas.height / 2);
    return;
  }

  // Items
  currentState.items.forEach(item => {
    if (item.type === "heart") {
      drawHeartItem(item.x, item.y);
    } else if (item.type === "shield") {
      drawShieldItem(item.x, item.y);
    }
  });

  // Bullets
  ctx.fillStyle = "#ffdf5e";
  currentState.bullets.forEach(b => {
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });

  // Players
  currentState.players.forEach(p => {
    drawFighter(p);
  });
}

function drawFighter(p) {
  const isMe = p.socketId === mySocketId;
  const colorBody = isMe ? "#4be1ff" : "#ff5e7a";
  const colorAccent = isMe ? "#c4f4ff" : "#ffd2dd";

  ctx.save();
  ctx.translate(p.x, p.y);

  if (p.role === "top") {
    ctx.rotate(Math.PI); // flip for top
  }

  // Shield
  if (p.shieldActive) {
    ctx.beginPath();
    ctx.arc(0, 0, 28, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(144, 226, 255, 0.8)";
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Body
  ctx.fillStyle = colorBody;
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.lineTo(18, 16);
  ctx.lineTo(-18, 16);
  ctx.closePath();
  ctx.fill();

  // Cockpit
  ctx.fillStyle = colorAccent;
  ctx.beginPath();
  ctx.ellipse(0, -6, 7, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  // Wings
  ctx.fillStyle = colorBody;
  ctx.fillRect(-26, 4, 52, 6);

  // Engine glow
  ctx.fillStyle = "rgba(255, 209, 138, 0.85)";
  ctx.beginPath();
  ctx.moveTo(-10, 16);
  ctx.lineTo(0, 30);
  ctx.lineTo(10, 16);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawHeartItem(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1.2, 1.2);
  ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = "#ff4b69";
  ctx.fillRect(-8, -8, 16, 16);
  ctx.beginPath();
  ctx.arc(-8, 0, 8, 0, Math.PI * 2);
  ctx.arc(0, -8, 8, 0, Math.PI * 2);
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

function drawCenteredText(text, x, y) {
  ctx.fillStyle = "#f5f5f5";
  ctx.font = "20px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function updateUI() {
  if (!currentState) return;
  const me = currentState.players.find(p => p.socketId === mySocketId);
  const enemy = currentState.players.find(p => p.socketId !== mySocketId);

  // Hearts
  renderHearts(myHeartsEl, me ? me.hp : 0);
  renderHearts(enemyHeartsEl, enemy ? enemy.hp : 0);

  // Ammo gauge
  if (me) {
    const ratio = Math.max(0, Math.min(1, me.ammo / 100));
    ammoFillEl.style.width = (ratio * 100).toFixed(0) + "%";
  } else {
    ammoFillEl.style.width = "0%";
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

gameLoop();
