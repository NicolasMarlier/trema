// Pure helpers to recover from an SSE stream that was cut before the `done` event.
export type JobLike = { id: string; state: string };

export type ResyncStep<J extends JobLike> =
  | { kind: "done"; job: J }      // final state reached: stop, notify
  | { kind: "reconnect"; job: J } // still running server-side: re-open the SSE
  | { kind: "retry" };            // fetch failed or job unknown: try again later

/** Decides what to do after a stream drop, given the result of GET /api/jobs/:id (null = fetch failed). */
export function resyncStep<J extends JobLike>(fetched: J | null): ResyncStep<J> {
  if (!fetched) return { kind: "retry" };
  if (fetched.state === "running") return { kind: "reconnect", job: fetched };
  return { kind: "done", job: fetched };
}

/** Delay before the next poll: 1 s, growing to 5 s. */
export function resyncDelay(attempt: number): number {
  return Math.min(5000, 1000 + attempt * 500);
}

const TITLE: Record<string, string> = { restart: "Redémarrage", stop: "Arrêt", start: "Démarrage", redeploy: "Redéploiement", create: "Création de l'app", deploy: "Déploiement" };
export function jobTitle(action: string): string { return TITLE[action] ?? action; }
