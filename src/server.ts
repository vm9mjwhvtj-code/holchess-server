import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Chess } from "chess.js";
import { PrismaClient } from "@prisma/client";
import { normalizeEmail, calculateStandardElo, TimeCategory, GameOutcome } from "./utils";

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET || "holchess-dev-secret-change-in-prod";

const allowedOrigins = FRONTEND_URL.split(",").map((s) => s.trim()).filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : "*",
    methods: ["GET", "POST"],
  },
});

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : "*",
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", app: "holchess" });
});

// --- AUTH: REGISTER (Strict Single-Gmail Check) ---
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      return res.status(400).json({ error: "Email, username, and password are required." });
    }

    const cleanEmail = normalizeEmail(String(email));
    const cleanUsername = String(username).trim();

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: cleanEmail }, { username: cleanUsername }],
      },
    });

    if (existingUser) {
      return res.status(409).json({
        error:
          existingUser.email === cleanEmail
            ? "This email/Gmail is already registered on Holchess."
            : "Username is already taken.",
      });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);
    const user = await prisma.user.create({
      data: {
        email: cleanEmail,
        username: cleanUsername,
        passwordHash,
      },
    });

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        bulletElo: user.bulletElo,
        blitzElo: user.blitzElo,
        rapidElo: user.rapidElo,
      },
    });
  } catch {
    res.status(500).json({ error: "Registration failed." });
  }
});

// --- AUTH: LOGIN ---
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const cleanEmail = normalizeEmail(String(email || ""));
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } });

    if (!user || !(await bcrypt.compare(String(password || ""), user.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        bulletElo: user.bulletElo,
        blitzElo: user.blitzElo,
        rapidElo: user.rapidElo,
      },
    });
  } catch {
    res.status(500).json({ error: "Login failed." });
  }
});

// --- MATCH HISTORY ---
app.get("/api/users/:username/games", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { username: req.params.username } });
    if (!user) return res.status(404).json({ error: "Player not found." });

    const games = await prisma.game.findMany({
      where: { OR: [{ whiteId: user.id }, { blackId: user.id }] },
      include: {
        white: { select: { username: true } },
        black: { select: { username: true } },
      },
      orderBy: { playedAt: "desc" },
      take: 50,
    });

    res.json(games);
  } catch {
    res.status(500).json({ error: "Failed to load match history." });
  }
});
interface PlayerSlot {
  userId: string;
  username: string;
  socketId: string;
  elo: number;
  games: number;
  timeLeftMs: number;
}

interface ActiveRoom {
  id: string;
  chess: Chess;
  category: TimeCategory;
  timeControl: string;
  incrementMs: number;
  rated: boolean;
  white: PlayerSlot;
  black: PlayerSlot;
  lastMoveTimestamp: number;
  finished: boolean;
}

interface WaitingFriendRoom {
  code: string;
  host: Omit<PlayerSlot, "timeLeftMs">;
  category: TimeCategory;
  timeControl: string;
  baseMs: number;
  incrementMs: number;
  rated: boolean;
  hostColor: "w" | "b" | "random";
  createdAt: number;
}

const queue: Record<TimeCategory, Omit<PlayerSlot, "timeLeftMs">[]> = {
  BULLET: [],
  BLITZ: [],
  RAPID: [],
};

const activeRooms = new Map<string, ActiveRoom>();
const waitingFriendRooms = new Map<string, WaitingFriendRoom>();

function generateUniqueRoomCode(): string {
  let code = "";
  do {
    const isFiveDigits = Math.random() >= 0.5;
    const min = isFiveDigits ? 10000 : 1000;
    const max = isFiveDigits ? 99999 : 9999;
    code = Math.floor(Math.random() * (max - min + 1) + min).toString();
  } while (waitingFriendRooms.has(code) || activeRooms.has(code));
  return code;
}

// Search for a waiting friend room by 4-5 digit code
app.get("/api/rooms/:code", (req, res) => {
  const code = req.params.code.trim();
  if (!/^\d{4,5}$/.test(code)) {
    return res.status(400).json({ error: "Room code must be 4 or 5 digits." });
  }

  const room = waitingFriendRooms.get(code);
  if (!room) {
    return res.status(404).json({ error: "Room not found or match already started." });
  }

  res.json({
    code: room.code,
    hostUsername: room.host.username,
    hostElo: room.host.elo,
    category: room.category,
    timeControl: room.timeControl,
    rated: room.rated,
  });
});
async function finalizeGame(room: ActiveRoom, outcome: GameOutcome, reason: string) {
  if (room.finished) return;
  room.finished = true;

  const resultStr = outcome === 1 ? "1-0" : outcome === 0 ? "0-1" : "1/2-1/2";

  const eloResult = room.rated
    ? calculateStandardElo(
        { elo: room.white.elo, games: room.white.games },
        { elo: room.black.elo, games: room.black.games },
        outcome
      )
    : {
        whiteNewElo: room.white.elo,
        blackNewElo: room.black.elo,
        whiteDiff: 0,
        blackDiff: 0,
      };

  const eloField =
    room.category === "BULLET" ? "bulletElo" : room.category === "BLITZ" ? "blitzElo" : "rapidElo";
  const gamesField =
    room.category === "BULLET"
      ? "bulletGames"
      : room.category === "BLITZ"
      ? "blitzGames"
      : "rapidGames";

  const dbOps: any[] = [
    prisma.game.create({
      data: {
        pgn: room.chess.pgn(),
        result: resultStr,
        reason,
        category: room.category,
        timeControl: room.timeControl,
        rated: room.rated,
        whiteId: room.white.userId,
        blackId: room.black.userId,
        whiteEloStart: room.white.elo,
        blackEloStart: room.black.elo,
        whiteEloDiff: eloResult.whiteDiff,
        blackEloDiff: eloResult.blackDiff,
      },
    }),
  ];

  if (room.rated) {
    dbOps.push(
      prisma.user.update({
        where: { id: room.white.userId },
        data: { [eloField]: eloResult.whiteNewElo, [gamesField]: { increment: 1 } },
      }),
      prisma.user.update({
        where: { id: room.black.userId },
        data: { [eloField]: eloResult.blackNewElo, [gamesField]: { increment: 1 } },
      })
    );
  }

  await prisma.$transaction(dbOps);

  io.to(room.id).emit("game_over", {
    result: resultStr,
    reason,
    pgn: room.chess.pgn(),
    rated: room.rated,
    elo: eloResult,
  });

  activeRooms.delete(room.id);
}

io.on("connection", (socket) => {
  socket.on("join_queue", async ({ userId, category }: { userId: string; category: TimeCategory }) => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    const elo =
      category === "BULLET" ? user.bulletElo : category === "BLITZ" ? user.blitzElo : user.rapidElo;
    const games =
      category === "BULLET" ? user.bulletGames : category === "BLITZ" ? user.blitzGames : user.rapidGames;

    const matchIdx = queue[category].findIndex(
      (p) => p.userId !== userId && Math.abs(p.elo - elo) <= 250
    );

    if (matchIdx !== -1) {
      const opponent = queue[category].splice(matchIdx, 1)[0];
      const roomId = `hol_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const baseMs = category === "BULLET" ? 60_000 : category === "BLITZ" ? 180_000 : 600_000;
      const incrementMs = category === "BULLET" ? 0 : category === "BLITZ" ? 2_000 : 0;

      const room: ActiveRoom = {
        id: roomId,
        chess: new Chess(),
        category,
        timeControl: category === "BULLET" ? "1+0" : category === "BLITZ" ? "3+2" : "10+0",
        incrementMs,
        rated: true,
        white: { ...opponent, timeLeftMs: baseMs },
        black: {
          userId: user.id,
          username: user.username,
          socketId: socket.id,
          elo,
          games,
          timeLeftMs: baseMs,
        },
        lastMoveTimestamp: Date.now(),
        finished: false,
      };

      activeRooms.set(roomId, room);
      io.sockets.sockets.get(opponent.socketId)?.join(roomId);
      socket.join(roomId);

      io.to(roomId).emit("match_found", {
        roomId,
        fen: room.chess.fen(),
        rated: true,
        white: { username: room.white.username, elo: room.white.elo, timeLeftMs: baseMs },
        black: { username: room.black.username, elo: room.black.elo, timeLeftMs: baseMs },
      });
    } else {
      queue[category].push({
        userId: user.id,
        username: user.username,
        socketId: socket.id,
        elo,
        games,
      });
    }
  });

  socket.on("create_friend_room", async ({ userId, category, rated = true, hostColor = "random" }) => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    const elo =
      category === "BULLET" ? user.bulletElo : category === "BLITZ" ? user.blitzElo : user.rapidElo;
    const games =
      category === "BULLET" ? user.bulletGames : category === "BLITZ" ? user.blitzGames : user.rapidGames;
    const baseMs = category === "BULLET" ? 60_000 : category === "BLITZ" ? 180_000 : 600_000;
    const incrementMs = category === "BULLET" ? 0 : category === "BLITZ" ? 2_000 : 0;

    const code = generateUniqueRoomCode();
    const baseClientUrl = allowedOrigins[0] || "http://localhost:5173";

    waitingFriendRooms.set(code, {
      code,
      host: { userId: user.id, username: user.username, socketId: socket.id, elo, games },
      category,
      timeControl: category === "BULLET" ? "1+0" : category === "BLITZ" ? "3+2" : "10+0",
      baseMs,
      incrementMs,
      rated: Boolean(rated),
      hostColor,
      createdAt: Date.now(),
    });

    socket.join(code);
    socket.emit("friend_room_created", {
      code,
      shareUrl: `${baseClientUrl}/play/${code}`,
    });
  });

  socket.on("join_friend_room", async ({ code, userId }) => {
    const cleanCode = String(code || "").trim();
    const waiting = waitingFriendRooms.get(cleanCode);

    if (!waiting) {
      return socket.emit("room_error", { message: "Invalid or expired room code." });
    }
    if (waiting.host.userId === userId) {
      return socket.emit("room_error", { message: "You cannot join your own room." });
    }

    const guest = await prisma.user.findUnique({ where: { id: userId } });
    if (!guest) return;

    const guestElo =
      waiting.category === "BULLET"
        ? guest.bulletElo
        : waiting.category === "BLITZ"
        ? guest.blitzElo
        : guest.rapidElo;
    const guestGames =
      waiting.category === "BULLET"
        ? guest.bulletGames
        : waiting.category === "BLITZ"
        ? guest.blitzGames
        : guest.rapidGames;

    waitingFriendRooms.delete(cleanCode);

    const hostIsWhite =
      waiting.hostColor === "w" ||
      (waiting.hostColor === "random" && Math.random() < 0.5);

    const hostPlayer = {
      ...waiting.host,
      timeLeftMs: waiting.baseMs,
    };
    const guestPlayer = {
      userId: guest.id,
      username: guest.username,
      socketId: socket.id,
      elo: guestElo,
      games: guestGames,
      timeLeftMs: waiting.baseMs,
    };

    const room: ActiveRoom = {
      id: cleanCode,
      chess: new Chess(),
      category: waiting.category,
      timeControl: waiting.timeControl,
      incrementMs: waiting.incrementMs,
      rated: waiting.rated,
      white: hostIsWhite ? hostPlayer : guestPlayer,
      black: hostIsWhite ? guestPlayer : hostPlayer,
      lastMoveTimestamp: Date.now(),
      finished: false,
    };

    activeRooms.set(cleanCode, room);
    io.sockets.sockets.get(waiting.host.socketId)?.join(cleanCode);
    socket.join(cleanCode);

    io.to(cleanCode).emit("match_found", {
      roomId: cleanCode,
      fen: room.chess.fen(),
      rated: room.rated,
      white: { username: room.white.username, elo: room.white.elo, timeLeftMs: waiting.baseMs },
      black: { username: room.black.username, elo: room.black.elo, timeLeftMs: waiting.baseMs },
    });
  });

  socket.on("make_move", async ({ roomId, from, to, promotion }) => {
    const room = activeRooms.get(roomId);
    if (!room || room.finished) return;

    const now = Date.now();
    const elapsed = now - room.lastMoveTimestamp;
    const isWhiteTurn = room.chess.turn() === "w";

    if (isWhiteTurn) {
      room.white.timeLeftMs -= elapsed;
      if (room.white.timeLeftMs <= 0) return finalizeGame(room, 0, "timeout");
    } else {
      room.black.timeLeftMs -= elapsed;
      if (room.black.timeLeftMs <= 0) return finalizeGame(room, 1, "timeout");
    }

    const move = room.chess.move({ from, to, promotion: promotion || "q" });
    if (!move) return;

    if (isWhiteTurn) room.white.timeLeftMs += room.incrementMs;
    else room.black.timeLeftMs += room.incrementMs;
    room.lastMoveTimestamp = now;

    io.to(roomId).emit("move_made", {
      fen: room.chess.fen(),
      move,
      whiteTimeMs: room.white.timeLeftMs,
      blackTimeMs: room.black.timeLeftMs,
    });

    if (room.chess.isCheckmate()) {
      await finalizeGame(room, isWhiteTurn ? 1 : 0, "checkmate");
    } else if (room.chess.isDraw()) {
      await finalizeGame(room, 0.5, "draw");
    }
  });

  socket.on("resign", async ({ roomId, userId }) => {
    const room = activeRooms.get(roomId);
    if (!room || room.finished) return;
    const outcome: GameOutcome = room.white.userId === userId ? 0 : 1;
    await finalizeGame(room, outcome, "resignation");
  });

  socket.on("disconnect", () => {
    for (const cat of Object.keys(queue) as TimeCategory[]) {
      queue[cat] = queue[cat].filter((p) => p.socketId !== socket.id);
    }
    for (const [code, room] of waitingFriendRooms.entries()) {
      if (room.host.socketId === socket.id) {
        waitingFriendRooms.delete(code);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Holchess server running on http://localhost:${PORT}`);
});
