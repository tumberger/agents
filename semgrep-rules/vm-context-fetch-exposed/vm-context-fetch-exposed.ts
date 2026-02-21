// ==========================================================================
// TRUE POSITIVES — must match
// ==========================================================================

import * as vm from "node:vm";

// Direct fetch exposure with value
// ruleid: vm-context-fetch-exposed
const ctx1 = vm.createContext({
  console: { log: console.log },
  fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout
});

// fetch as shorthand property
// ruleid: vm-context-fetch-exposed
const ctx2 = vm.createContext({
  fetch,
  URL
});

// fetch from variable
const myFetch = globalThis.fetch;
// ruleid: vm-context-fetch-exposed
const ctx3 = vm.createContext({
  fetch: myFetch
});

// ==========================================================================
// TRUE NEGATIVES — must NOT match
// ==========================================================================

// No fetch in context — safe
// ok: vm-context-fetch-exposed
const safeCtx = vm.createContext({
  console: { log: console.log },
  setTimeout: globalThis.setTimeout
});

// Empty context
// ok: vm-context-fetch-exposed
const emptyCtx = vm.createContext({});

// Fetch used outside of vm.createContext
// ok: vm-context-fetch-exposed
const data = await fetch("https://api.example.com/data");
const result = await data.json();

// Indirect via sandbox variable (known limitation — rule only
// detects inline object literals, not variable references)
// ok: vm-context-fetch-exposed
const sandbox = {
  fetch: globalThis.fetch,
  Request,
  Response
};
vm.createContext(sandbox);
