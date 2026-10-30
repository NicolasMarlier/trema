# Trema
Lightweight, host-your-own, heroku-like PaaS

# Installation
- [ ] TODO: write

### Improvement ideas
- [X] Trema config to set global address
- [ ] More supported frameworks and ruby versions
- [ ] Observablity
- [ ] Automated DB snapshots

### Version
0.1.2

### Migrations

Pour les apps Rails (template Trema), `bin/rails db:prepare` est joué à chaque `git push trema main`, avant le redémarrage. Si la migration échoue, le déploiement s'arrête et l'ancienne version reste en ligne. `trema migrate` la relance à la main.

Les apps déjà déployées doivent lancer `trema update` pour recevoir le nouveau hook.

# Interface web (`trema ui`)
Tableau de bord (apps, statut, logs, variables d'env, redémarrage, historique des déploiements).
Installer sur le VM : `trema ui:install` (construit le front React/Vite en local, `ui/web` → `ui/dist`, puis rsync + service systemd ; redémarre au reboot, écoute sur 127.0.0.1:4000, aucun `node_modules` sur le VM). Développement : `npm start` (serveur) + `cd ui/web && npm run dev` (proxy `/api`). Les valeurs d'env ne sont renvoyées qu'à la demande (`GET /env/:key`) ; les modifications passent par `PATCH /env {set, unset}` et lancent un job asynchrone suivi en direct. Ensuite `trema ui` ouvre le tunnel SSH et le navigateur. Le serveur refuse tout `Host` autre que localhost/127.0.0.1 et tout POST/PUT sans `Content-Type: application/json` + `X-Trema: 1`. Ne jamais l'exposer publiquement (accès au socket Docker et aux secrets). Tests : Node ≥ 22.18 requis (les tests importent des fichiers `.ts` ; voir `.tool-versions`).
Le hook `post-receive` écrit `apps/<app>/deploys.log`.
