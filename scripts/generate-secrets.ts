import { randomBytes } from "node:crypto";
import process from "node:process";
import { hashPassword } from "../apps/api/src/auth.js";
async function main(): Promise<void> {
const command = process.argv[2];
if (command === "session") console.info(randomBytes(48).toString("base64url"));
else if (command === "telegram-webhook") console.info(randomBytes(32).toString("base64url"));
else if (command === "password-hash") { const password = await hidden("Operator password: "); try { console.info(await hashPassword(password)); } finally { password.fill(0); } }
else throw new Error("Usage: pnpm secrets:generate <session|telegram-webhook|password-hash>");
async function hidden(prompt: string): Promise<Buffer> { if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") throw new Error("Password hashing requires an interactive TTY"); process.stdout.write(prompt); process.stdin.setRawMode(true); process.stdin.resume(); const bytes: number[] = []; return await new Promise((resolve, reject) => { const onData = (chunk: Buffer) => { for (const value of chunk) { if (value === 3) { cleanup(); reject(new Error("Cancelled")); return; } if (value === 13 || value === 10) { cleanup(); process.stdout.write("\n"); resolve(Buffer.from(bytes)); return; } if (value === 127 || value === 8) bytes.pop(); else if (value >= 32) bytes.push(value); } }; const cleanup = () => { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); }; process.stdin.on("data", onData); }); }
}
void main();
