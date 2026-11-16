// Append-only JSON Lines log of every write call: time, tool, args, result or error, confirmation.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const SECRET = /password|secret|token|p8/i;
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? "***" : redact(x)]));
  return v;
}

export function createAudit(path) {
  return {
    write(entry) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, JSON.stringify(redact({ ts: new Date().toISOString(), ...entry })) + "\n", {
          mode: 0o600,
        });
      } catch (e) {
        console.error(`audit log write failed: ${e.message}`);
      }
    },
    tail(n = 20) {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-n)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return l;
          }
        });
    },
  };
}
