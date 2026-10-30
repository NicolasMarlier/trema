// Pending env changes -> summary (+ added, ~ changed, − removed). Pure.

export type EnvChange =
  | { kind: "add"; key: string; value: string }
  | { kind: "change"; key: string; value: string }
  | { kind: "remove"; key: string };

export type EnvDraft = {
  /** Keys that exist on the server. */
  original: string[];
  /** Values the user typed (key -> value). Only edited / added keys. */
  edited: Record<string, string>;
  /** Keys marked for removal. */
  removed: string[];
};

export function diffEnv({ original, edited, removed }: EnvDraft): EnvChange[] {
  const known = new Set(original);
  const gone = new Set(removed);
  const out: EnvChange[] = [];
  for (const [key, value] of Object.entries(edited)) {
    if (gone.has(key) || !key) continue;
    out.push(known.has(key) ? { kind: "change", key, value } : { kind: "add", key, value });
  }
  for (const key of removed) if (known.has(key)) out.push({ kind: "remove", key });
  return out;
}

/** Build the PATCH body: only the diff travels over the wire. */
export function toPatch(changes: EnvChange[]): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const c of changes) {
    if (c.kind === "remove") unset.push(c.key);
    else set[c.key] = c.value;
  }
  return { set, unset };
}

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
