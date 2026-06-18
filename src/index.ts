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
import { google } from "googleapis";
import { getConfig } from "./config.js";
import { ensureIndexes } from "./db/oauthStates.js";
import { startHeartbeatMonitor, cairoState, connectedClients } from "./websocket.js";
import { startScheduler } from "./services/scheduler.js";
import { ensureJobIndexes, startIndexWorker } from "./services/indexingQueue.js";
import authRouter from "./routes/auth.js";
import stateRouter from "./routes/state.js";
import calendarRouter from "./routes/calendar.js";
import driveRouter from "./routes/drive.js";
import mailRouter from "./routes/mail.js";
import chatRouter from "./routes/chat.js";
import embeddingsRouter from "./routes/embeddings.js";
import vectorMapRouter from "./routes/vectorMap.js";
import skillsRouter from "./routes/skills.js";
import adminRouter from "./routes/admin.js";
import semanticGraphRouter from "./routes/semanticGraph.js";
import teamRouter from "./routes/team.js";
import pmRouter from "./routes/pm.js";

// Render free tier drops gzip streams mid-transfer (ERR_STREAM_PREMATURE_CLOSE).
// Setting identity encoding globally prevents googleapis from requesting compressed responses.
google.options({ headers: { 'Accept-Encoding': 'identity' } });

// Validate config at startup — log clearly but don't crash so the WS/health endpoints stay up
let _startupConfigOk = false;
try {
  getConfig();
  _startupConfigOk = true;
} catch (err: any) {
  console.error("[CAIRO] ⚠️  CONFIG ERROR — missing env var:", err.message);
  console.error("[CAIRO] The server will start but routes requiring this config will fail.");
}
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
app.use(semanticGraphRouter);
app.use(teamRouter);
app.use(pmRouter);

// Health check — also reports missing env vars so Render logs show the problem clearly
app.get("/health", (_req, res) => {
  const required = [
    "MONGODB_URI", "MONGODB_DATABASE", "JWT_SECRET",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
    "OPENAI_API_KEY",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error("[CAIRO] /health — missing env vars:", missing.join(", "));
    res.status(500).json({ status: "misconfigured", missing });
    return;
  }
  res.json({ status: "ok", version: "express-v1", config: _startupConfigOk });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

// Ping all clients every 30 s — prevents Render's 90-second idle-connection kill
const wsPingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if ((ws as any)._cairoAlive === false) {
      ws.terminate();
      return;
    }
    (ws as any)._cairoAlive = false;
    ws.ping();
  });
}, 30_000);
wss.on("close", () => clearInterval(wsPingInterval));

wss.on("connection", (ws) => {
  try {
    (ws as any)._cairoAlive = true;
    ws.on("pong", () => { (ws as any)._cairoAlive = true; });

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
    await ensureJobIndexes();
    startHeartbeatMonitor();
    startScheduler();
    startIndexWorker();
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
