/**
 * Property-based tests proving that ToolDispatcher.call() passes arbitrary
 * JSON payloads to tool functions without schema validation.
 *
 * These tests demonstrate that:
 * 1. Any JSON-serializable value reaches the tool function unchanged
 * 2. Extra keys beyond the schema pass through unstripped
 * 3. Wrong types for schema-defined fields are never rejected
 * 4. Missing required fields produce no error from the dispatch layer
 * 5. Prototype-chain property names on the fns object are not guarded
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { z } from "zod";
import { ToolDispatcher } from "../executor";

type ToolFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A Zod schema representing a typical tool contract. */
const weatherSchema = z.object({
  location: z.string(),
  units: z.enum(["celsius", "fahrenheit"]).optional()
});

/** Create a ToolDispatcher with a single spy tool. */
function setup() {
  const received: unknown[] = [];
  const spy = vi.fn(async (args: unknown) => {
    received.push(args);
    return { ok: true };
  });
  const fns: ToolFns = { getWeather: spy };
  const dispatcher = new ToolDispatcher(fns);
  return { dispatcher, spy, received };
}

// ---------------------------------------------------------------------------
// Property 1: Arbitrary JSON reaches the tool function unchanged
// ---------------------------------------------------------------------------

describe("ToolDispatcher schema bypass — property tests", () => {
  it("any JSON-serializable value reaches the tool function unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (arbitraryValue) => {
        const { dispatcher, spy } = setup();

        const argsJson = JSON.stringify(arbitraryValue);
        const resJson = await dispatcher.call("getWeather", argsJson);
        const res = JSON.parse(resJson);

        // The dispatch should succeed (not return an error)
        expect(res.error).toBeUndefined();

        // The tool function should have been called with the raw parsed value
        expect(spy).toHaveBeenCalledTimes(1);
        const receivedArg = spy.mock.calls[0][0];

        // The received argument should be identical to what JSON.parse produces
        expect(receivedArg).toEqual(JSON.parse(argsJson));
      }),
      { numRuns: 200 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 2: Extra keys beyond the schema are never stripped
  // ---------------------------------------------------------------------------

  it("extra keys beyond the Zod schema pass through unstripped", async () => {
    const extraKeyArb = fc.record({
      // Valid schema fields
      location: fc.string(),
      // Extra fields that a schema-validating dispatcher would strip
      isAdmin: fc.boolean(),
      __proto__: fc.jsonValue(),
      constructor: fc.jsonValue(),
      extraNested: fc.dictionary(fc.string(), fc.jsonValue())
    });

    await fc.assert(
      fc.asyncProperty(extraKeyArb, async (payload) => {
        const { dispatcher, spy } = setup();

        const resJson = await dispatcher.call(
          "getWeather",
          JSON.stringify(payload)
        );
        const res = JSON.parse(resJson);

        expect(res.error).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);

        const received = spy.mock.calls[0][0] as Record<string, unknown>;

        // All extra keys survive — nothing was stripped
        // (A validating dispatcher would strip unknown keys via z.object().strict() or .strip())
        expect(received).toHaveProperty("isAdmin");
        expect(received).toHaveProperty("extraNested");
      }),
      { numRuns: 100 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 3: Wrong types for schema-defined fields are never rejected
  // ---------------------------------------------------------------------------

  it("wrong types for schema fields are never rejected", async () => {
    // Generate payloads where 'location' is NOT a string (violating the schema)
    const wrongTypeArb = fc.record({
      location: fc.oneof(
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.array(fc.integer()),
        fc.dictionary(fc.string(), fc.string())
      ),
      units: fc.oneof(
        fc.integer(), // should be "celsius" | "fahrenheit"
        fc.constant("invalid_unit"),
        fc.array(fc.string())
      )
    });

    await fc.assert(
      fc.asyncProperty(wrongTypeArb, async (payload) => {
        const { dispatcher, spy } = setup();

        const resJson = await dispatcher.call(
          "getWeather",
          JSON.stringify(payload)
        );
        const res = JSON.parse(resJson);

        // No validation error — dispatch succeeds despite type violations
        expect(res.error).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);

        // The wrong-typed values arrive at the tool function as-is
        const received = spy.mock.calls[0][0] as Record<string, unknown>;
        expect(received.location).toEqual(payload.location);
        expect(received.units).toEqual(payload.units);

        // Verify the schema would actually reject these
        const validation = weatherSchema.safeParse(payload);
        expect(validation.success).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 4: Missing required fields produce no dispatch-layer error
  // ---------------------------------------------------------------------------

  it("missing required fields produce no error from dispatcher", async () => {
    // Generate objects that are missing the required 'location' field
    const missingFieldArb = fc.oneof(
      fc.constant({}),
      fc.record({ units: fc.constant("celsius") }),
      fc.record({ unrelated: fc.jsonValue() })
    );

    await fc.assert(
      fc.asyncProperty(missingFieldArb, async (payload) => {
        const { dispatcher, spy } = setup();

        const resJson = await dispatcher.call(
          "getWeather",
          JSON.stringify(payload)
        );
        const res = JSON.parse(resJson);

        // No validation error — required field 'location' is missing but dispatcher doesn't check
        expect(res.error).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);

        const received = spy.mock.calls[0][0] as Record<string, unknown>;

        // 'location' is undefined in the received args — no error, no default
        expect(received.location).toBeUndefined();

        // Confirm the schema would reject this
        const validation = weatherSchema.safeParse(payload);
        expect(validation.success).toBe(false);
      }),
      { numRuns: 50 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 5: Non-JSON-object payloads (arrays, strings, numbers, booleans)
  //             pass through where schemas expect objects
  // ---------------------------------------------------------------------------

  it("non-object JSON values pass through when schema expects an object", async () => {
    const nonObjectArb = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.double({ noNaN: true }),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.jsonValue())
    );

    await fc.assert(
      fc.asyncProperty(nonObjectArb, async (payload) => {
        const { dispatcher, spy } = setup();

        const resJson = await dispatcher.call(
          "getWeather",
          JSON.stringify(payload)
        );
        const res = JSON.parse(resJson);

        // Dispatch succeeds — tool receives a string/number/array/etc where it expects {location: string}
        expect(res.error).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);

        const received = spy.mock.calls[0][0];
        expect(received).toEqual(payload);

        // Schema would reject all of these
        const validation = weatherSchema.safeParse(payload);
        expect(validation.success).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 6: Prototype chain keys on fns object are not guarded
  // ---------------------------------------------------------------------------

  it("prototype-chain property names bypass the tool-not-found guard", async () => {
    const protoNames = ["constructor", "toString", "valueOf", "hasOwnProperty"];

    for (const name of protoNames) {
      const dispatcher = new ToolDispatcher({}); // empty fns

      const resJson = await dispatcher.call(name, "{}");
      const res = JSON.parse(resJson);

      // These names resolve to Object.prototype methods via prototype chain.
      // 'constructor' is a function (Object), so it passes the `if (!fn)` guard
      // and gets invoked instead of returning "tool not found".
      if (name === "constructor") {
        // Object({}) returns {}, so it "succeeds" — no tool-not-found error
        expect(res.error).toBeUndefined();
        expect(res.result).toEqual({});
      }
      // Other prototype methods may throw when called with wrong `this`,
      // which is caught by the try/catch — still not a clean "tool not found"
    }
  });

  // ---------------------------------------------------------------------------
  // Property 7: Roundtrip invariant — anything JSON.parse produces is accepted
  // ---------------------------------------------------------------------------

  it("for all valid JSON strings, dispatcher accepts the parsed result", async () => {
    // Generate arbitrary JSON strings (not values, but their serialized form)
    const jsonStringArb = fc.jsonValue().map((v) => JSON.stringify(v));

    await fc.assert(
      fc.asyncProperty(jsonStringArb, async (jsonStr) => {
        const { dispatcher, spy } = setup();

        const resJson = await dispatcher.call("getWeather", jsonStr);
        const res = JSON.parse(resJson);

        // Never fails — dispatcher has no concept of invalid tool input
        expect(res.error).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 200 }
    );
  });

  // ---------------------------------------------------------------------------
  // Property 8: Schema validation would catch what the dispatcher misses
  // ---------------------------------------------------------------------------

  it("demonstrates the gap: schema rejects what dispatcher accepts", async () => {
    let dispatcherAccepted = 0;
    let schemaRejected = 0;

    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (payload) => {
        const { dispatcher, spy } = setup();

        const resJson = await dispatcher.call(
          "getWeather",
          JSON.stringify(payload)
        );
        const res = JSON.parse(resJson);

        if (!res.error && spy.mock.calls.length > 0) {
          dispatcherAccepted++;
        }

        const validation = weatherSchema.safeParse(payload);
        if (!validation.success) {
          schemaRejected++;
        }
      }),
      { numRuns: 500 }
    );

    // The dispatcher accepts everything; the schema rejects most random inputs
    expect(dispatcherAccepted).toBe(500);
    // With random JSON, virtually none will match { location: string }
    expect(schemaRejected).toBeGreaterThan(490);
  });
});
