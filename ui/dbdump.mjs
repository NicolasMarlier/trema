// Pure helpers for database dumps (T-18): file names, format detection, restore plan and shell scripts.
export const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB (Q6)
export const EXTENSIONS = ["dump", "sql", "sql.gz"];
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(dump|sql|sql\.gz)$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Local timestamp "YYYY-MM-DDTHHMMSS" used in dump names (sorts lexicographically). */
export function dumpStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** trema-<app>-<stamp>[-pre-restore|-upload].<ext> */
export function dumpFileName(app, stamp, kind = "manual", ext = "dump") {
  const suffix = kind === "pre-restore" ? "-pre-restore" : kind === "upload" ? "-upload" : "";
  return `trema-${app}-${stamp}${suffix}.${ext}`;
}

/** Safe plain file name (no path, no traversal). */
export function isValidDumpFile(name) {
  return typeof name === "string" && FILE_RE.test(name) && !name.includes("..");
}

/** Describes a file of /db_dumps if it is a dump of `app`, else null. */
export function parseDumpFile(app, file) {
  if (!isValidDumpFile(file)) return null;
  const m = file.match(new RegExp(`^trema-${escapeRe(app)}-(\\d{4}-\\d{2}-\\d{2}T\\d{4,6})(-pre-restore|-upload)?\\.(dump|sql|sql\\.gz)$`));
  if (!m) return null;
  return { file, stamp: m[1], origin: m[2] === "-pre-restore" ? "pre-restore" : m[2] === "-upload" ? "upload" : "manual", ext: m[3] };
}

/** Extension to keep from an uploaded file name (null = unsupported). */
export function uploadExt(name) {
  const n = String(name ?? "").toLowerCase();
  return n.endsWith(".sql.gz") ? "sql.gz" : n.endsWith(".dump") ? "dump" : n.endsWith(".sql") ? "sql" : null;
}

/** "custom" (pg_dump -Fc), "gzip" (plain SQL, gzipped), "sql" (plain text) or null (unrecognised/binary). `head` = first bytes. */
export function detectFormat(head) {
  const b = Buffer.from(head);
  if (b.subarray(0, 5).toString("latin1") === "PGDMP") return "custom";
  if (b[0] === 0x1f && b[1] === 0x8b) return "gzip";
  if (b.length && !b.subarray(0, 4096).includes(0)) return "sql";
  return null;
}

export const MODES = ["full", "data"];

/** Steps of a restore job, in order (ids; labels for the log). */
export function planSteps(mode) {
  if (!MODES.includes(mode)) throw new Error("mode inconnu");
  return ["safety-dump", "stop-web", ...(mode === "full" ? ["drop-schema", "restore", "migrate"] : ["load-data"]), "start-web"];
}

export const STEP_LABEL = {
  "safety-dump": "① Dump de sécurité",
  "stop-web": "② Arrêt du web",
  "drop-schema": "③ Suppression du schéma public",
  restore: "③ Restauration du dump",
  migrate: "③ Migrations (db:prepare)",
  "load-data": "③ Vidage des tables et chargement des données (1 transaction)",
  "start-web": "④ Redémarrage du web",
};

const shq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const ENV = 'export PGPASSWORD="$POSTGRES_PASSWORD"; ';
const CONN = '-U "$POSTGRES_USER" -d "$POSTGRES_DB"';
const TRUNCATE_ALL = "DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', r.tablename); END LOOP; END $$;";

/** Script run through `sh -c` in the db container; the dump is fed on stdin (gz already unzipped by the caller). */
export function dumpScript() { return `${ENV}exec pg_dump -Fc --no-owner ${CONN}`; }
export function dropSchemaScript() { return `${ENV}psql -v ON_ERROR_STOP=1 ${CONN} -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'`; }
/** format: "custom" | "sql" (gzip counts as sql once decompressed). */
export function restoreScript(mode, format) {
  if (mode === "full") {
    return format === "custom"
      ? `${ENV}exec pg_restore --no-owner --no-privileges --exit-on-error ${CONN}`
      : `${ENV}exec psql -v ON_ERROR_STOP=1 -q ${CONN} -f -`;
  }
  // Data only: truncate + load inside one psql transaction; replication role "replica" skips FK ordering issues.
  const pre = `pre_sql() { printf '%s\\n' ${shq("SET session_replication_role = replica;")} ${shq(TRUNCATE_ALL)}; }`;
  // The dump is converted to SQL first (a failing pg_restore must not feed a truncated stream to psql).
  const tmp = format === "custom" ? "pg_restore --data-only -f \"$T\"" : "cat > \"$T\"";
  return `${ENV}${pre}; T=$(mktemp); trap 'rm -f "$T"' EXIT; ${tmp} && { pre_sql; cat "$T"; } | psql -v ON_ERROR_STOP=1 -q --single-transaction ${CONN} -f -`;
}
