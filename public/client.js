// ---------------- 로그인/화면 제어 ----------------

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    if (key === name) el.classList.remove("hidden");
    else el.classList.add("hidden");
  });
}

const screens = {
  nickname: document.getElementById("screen-nickname"),
  home: document.getElementById("screen-home"),
  ranking: document.getElementById("screen-ranking"),
  skins: document.getElementById("screen-skins"),
  game: document.getElementById("screen-game")
};

let latestProfile = null;
let currentAccount = null;

// ---------------- 소리 시스템 ----------------

class SoundManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.enabled = true;
  }
  init() {
    if (this.ctx) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.5;
    this.masterGain.connect(this.ctx.destination);
  }
  _tone({ freq = 440, duration = 0.1, type = "square", volume = 0.8 }) {
    if (!this.enabled) return;
    if (!this.ctx) this.init();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = volume;
    osc.connect(gain);
    gain.connect(this.masterGain);
    const now = this.ctx.currentTime;
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.start(now);
    osc.stop(now + duration);
  }
  playShoot() {
    this._tone({ freq: 900, duration: 0.07, type: "square", volume: 0.45 });
  }
  playHit() {
    this._tone({ freq: 240, duration: 0.09, type: "sawtooth", volume: 0.55 });
  }
  playExplosion() {
    this._tone({ freq: 90, duration: 0.3, type: "sawtooth", volume: 0.7 });
  }
  playPickup() {
    this._tone({ freq: 600, duration: 0.07, type: "triangle", volume: 0.45 });
    setTimeout(() => {
      this._tone({ freq: 900, duration: 0.07, type: "triangle", volume: 0.45 });
    }, 70);
  }
  playCountdownBeep() {
    this._tone({ freq: 700, duration: 0.12, type: "square", volume: 0.5 });
  }
  playGameStart() {
    this._tone({ freq: 1000, duration: 0.22, type: "square", volume: 0.65 });
  }
}

const sound = new SoundManager();
// 첫 사용자 입력 후 오디오 초기화
document.addEventListener(
  "click",
  () => {
    sound.init();
  },
  { once: true }
);
document.addEventListener(
  "touchstart",
  () => {
    sound.init();
  },
  { once: true }
);

// ---------------- 소켓 연결 ----------------

const socket = io();

socket.on("connect", () => {
  // 자동 로그인 시도는 연결 후 처리
  tryAutoLogin();
});

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

// 로그인 처리
function doLogin(nickname, password, { auto = false } = {}) {
  socket.emit("login", { nickname, password }, (res) => {
    if (!res || !res.ok) {
      if (!auto) {
        alert(res && res.error ? res.error : "로그인에 실패했습니다.");
      }
      showScreen("nickname");
      return;
    }
    currentAccount = { nickname };
    latestProfile = res.profile || latestProfile;

    localStorage.setItem(
      "spacezAccount",
      JSON.stringify({ nickname, password })
    );

    showScreen("home");
  });
}

function tryAutoLogin() {
  const saved = localStorage.getItem("spacezAccount");
  if (!saved) {
    showScreen("nickname");
    return;
  }
  let data;
  try {
    data = JSON.parse(saved);
  } catch {
    localStorage.removeItem("spacezAccount");
    showScreen("nickname");
    return;
  }
  if (!data.nickname || !data.password) {
    localStorage.removeItem("spacezAccount");
    showScreen("nickname");
    return;
  }
  doLogin(data.nickname, data.password, { auto: true });
}

// 닉네임/비밀번호 입력
document
  .getElementById("nicknameConfirmBtn")
  .addEventListener("click", () => {
    const nick = document.getElementById("nicknameInput").value.trim();
    const pw = document.getElementById("passwordInput").value.trim();
    if (!nick || !pw) return;
    doLogin(nick, pw, { auto: false });
  });

// 로그아웃
document.getElementById("btnLogout").addEventListener("click", () => {
  localStorage.removeItem("spacezAccount");
  currentAccount = null;
  latestProfile = null;
  showScreen("nickname");
});

// 홈 화면
document.getElementById("btnPlay").addEventListener("click", () => {
  currentState = null;
  myRole = null;
  restartStatus = { me: false, other: false };
  restartBtn.disabled = true;
  hideOverlay();
  matchStatusEl.textContent = "매칭 대기 중...";

  currentVsAI = false;
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

document.getElementById("btnRankingBack").addEventListener("click", () => {
  showScreen("home");
});

document.getElementById("btnSkinsBack").addEventListener("click", () => {
  showScreen("home");
});

document.getElementById("btnGameBack").addEventListener("click", () => {
  socket.emit("leave_match");
  showScreen("home");
});

// 랭킹 렌더링 (ol 자체 번호 사용)
function renderLeaderboard(list) {
  const ul = document.getElementById("rankingList");
  ul.innerHTML = "";
  list.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = `${p.nickname} - ${p.score}`;
    ul.appendChild(li);
  });
}

// ---------------- 스킨 ----------------

const SKIN_DATA = [
  { id: 0, name: "기본", requiredScore: 0, desc: "기본 전투기 (HP 3, 보통 속도)" },
  { id: 1, name: "와이드", requiredScore: 200, desc: "HP 4, 조금 느림" },
  { id: 2, name: "다트", requiredScore: 400, desc: "HP 3, 조금 더 빠름" },
  { id: 3, name: "레이저", requiredScore: 700, desc: "HP 3, 긴 레이저 탄" }
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
      ? "잠김"
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

// ---------------- 게임 ----------------

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const matchStatusEl = document.getElementById("matchStatus");
const overlayEl = document.getElementById("overlay");
const overlayTextEl = document.getElementById("overlayText");
const myHeartsEl = document.getElementById("myHearts");
const enemyHeartsEl = document.getElementById("enemyHearts");
const ammoFillEl = document.getElementById("ammoFill");
const restartBtn = document.getElementById("restartBtn");

// 라벨 엘리먼트 (닉네임 표시)
const pcMyLabelEl = document.getElementById("pcMyLabel");
const pcEnemyLabelEl = document.getElementById("pcEnemyLabel");
const mobileMyLabelEl = document.getElementById("mobileMyLabel");
const mobileEnemyLabelEl = document.getElementById("mobileEnemyLabel");

// 모바일용 요소
const mobileMyHeartsEl = document.getElementById("mobileMyHearts");
const mobileEnemyHeartsEl = document.getElementById("mobileEnemyHearts");
const mobileAmmoFillEl = document.getElementById("mobileAmmoFill");

let mySocketId = null;
let myRole = null;
let currentState = null;
let currentVsAI = false;
let gameCountdown = 0;

let prevCountdownInt = null;
let lastMeHp = null;
let lastEnemyHp = null;
let lastItemCount = 0;

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
  currentVsAI = !!data.vsAI;

  if (currentVsAI) {
    matchStatusEl.textContent = "AI와 매칭되었습니다. 아래 전투기를 조종합니다.";
    restartBtn.style.display = "none"; // AI일 때는 다시하기 버튼 숨김
  } else {
    matchStatusEl.textContent =
      myRole === "bottom"
        ? "매칭 완료! 아래 전투기를 조종합니다."
        : "매칭 완료! 위 전투기를 조종합니다.";
    restartBtn.style.display = "block";
  }

  restartStatus = { me: false, other: false };
  restartBtn.disabled = true;
  hideOverlay();

  gameCountdown = 3;
  prevCountdownInt = null;
});

socket.on("state", (state) => {
  currentState = state;
  gameCountdown = state.countdown || 0;

  const cInt = Math.ceil(gameCountdown);
  if (prevCountdownInt !== null && cInt !== prevCountdownInt) {
    if (cInt > 0) sound.playCountdownBeep();
    else if (prevCountdownInt > 0) sound.playGameStart();
  }
  prevCountdownInt = cInt;

  const me = state.players.find((p) => p.socketId === mySocketId);
  const enemy = state.players.find((p) => p.socketId !== mySocketId);

  // 내 HP 변화
  if (me) {
    if (lastMeHp != null && me.hp < lastMeHp) {
      if (me.hp <= 0) {
        // 마지막 하트에서 터질 때는 폭발음
        sound.playExplosion();
      } else {
        sound.playHit();
      }
    }
    lastMeHp = me.hp;
  }

  // 상대 HP 변화
  if (enemy) {
    if (lastEnemyHp != null && enemy.hp < lastEnemyHp) {
      if (enemy.hp <= 0) sound.playExplosion();
      else sound.playHit();
    }
    lastEnemyHp = enemy.hp;
  }

  if (typeof state.items?.length === "number") {
    if (state.items.length < lastItemCount) {
      sound.playPickup();
    }
    lastItemCount = state.items.length;
  }

  updateUI();
});


socket.on("game_over", ({ winner, vsAI }) => {
  const isWinner = winner === mySocketId;
  currentVsAI = !!vsAI;

  const text = isWinner
    ? "승리했습니다!\n\n홈으로 돌아가 새 상대를 찾으세요."
    : "패배했습니다...\n\n홈으로 돌아가 새 상대를 찾으세요.";
  showOverlay(text);

  if (!currentVsAI) {
    restartBtn.disabled = false;
  } else {
    restartBtn.disabled = true;
    restartBtn.style.display = "none";
  }
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

socket.on("restart", (data) => {
  currentVsAI = !!(data && data.vsAI);
  restartStatus.me = false;
  restartStatus.other = false;
  restartBtn.disabled = true;
  if (!currentVsAI) restartBtn.style.display = "block";
  hideOverlay();
  gameCountdown = 3;
  prevCountdownInt = null;
});

// 상대 이탈
socket.on("opponent_left", () => {
  showOverlay(
    "상대가 게임을 떠났습니다.\n상대는 패배 처리되고,\n나에게는 승리로 기록됩니다.\n\n홈으로 돌아가 새 게임을 시작하세요."
  );
  matchStatusEl.textContent = "상대가 떠났습니다. (내 승리)";
  restartBtn.disabled = true;
  currentState = null;
  myRole = null;
  restartStatus = { me: false, other: false };
});

// 입력(키보드)
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
    if (e.code === "Space") {
      keys.Space = true;
      tryShoot();
    } else {
      keys[e.key] = true;
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
    if (e.code === "Space") {
      keys.Space = false;
    } else {
      keys[e.key] = false;
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
  sound.playShoot();
  setTimeout(() => {
    canShootAgain = true;
  }, SHOOT_KEY_COOLDOWN_MS);
}

restartBtn.addEventListener("click", () => {
  socket.emit("restart_request");
  restartBtn.disabled = true;
});

/* ---- 모바일 FIRE 버튼: 스페이스 ---- */
function registerButtonHold(buttonId, keyName) {
  const el = document.getElementById(buttonId);
  if (!el) return;

  const press = (e) => {
    e.preventDefault();
    keys[keyName] = true;
    if (keyName === "Space") {
      tryShoot();
    } else {
      sendMoveInput();
    }
  };

  const release = (e) => {
    e.preventDefault();
    keys[keyName] = false;
    if (keyName !== "Space") {
      sendMoveInput();
    }
  };

  el.addEventListener("touchstart", press);
  el.addEventListener("touchend", release);
  el.addEventListener("touchcancel", release);
  el.addEventListener("mousedown", press);
  el.addEventListener("mouseup", release);
  el.addEventListener("mouseleave", release);
}

registerButtonHold("btnFire", "Space");

/* ---- 가상 조이스틱 ---- */
const joystickBase = document.getElementById("joystickBase");
const joystickStick = document.getElementById("joystickStick");

let joystickActive = false;
let joystickPointerId = null;

if (joystickBase && joystickStick) {
  const maxRadius = 40; // 조이스틱 최대 이동 반경(px)
  const deadZone = 0.25; // 데드존 (비율)

  const updateFromEvent = (e) => {
    const rect = joystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);

    const clamped = Math.min(dist, maxRadius);
    const nx = dist > 0 ? dx / dist : 0;
    const ny = dist > 0 ? dy / dist : 0;

    joystickStick.style.left = "50%";
    joystickStick.style.top = "50%";
    joystickStick.style.transform = `translate(-50%, -50%) translate(${
      nx * clamped
    }px, ${ny * clamped}px)`;

    keys.ArrowLeft = nx < -deadZone;
    keys.ArrowRight = nx > deadZone;
    keys.ArrowUp = ny < -deadZone;
    keys.ArrowDown = ny > deadZone;

    sendMoveInput();
  };

  const resetStick = () => {
    joystickStick.style.left = "50%";
    joystickStick.style.top = "50%";
    joystickStick.style.transform = "translate(-50%, -50%)";
    keys.ArrowLeft = keys.ArrowRight = keys.ArrowUp = keys.ArrowDown = false;
    sendMoveInput();
  };

  joystickBase.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    joystickActive = true;
    joystickPointerId = e.pointerId;
    joystickBase.setPointerCapture(e.pointerId);
    updateFromEvent(e);
  });

  joystickBase.addEventListener("pointermove", (e) => {
    if (!joystickActive || e.pointerId !== joystickPointerId) return;
    e.preventDefault();
    updateFromEvent(e);
  });

  const end = (e) => {
    if (!joystickActive || e.pointerId !== joystickPointerId) return;
    e.preventDefault();
    joystickActive = false;
    joystickPointerId = null;
    resetStick();
    joystickBase.releasePointerCapture(e.pointerId);
  };

  joystickBase.addEventListener("pointerup", end);
  joystickBase.addEventListener("pointercancel", end);
}

// 모바일에서 캔버스/조이스틱 쪽 스크롤 방지
["touchstart", "touchmove"].forEach((evtName) => {
  document.addEventListener(
    evtName,
    (e) => {
      if (
        e.target.closest("#gameCanvas") ||
        e.target.closest("#mobileControls") ||
        e.target.closest("#joystickBase")
      ) {
        e.preventDefault();
      }
    },
    { passive: false }
  );
});

// ---------------- 렌더링 ----------------

function gameLoop() {
  requestAnimationFrame(gameLoop);
  draw();
}
gameLoop();

function isOverlayVisible() {
  return !overlayEl.classList.contains("hidden");
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, "#0e1635");
  g.addColorStop(1, "#050814");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(255,255,255,0.2)";
  for (let i = 0; i < 40; i++) {
    const x = (i * 123) % canvas.width;
    const y = (i * 57 + Math.floor(performance.now() * 0.02)) % canvas.height;
    ctx.fillRect(x, y, 2, 2);
  }

  if (!currentState) {
    if (!isOverlayVisible()) {
      drawCenteredText(
        "게임을 시작하면 전장이 표시됩니다.\n상대 플레이어를 기다리는 중입니다...",
        canvas.width / 2,
        canvas.height / 2
      );
    }
    return;
  }

  currentState.items.forEach((item) => {
    if (item.type === "heart") {
      drawHeartItem(item.x, item.y);
    } else if (item.type === "shield") {
      drawShieldItem(item.x, item.y);
    } else if (item.type === "ammo") {
      drawAmmoItem(item.x, item.y);
    }
  });

  if (currentState.explosions) {
    currentState.explosions.forEach((ex) => drawExplosion(ex));
  }

  currentState.bullets.forEach((b) => {
    drawBullet(b);
  });

  currentState.players.forEach((p) => {
    drawFighter(p);
  });

  // 중앙 카운트다운 텍스트
  if (gameCountdown > 0) {
    const cInt = Math.ceil(gameCountdown);
    const text = cInt.toString();
    ctx.fillStyle = "#ffe66d";
    ctx.font =
      "bold 40px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI'";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }
}

function drawBullet(b) {
  ctx.save();
  ctx.translate(b.x, b.y);

  switch (b.skinId) {
    case 1:
      ctx.fillStyle = "#ffd24d";
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 2:
      ctx.fillStyle = "#7bffb2";
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 3:
      ctx.fillStyle = "#f279ff";
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(-2, -12, 4, 24, 2);
      } else {
        ctx.fillRect(-2, -12, 4, 24);
      }
      ctx.fill();
      break;
    default:
      ctx.fillStyle = "#ffdf5e";
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
  }

  ctx.restore();
}

function drawFighter(p) {
  const isMe = p.socketId === mySocketId;
  const isHitInv = p.hitInvActive;

  // ★ HP가 0 이하면 전투기는 그리지 않고, 폭발만 보이게
  if (p.hp <= 0) return;

  const bodyColor = isMe ? "#4be1ff" : "#ff5e7a";
  const accentColor = isMe ? "#c4f4ff" : "#ffd2dd";

  ctx.save();
  ctx.translate(p.x, p.y);

  if (isHitInv) {
    const t = performance.now() * 0.02;
    const alpha = 0.3 + (Math.sin(t) + 1) * 0.35;
    ctx.globalAlpha = alpha;
  }

  if (p.role === "top") {
    ctx.rotate(Math.PI);
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

  if (p.shieldActive) {
    ctx.beginPath();
    ctx.arc(0, 0, 28, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(144, 226, 255, 0.8)";
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

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

function drawExplosion(ex) {
  const age = Math.min(ex.age, 1); // 0 ~ 1
  const alpha = 1 - age;
  const radius = 18 + 22 * (1 - age); // 기존보다 크게

  ctx.save();
  ctx.translate(ex.x, ex.y);
  ctx.globalAlpha = alpha;

  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,220,150,0.95)");
  g.addColorStop(0.65, "rgba(255,120,90,0.7)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  // 파편 느낌의 선 몇 개
  ctx.strokeStyle = "rgba(255,230,180,0.8)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6;
    const r1 = radius * 0.4;
    const r2 = radius * (0.8 + 0.2 * Math.random());
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
    ctx.stroke();
  }

  ctx.restore();
}



function drawCenteredText(text, x, y) {
  ctx.fillStyle = "#f5f5f5";
  ctx.font =
    "18px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

// UI 업데이트 (모바일/PC 둘 다 갱신)
function updateUI() {
  if (!currentState) {
    myHeartsEl.innerHTML = "";
    enemyHeartsEl.innerHTML = "";
    ammoFillEl.style.width = "0%";
    if (mobileMyHeartsEl) mobileMyHeartsEl.innerHTML = "";
    if (mobileEnemyHeartsEl) mobileEnemyHeartsEl.innerHTML = "";
    if (mobileAmmoFillEl) mobileAmmoFillEl.style.width = "0%";
    return;
  }
  const me = currentState.players.find((p) => p.socketId === mySocketId);
  const enemy = currentState.players.find((p) => p.socketId !== mySocketId);

  // 닉네임 + 체력 라벨
  if (me) {
    const name = me.nickname || "나";
    if (pcMyLabelEl) pcMyLabelEl.textContent = `${name} 체력`;
    if (mobileMyLabelEl) mobileMyLabelEl.textContent = `${name} 체력`;
  }
  if (enemy) {
    const name = enemy.nickname || "상대";
    if (pcEnemyLabelEl) pcEnemyLabelEl.textContent = `${name} 체력`;
    if (mobileEnemyLabelEl) mobileEnemyLabelEl.textContent = `${name} 체력`;
  }

  renderHearts(myHeartsEl, me ? me.hp : 0);
  renderHearts(enemyHeartsEl, enemy ? enemy.hp : 0);

  if (mobileMyHeartsEl) renderHearts(mobileMyHeartsEl, me ? me.hp : 0);
  if (mobileEnemyHeartsEl)
    renderHearts(mobileEnemyHeartsEl, enemy ? enemy.hp : 0);

  if (me) {
    const ratio = Math.max(0, Math.min(1, me.ammo / 100));
    ammoFillEl.style.width = (ratio * 100).toFixed(0) + "%";
    if (mobileAmmoFillEl)
      mobileAmmoFillEl.style.width = (ratio * 100).toFixed(0) + "%";

    const rankScoreEl = document.getElementById("rankScore");
    if (rankScoreEl && typeof me.score === "number") {
      rankScoreEl.textContent = me.score;
    }
  }
}

function renderHearts(container, hp) {
  if (!container) return;
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
