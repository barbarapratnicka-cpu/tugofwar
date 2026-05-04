const socket = io();

const joinModal = document.getElementById("joinModal");
const joinForm = document.getElementById("joinForm");
const joinError = document.getElementById("joinError");
const nameInput = document.getElementById("nameInput");
const avatarPicker = document.getElementById("avatarPicker");

const leftPlayersEl = document.getElementById("leftPlayers");
const rightPlayersEl = document.getElementById("rightPlayers");
const leftTeamGroup = document.getElementById("leftTeamGroup");
const rightTeamGroup = document.getElementById("rightTeamGroup");
const rope = document.getElementById("rope");
const phaseText = document.getElementById("phaseText");
const overlay = document.getElementById("overlay");
const overlayText = document.getElementById("overlayText");

let localPlayerId = null;
let joined = false;
let selectedAvatar = "😎";
let currentState = null;
let targetRopePosition = 0;
let displayedRopePosition = 0;
let lastAnimTs = performance.now();

const tapTimes = [];
const TAP_WINDOW_MS = 1000;
const AVAILABLE_AVATARS = [
  "😎", "😀", "😄", "😁", "😆", "🙂", "😊", "😇", "😉", "🤩",
  "🥳", "🤠", "🧐", "🤓", "😺", "😸", "😹", "😻", "😼", "🙃",
  "🤖", "👻", "👽", "👾", "🐵", "🐶", "🐱", "🦊", "🐻", "🐼",
  "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐙", "🦄", "🐝", "🦉",
  "🦖", "🐳", "🐬", "🦋", "🐢", "🐲", "🦀", "🐧", "🦦", "🐺"
];

function buildAvatarPicker() {
  avatarPicker.innerHTML = "";
  AVAILABLE_AVATARS.forEach((emoji) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "avatar-btn";
    button.dataset.emoji = emoji;
    button.textContent = emoji;
    if (emoji === selectedAvatar) {
      button.classList.add("selected");
    }
    avatarPicker.appendChild(button);
  });
}

function getSelectedAvatarFromDom() {
  const selectedButton = avatarPicker.querySelector(".avatar-btn.selected");
  if (selectedButton instanceof HTMLButtonElement) {
    const fromData = selectedButton.dataset.emoji;
    if (fromData && fromData.trim()) {
      return fromData.trim();
    }
    if (selectedButton.textContent && selectedButton.textContent.trim()) {
      return selectedButton.textContent.trim();
    }
  }
  return selectedAvatar || "😎";
}

function setOverlay(text, show) {
  overlayText.textContent = text;
  overlay.classList.toggle("hidden", !show);
}

function computeLocalTps() {
  const now = performance.now();
  while (tapTimes.length > 0 && now - tapTimes[0] > TAP_WINDOW_MS) {
    tapTimes.shift();
  }

  const tps = tapTimes.length / (TAP_WINDOW_MS / 1000);
  return Math.max(0, Math.min(30, tps));
}

function createPlayerCard(player) {
  const card = document.createElement("div");
  card.className = "player-card";

  const name = document.createElement("span");
  name.className = "player-name";
  name.textContent = player.name;

  const tps = document.createElement("span");
  tps.className = "player-tps";
  tps.textContent = `${(player.tps || 0).toFixed(1)} TPS`;

  const emoji = document.createElement("span");
  emoji.className = "player-emoji";
  emoji.textContent = player.avatarEmoji || "😀";

  card.appendChild(tps);
  card.appendChild(emoji);
  card.appendChild(name);
  return card;
}

function renderPlayers(players) {
  leftPlayersEl.innerHTML = "";
  rightPlayersEl.innerHTML = "";

  players.forEach((player) => {
    const card = createPlayerCard(player);
    if (player.id === localPlayerId) {
      card.classList.add("self");
    }
    if (player.side === "left") {
      leftPlayersEl.appendChild(card);
    } else {
      rightPlayersEl.appendChild(card);
    }
  });
}

function renderState(state) {
  currentState = state;
  renderPlayers(state.players || []);
  targetRopePosition = Number.isFinite(state.ropePosition) ? state.ropePosition : 0;

  if (state.phase === "idle") {
    phaseText.textContent = "Idle: press P to start when ready";
    setOverlay("Press P to start the match", false);
  } else if (state.phase === "countdown") {
    phaseText.textContent = "Match starts in...";
    const value = state.countdownValue ?? "";
    setOverlay(String(value), true);
  } else if (state.phase === "running") {
    phaseText.textContent = "RUNNING";
    setOverlay("", false);
  } else if (state.phase === "finished") {
    phaseText.textContent = "Finished";
    const winnerText = state.winnerSide === "left" ? "Left Team Wins!" : "Right Team Wins!";
    setOverlay(winnerText, true);
  }
}

function renderMotionFrame(nowTs) {
  const dtSeconds = Math.min(0.1, Math.max(0.001, (nowTs - lastAnimTs) / 1000));
  lastAnimTs = nowTs;

  const catchUpPerSecond = 16;
  const alpha = 1 - Math.exp(-catchUpPerSecond * dtSeconds);
  displayedRopePosition += (targetRopePosition - displayedRopePosition) * alpha;

  const offsetPercent = (displayedRopePosition / 100) * 22;
  leftTeamGroup.style.transform = `translateX(calc(-50% + ${offsetPercent}%))`;
  rightTeamGroup.style.transform = `translateX(calc(-50% + ${offsetPercent}%))`;
  rope.style.transform = `translateX(${offsetPercent}%)`;

  requestAnimationFrame(renderMotionFrame);
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) {
    joinError.textContent = "Name is required.";
    return;
  }
  selectedAvatar = getSelectedAvatarFromDom();
  socket.emit("join", { name, avatarEmoji: selectedAvatar });
});

function handleAvatarPick(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest(".avatar-btn");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  selectedAvatar = button.dataset.emoji || "😎";
  const buttons = avatarPicker.querySelectorAll(".avatar-btn");
  buttons.forEach((btn) => btn.classList.remove("selected"));
  button.classList.add("selected");
}

avatarPicker.addEventListener("pointerdown", handleAvatarPick);
avatarPicker.addEventListener("click", handleAvatarPick);

window.addEventListener("keydown", (event) => {
  if (!joined) {
    return;
  }

  if (event.code === "Space") {
    event.preventDefault();
  }

  if (event.code === "KeyP") {
    socket.emit("startGame");
  }
}, { passive: false });

window.addEventListener("keyup", (event) => {
  if (!joined) {
    return;
  }

  if (event.code === "Space" && currentState?.phase === "running") {
    event.preventDefault();
    tapTimes.push(performance.now());
  }
}, { passive: false });

setInterval(() => {
  if (!joined) {
    return;
  }
  const tps = computeLocalTps();
  socket.emit("tapRateUpdate", { tps });
}, 50);

socket.on("joined", (payload) => {
  localPlayerId = payload.id;
  joined = true;
  joinModal.classList.add("hidden");
  joinModal.setAttribute("aria-hidden", "true");
});

socket.on("joinRejected", (payload) => {
  joinError.textContent = payload.reason || "Unable to join.";
});

socket.on("errorMessage", (payload) => {
  joinError.textContent = payload.message || "Error";
});

socket.on("state", (state) => {
  renderState(state);
  if (joined) {
    joinError.textContent = "";
  }
});

buildAvatarPicker();
requestAnimationFrame(renderMotionFrame);
