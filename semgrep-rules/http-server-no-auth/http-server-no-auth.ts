// ==========================================================================
// TRUE POSITIVES — must match
// ==========================================================================

import { createServer, IncomingMessage, ServerResponse } from "node:http";

// CORS wildcard via setHeader
// ruleid: http-server-no-auth
res.setHeader("Access-Control-Allow-Origin", "*");

// CORS wildcard via .header()
// ruleid: http-server-no-auth
res.header("Access-Control-Allow-Origin", "*");

// Headers object in Response constructor
// ruleid: http-server-no-auth
return new Response(data, {
  headers: { "Access-Control-Allow-Origin": "*" }
});

// Inside a handler
const server1 = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    // ruleid: http-server-no-auth
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({ ok: true }));
  }
);

// ==========================================================================
// TRUE NEGATIVES — must NOT match
// ==========================================================================

// Specific origin — not wildcard
// ok: http-server-no-auth
res.setHeader("Access-Control-Allow-Origin", "https://myapp.com");

// ok: http-server-no-auth
return new Response(data, {
  headers: { "Access-Control-Allow-Origin": "https://trusted.example.com" }
});

// Unrelated setHeader
// ok: http-server-no-auth
res.setHeader("Content-Type", "application/json");

// No CORS header at all
// ok: http-server-no-auth
const server2 = createServer(async (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
});
