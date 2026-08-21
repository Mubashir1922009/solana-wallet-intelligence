export function rawPayloadRetentionMode(arguments_: readonly string[]): "DRY_RUN" | "APPLIED" { return arguments_.includes("--apply") ? "APPLIED" : "DRY_RUN"; }
