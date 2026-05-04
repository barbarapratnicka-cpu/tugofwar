const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const TICK_RATE_HZ = 25;
const STATE_BROADCAST_MS = 1000 / TICK_RATE_HZ;
const MAX_POSITION = 100;
const WIN_POSITION = 90;
const RATIO_ACCEL_SCALE = 45;
const ACTIVITY_SCALE = 0.7;
const VELOCITY_DECAY_PER_SECOND = 0.35;
const MAX_VELOCITY = 35;
const FINISH_HOLD_MS = 4000;
const FULL_INFLUENCE_SECONDS = 30;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const players = new Map();
let joinSequence = 0;

const gameState = {
  phase: "idle",
  joinLocked: false,
  countdownValue: null,
  ropePosition: 0,
  ropeVelocity: 0,
  winnerSide: null,
  leftAvgTps: 0,
  rightAvgTps: 0,
  lastTickTs: Date.now(),
  runningStartedAt: null
};

let tickInterval = null;
let finishTimeout = null;

function getSideByJoinOrder() {
  joinSequence += 1;
  return joinSequence % 2 === 1 ? "left" : "right";
}

function getPublicPlayers() {
  return Array.from(players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    avatarEmoji: p.avatarEmoji,
    side: p.side,
    tps: p.tps
  }));
}

function sanitizeAvatarEmoji(value) {
  if (typeof value !== "string") {
    return "😎";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "😎";
  }
  return trimmed;
}

function buildSnapshot() {
  return {
    phase: gameState.phase,
    joinLocked: gameState.joinLocked,
    countdownValue: gameState.countdownValue,
    ropePosition: gameState.ropePosition,
    ropeVelocity: gameState.ropeVelocity,
    winnerSide: gameState.winnerSide,
    leftAvgTps: gameState.leftAvgTps,
    rightAvgTps: gameState.rightAvgTps,
    players: getPublicPlayers()
  };
}

function emitState() {
  io.emit("state", buildSnapshot());
}

function getTeamAverageTps(side) {
  const sidePlayers = Array.from(players.values()).filter((p) => p.side === side);
  if (sidePlayers.length === 0) {
    return 0;
  }
  const total = sidePlayers.reduce((sum, p) => sum + (Number.isFinite(p.tps) ? p.tps : 0), 0);
  return total / sidePlayers.length;
}

function stopTickLoop() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function scheduleResetAfterFinish() {
  if (finishTimeout) {
    clearTimeout(finishTimeout);
  }
  finishTimeout = setTimeout(() => {
    gameState.phase = "idle";
    gameState.joinLocked = false;
    gameState.countdownValue = null;
    gameState.winnerSide = null;
    gameState.ropePosition = 0;
    gameState.ropeVelocity = 0;
    gameState.leftAvgTps = 0;
    gameState.rightAvgTps = 0;
    gameState.runningStartedAt = null;
    for (const player of players.values()) {
      player.tps = 0;
    }
    emitState();
  }, FINISH_HOLD_MS);
}

function finishGame(winnerSide) {
  gameState.phase = "finished";
  gameState.winnerSide = winnerSide;
  gameState.countdownValue = null;
  gameState.joinLocked = true;
  gameState.ropeVelocity = 0;
  stopTickLoop();
  emitState();
  scheduleResetAfterFinish();
}

function tickGame() {
  if (gameState.phase !== "running") {
    return;
  }

  const now = Date.now();
  const dt = Math.max(0.001, (now - gameState.lastTickTs) / 1000);
  gameState.lastTickTs = now;

  gameState.leftAvgTps = getTeamAverageTps("left");
  gameState.rightAvgTps = getTeamAverageTps("right");

  const left = gameState.leftAvgTps;
  const right = gameState.rightAvgTps;
  const totalTps = left + right;
  const signedRatio = totalTps > 0 ? (left - right) / totalTps : 0;
  const activityFactor = Math.min(8, totalTps * ACTIVITY_SCALE);
  const elapsedSeconds = gameState.runningStartedAt
    ? Math.max(0, (now - gameState.runningStartedAt) / 1000)
    : 0;
  const normalizedTime = Math.min(1, elapsedSeconds / FULL_INFLUENCE_SECONDS);
  const timeWeight = Math.pow(normalizedTime, 2);
  const acceleration = -signedRatio * activityFactor * RATIO_ACCEL_SCALE * timeWeight;

  gameState.ropeVelocity += acceleration * dt;
  const velocityDecay = Math.pow(VELOCITY_DECAY_PER_SECOND, dt);
  gameState.ropeVelocity *= velocityDecay;
  gameState.ropeVelocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, gameState.ropeVelocity));

  gameState.ropePosition += gameState.ropeVelocity * dt;
  gameState.ropePosition = Math.max(-MAX_POSITION, Math.min(MAX_POSITION, gameState.ropePosition));

  if (gameState.ropePosition <= -WIN_POSITION) {
    finishGame("left");
    return;
  }
  if (gameState.ropePosition >= WIN_POSITION) {
    finishGame("right");
    return;
  }

  emitState();
}

function startTickLoop() {
  stopTickLoop();
  gameState.lastTickTs = Date.now();
  tickInterval = setInterval(tickGame, STATE_BROADCAST_MS);
}

function sideHasPlayers(side) {
  for (const player of players.values()) {
    if (player.side === side) {
      return true;
    }
  }
  return false;
}

function countDownThenRun() {
  gameState.phase = "countdown";
  gameState.joinLocked = true;
  gameState.countdownValue = 3;
  gameState.winnerSide = null;
  gameState.ropePosition = 0;
  gameState.ropeVelocity = 0;
  gameState.runningStartedAt = null;
  for (const player of players.values()) {
    player.tps = 0;
  }
  emitState();

  const steps = [2, 1, "GO"];
  let idx = 0;
  const countdownTimer = setInterval(() => {
    if (idx >= steps.length) {
      clearInterval(countdownTimer);
      gameState.phase = "running";
      gameState.countdownValue = null;
      gameState.lastTickTs = Date.now();
      gameState.runningStartedAt = Date.now();
      emitState();
      startTickLoop();
      return;
    }

    gameState.countdownValue = steps[idx];
    idx += 1;
    emitState();
  }, 1000);
}

io.on("connection", (socket) => {
  socket.emit("state", buildSnapshot());

  socket.on("join", (payload) => {
    if (gameState.joinLocked) {
      socket.emit("joinRejected", { reason: "A match is in progress. Wait for the next round." });
      return;
    }

    const name = typeof payload?.name === "string" ? payload.name.trim() : "";
    if (!name) {
      socket.emit("errorMessage", { message: "Name is required." });
      return;
    }

    const side = getSideByJoinOrder();
    const avatarEmoji = sanitizeAvatarEmoji(payload?.avatarEmoji);

    players.set(socket.id, {
      id: socket.id,
      name,
      side,
      avatarEmoji,
      tps: 0
    });

    socket.emit("joined", { id: socket.id, side, avatarEmoji });
    emitState();
  });

  socket.on("tapRateUpdate", (payload) => {
    const player = players.get(socket.id);
    if (!player) {
      return;
    }
    const tps = Number(payload?.tps);
    player.tps = Number.isFinite(tps) ? Math.max(0, Math.min(30, tps)) : 0;
  });

  socket.on("startGame", () => {
    if (gameState.phase !== "idle") {
      return;
    }
    if (players.size < 2) {
      socket.emit("errorMessage", { message: "Need at least 2 players to start." });
      return;
    }
    if (!sideHasPlayers("left") || !sideHasPlayers("right")) {
      socket.emit("errorMessage", { message: "Need at least one player per side." });
      return;
    }
    countDownThenRun();
  });

  socket.on("disconnect", () => {
    const player = players.get(socket.id);
    if (!player) {
      return;
    }
    const side = player.side;
    players.delete(socket.id);

    if (gameState.phase === "running" && !sideHasPlayers(side)) {
      const winner = side === "left" ? "right" : "left";
      finishGame(winner);
      return;
    }

    emitState();
  });
});

server.listen(PORT, () => {
  console.log(`TugOfWar listening on http://localhost:${PORT}`);
});
