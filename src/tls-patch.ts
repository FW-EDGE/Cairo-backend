/**
 * TLS patch for Windows dev environments.
 *
 * Node.js ships its own CA bundle and does NOT use the Windows certificate store.
 * Google APIs (googleapis, gaxios) and MongoDB Atlas use intermediate CAs
 * (Google Trust Services, Let's Encrypt ISRG Root X1) that are often missing
 * from Node.js's bundled store on Windows.
 *
 * Fix: replace https.Agent with a patched version that always sets
 * rejectUnauthorized=false so every HTTPS connection in the process bypasses
 * leaf-cert verification — including the agents gaxios creates internally.
 *
 * This file must be the FIRST import in index.ts so the patch is applied
 * before any other module makes an HTTPS connection.
 */
import https from "node:https";

const OrigAgent = https.Agent as any;

// Subclass that forces rejectUnauthorized=false unless explicitly set to true
class PatchedAgent extends OrigAgent {
  constructor(options: Record<string, unknown> = {}) {
    if (options.rejectUnauthorized !== true) {
      options.rejectUnauthorized = false;
    }
    super(options);
  }
}

// Replace the constructor so every `new https.Agent(...)` call gets the patch
(https as any).Agent = PatchedAgent;

// Also patch the global agent that some libs use as a fallback
https.globalAgent = new PatchedAgent({ keepAlive: false });

// Belt-and-suspenders: set the env var too (covers native http2 and similar)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
