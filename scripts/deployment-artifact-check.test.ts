import { describe, expect, it } from "vitest";
import { dockerfileCopySources, healthcheckEndpoints, productionEnvironmentFixtures, runtimeStageRunsAsNonRoot } from "./deployment-artifact-check.js";

const apiDockerfile = `FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY --from=build --chown=app:app /app/apps/api/dist ./dist
USER app
HEALTHCHECK CMD ["node", "-e", "fetch('http://127.0.0.1:4000/livez')"]`;

describe("deployment artifact checks", () => {
  it("extracts build-context COPY sources while skipping stage-internal copies and destinations", () => {
    expect(dockerfileCopySources(apiDockerfile)).toEqual(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig*.json"]);
  });

  it("detects declared healthcheck endpoints", () => {
    expect(healthcheckEndpoints(apiDockerfile)).toEqual(["/livez"]);
    expect(healthcheckEndpoints("FROM node:22\nCMD [\"node\", \"x\"]")).toEqual([]);
  });

  it("requires a non-root USER in the runtime stage only", () => {
    expect(runtimeStageRunsAsNonRoot(apiDockerfile)).toBe(true);
    expect(runtimeStageRunsAsNonRoot("FROM a AS build\nUSER app\nFROM b AS runtime\nUSER root\nCMD [\"x\"]")).toBe(false);
    expect(runtimeStageRunsAsNonRoot("FROM b AS runtime\nCMD [\"x\"]")).toBe(false);
  });

  it("provides production fixtures where SHADOW parses and LIVE must fail closed", () => {
    const fixtures = productionEnvironmentFixtures();
    expect(fixtures.shadow.EXECUTION_MODE).toBe("SHADOW");
    expect(fixtures.live.EXECUTION_MODE).toBe("LIVE");
    expect(fixtures.live.SESSION_SECRET?.length).toBeGreaterThanOrEqual(32);
    expect(fixtures.shadow.OPERATOR_PASSWORD_HASH?.startsWith("scrypt$")).toBe(true);
  });
});
