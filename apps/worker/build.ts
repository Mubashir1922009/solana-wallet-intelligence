import { build } from "tsup";

async function main(): Promise<void> {
  await build({ config: false, entry: ["././src/main.ts"], format: ["esm"], platform: "node", target: "node22", outDir: "dist", clean: true, sourcemap: true, noExternal: ["@intelligence/core", "@intelligence/database", "@intelligence/providers", "@intelligence/config", "@intelligence/shared"] });
}
void main();
