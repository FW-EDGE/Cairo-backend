// TLS fix: Windows lacks intermediate CAs for Google APIs and MongoDB Atlas
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Catch any crash and print it before dying — helps diagnose silent ECONNRESET crashes
process.on("uncaughtException", (err) => {
  console.error("[CAIRO] UNCAUGHT EXCEPTION:", err);
  // Don't exit — let Railway keep the process alive so it can serve requests.
  // Fastify's own error boundary handles route errors; only truly unrecoverable
  // errors (EADDRINUSE, etc.) should kill the process.
});
process.on("unhandledRejection", (reason) => {
  // Log but don't exit — an unhandled rejection in one async chain shouldn't
  // take down the whole server and cause a Railway restart loop.
  console.error("[CAIRO] UNHANDLED REJECTION:", reason);
});

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import fastifyWebSocket from "@fastify/websocket";
import { getConfig } from "./config.js";
import { ensureIndexes } from "./db/oauthStates.js";
import { startHeartbeatMonitor } from "./websocket.js";
import { startScheduler } from "./services/scheduler.js";
import { authRoutes } from "./routes/auth.js";
import { stateRoutes } from "./routes/state.js";
import { calendarRoutes } from "./routes/calendar.js";
import { driveRoutes } from "./routes/drive.js";
import { mailRoutes } from "./routes/mail.js";
import { chatRoutes } from "./routes/chat.js";
import { embeddingsRoutes } from "./routes/embeddings.js";
import { vectorMapRoutes } from "./routes/vectorMap.js";
import { skillsRoutes } from "./routes/skills.js";

const config = getConfig();

const fastify = Fastify({
  logger: {
    level: "info",
  },
  disableRequestLogging: true,
});

// Register plugins
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  config.auth.frontend_url.replace(/\/$/, ""),
];
console.log("[CAIRO] CORS allowed origins:", allowedOrigins);

await fastify.register(fastifyCors, {
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  preflightContinue: false,
  optionsSuccessStatus: 204,
});

await fastify.register(fastifyCookie);
await fastify.register(fastifyWebSocket);

// Register routes
await fastify.register(authRoutes);
await fastify.register(stateRoutes);
await fastify.register(calendarRoutes);
await fastify.register(driveRoutes);
await fastify.register(mailRoutes);
await fastify.register(chatRoutes);
await fastify.register(embeddingsRoutes);
await fastify.register(vectorMapRoutes);
await fastify.register(skillsRoutes);

// Health check
fastify.get("/health", async () => ({ status: "ok", version: "1.0.0" }));

// Startup
async function start(): Promise<void> {
  try {
    await ensureIndexes();
    startHeartbeatMonitor();
    startScheduler();
    const port = parseInt(process.env.PORT ?? "7777", 10);
    await fastify.listen({ port, host: "0.0.0.0" });
    console.log(`[CAIRO] Backend running on http://0.0.0.0:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, async () => {
    console.log(`[CAIRO] Received ${signal}, shutting down...`);
    await fastify.close();
    process.exit(0);
  });
});

start();
