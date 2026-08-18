// Resolve hook for node:test over TS sources: the project uses extensionless
// relative imports ("./store"), which Next/tsc resolve but bare Node ESM does
// not. This hook retries any failed relative resolution with ".ts" appended.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      if (err && err.code === "ERR_MODULE_NOT_FOUND") {
        try {
          return await nextResolve(specifier + ".ts", context);
        } catch {
          /* fall through to the original error */
        }
      }
      throw err;
    }
  }
  return nextResolve(specifier, context);
}