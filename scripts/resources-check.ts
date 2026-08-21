import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STAGING_DATABASE_ACKNOWLEDGEMENT = "wallet-intelligence-shadow";

const resourceVariables = [
  "DATABASE_URL",
  "STAGING_DATABASE_ACK",
  "HELIUS_API_KEY",
  "HELIUS_RPC_URL",
  "SOLANA_RPC_URL",
  "SOLANA_WS_URL",
  "JUPITER_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_USER_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "OPENROUTER_API_KEY",
  "REDIS_URL"
] as const;

type ResourceVariable = typeof resourceVariables[number];
type Presence = "PRESENT" | "ABSENT";
type DatabaseAcknowledgement = "VALID" | "INVALID" | "ABSENT";
type ResourcePath = "FULL" | "POSTGRES_ONLY" | "HELIUS_ONLY" | "BLOCKED";

export interface ResourceStatus {
  presence: Record<ResourceVariable, Presence>;
  databaseAcknowledgement: DatabaseAcknowledgement;
  telegram: "ENABLED" | "PARTIAL" | "DISABLED";
  resourcePath: ResourcePath;
  fullStagingRehearsal: "READY" | "BLOCKED";
}

const isPresent = (value: string | undefined): boolean => value !== undefined && value.trim().length > 0;

export function inspectResources(environment: Readonly<Record<string, string | undefined>>): ResourceStatus {
  const presence = Object.fromEntries(resourceVariables.map((name) => [name, isPresent(environment[name]) ? "PRESENT" : "ABSENT"])) as Record<ResourceVariable, Presence>;
  const databaseAcknowledgement: DatabaseAcknowledgement = presence.STAGING_DATABASE_ACK === "ABSENT"
    ? "ABSENT"
    : environment.STAGING_DATABASE_ACK === STAGING_DATABASE_ACKNOWLEDGEMENT ? "VALID" : "INVALID";
  const telegramCount = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_USER_ID", "TELEGRAM_WEBHOOK_SECRET"]
    .filter((name) => presence[name as ResourceVariable] === "PRESENT").length;
  const telegram = telegramCount === 0 ? "DISABLED" : telegramCount === 4 ? "ENABLED" : "PARTIAL";
  const postgresReady = presence.DATABASE_URL === "PRESENT" && databaseAcknowledgement === "VALID";
  const heliusReady = presence.HELIUS_API_KEY === "PRESENT";
  const resourcePath: ResourcePath = postgresReady && heliusReady
    ? "FULL"
    : postgresReady ? "POSTGRES_ONLY" : heliusReady ? "HELIUS_ONLY" : "BLOCKED";

  return {
    presence,
    databaseAcknowledgement,
    telegram,
    resourcePath,
    fullStagingRehearsal: resourcePath === "FULL" ? "READY" : "BLOCKED"
  };
}

export function formatResourceStatus(status: ResourceStatus): string {
  return [
    ...resourceVariables.map((name) => `${name}: ${status.presence[name]}`),
    `DATABASE_ACK: ${status.databaseAcknowledgement}`,
    `TELEGRAM: ${status.telegram}`,
    `RESOURCE_PATH: ${status.resourcePath}`,
    `FULL_STAGING_REHEARSAL: ${status.fullStagingRehearsal}`
  ].join("\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.info(formatResourceStatus(inspectResources(process.env)));
}
