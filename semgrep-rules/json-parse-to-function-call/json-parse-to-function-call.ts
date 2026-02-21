// ==========================================================================
// TRUE POSITIVES — taint mode reports at SINK line
// ==========================================================================

// Simple: parse then call
const args1 = JSON.parse(body);
// ruleid: json-parse-to-function-call
fn(args1);

// Await variant
const data = JSON.parse(argsJson);
// ruleid: json-parse-to-function-call
const result = await fn(data);

// Different variable names
const toolArgs = JSON.parse(rawText);
// ruleid: json-parse-to-function-call
await toolFn(toolArgs);

// Inline parse-to-call (source inside sink — taint mode does not
// detect this because the source is a subexpression of the sink argument)
// ok: json-parse-to-function-call
execute(JSON.parse(payload));

// Nested in try/catch
function handleCallback() {
  try {
    const args = JSON.parse(requestBody);
    // ruleid: json-parse-to-function-call
    return callback(args);
  } catch (e) {
    return { error: e };
  }
}

// Multiple statements between source and sink
const rawData = JSON.parse(responseBody);
const extracted = rawData;
// ruleid: json-parse-to-function-call
processData(extracted);

// ==========================================================================
// TRUE NEGATIVES — must NOT match
// ==========================================================================

// Schema validation with Zod .parse()
const raw = JSON.parse(body);
const validated = schema.parse(raw);
// ok: json-parse-to-function-call
fn(validated);

// Schema validation with Zod .safeParse()
const input = JSON.parse(text);
const check = schema.safeParse(input);
// ok: json-parse-to-function-call
if (check.success) fn(check.data);

// Logging only — not a dangerous sink
const logData = JSON.parse(msg);
// ok: json-parse-to-function-call
console.log(logData);

// JSON.stringify — not a dangerous sink
const obj = JSON.parse(str);
// ok: json-parse-to-function-call
JSON.stringify(obj);

// Parsed data used for property access only (no function call)
const config = JSON.parse(configStr);
// ok: json-parse-to-function-call
const name = config.name;
