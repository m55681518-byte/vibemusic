// Entry: register the resolve hook used by `npm test`.
// Usage: node --import ./tests/loader.mjs --test "tests/*.test.mjs"
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);