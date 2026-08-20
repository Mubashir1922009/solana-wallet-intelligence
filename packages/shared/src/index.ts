import { createHash, randomUUID } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function newId(): string {
  return randomUUID();
}

export function stableHash(value: JsonValue): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function redactSecret(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : "[REDACTED]";
}
