// TLS fix: Windows lacks intermediate CAs for Google APIs and MongoDB Atlas
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

process.on("uncaughtException", (err) => {
  console.error("[CAIRO] UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CAIRO] UNHANDLED REJECTION:", reason);
});

import express from "express";
import cors from "cors";
import http from "http";
import cookieParser from "cookie-parser";
import { WebSocketServer } from "ws";
import { getConfig } from "./config.js";
import { ensureIndexes } from "./db/oauthStates.js";
import { startHeartbeatMonitor, cairoState, connectedClients } from "./websocket.js";
import { startScheduler } from "./services/scheduler.js";
import authRouter from "./routes/auth.js";
import stateRouter from "./routes/state.js";
import calendarRouter from "./routes/calendar.js";
import driveRouter from "./routes/drive.js";
import mailRouter from "./routes/mail.js";
import chatRouter from "./routes/chat.js";
import embeddingsRouter from "./routes/embeddings.js";
import vectorMapRouter from "./routes/vectorMap.js";
import skillsRouter from "./routes/skills.js";

const config = getConfig();
console.log("[CAIRO] FRONTEND_URL env:", process.env.FRONTEND_URL);

const app = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────────────────────
// origin:true reflects the exact request Origin back, works for any domain
const corsOptions: cors.CorsOptions = {
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  maxAge: 86400,
};
app.options("*", cors(corsOptions)); // handle ALL preflight requests first
app.use(cors(corsOptions));          // attach CORS headers to every response

app.use(cookieParser());
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(authRouter);
app.use(stateRouter);
app.use(calendarRouter);
app.use(driveRouter);
app.use(mailRouter);
app.use(chatRouter);
app.use(embeddingsRouter);
app.use(vectorMapRouter);
app.use(skillsRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "express-v1" });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  try {
    ws.send(JSON.stringify({ type: "state", ...cairoState }));
    connectedClients.add(ws);
    ws.on("close", () => connectedClients.delete(ws));
    ws.on("error", (err) => {
      console.error("[WS] Client error:", err);
      connectedClients.delete(ws);
    });
  } catch (err) {
    console.error("[WS] Connection handler error:", err);
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "7777", 10);

  // Listen first — Railway health check must succeed quickly
  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      console.log(`[CAIRO] Listening on http://0.0.0.0:${port}`);
      resolve();
    });
  });

  // MongoDB + background services (non-fatal if slow)
  try {
    await ensureIndexes();
    startHeartbeatMonitor();
    startScheduler();
    console.log("[CAIRO] All services started");
  } catch (err) {
    console.error("[CAIRO] Post-listen startup error:", err);
    // Don't exit — server is still listening, DB will reconnect
  }
}

// Graceful shutdown
["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    console.log(`[CAIRO] Received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
  });
});

start();
