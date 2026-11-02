# Trema
Lightweight, host-your-own, heroku-like PaaS

# Installation
Voir [docs/architecture.html](docs/architecture.html#install) (prérequis et étapes), ainsi que l'architecture complète : ce qui est centralisé sur la VM, ce qui est par app, et les flux.

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

# Interface web
Tableau de bord (apps, statut, logs, variables d'env, redémarrage, historique des déploiements).
Installer sur le VM : `trema ui:install` (construit le front React/Vite en local, `ui/web` → `ui/dist`, puis rsync + service systemd ; redémarre au reboot, écoute sur 127.0.0.1:4000, aucun `node_modules` sur le VM). Développement : `TREMA_DEV=1 npm start` (serveur, sans login sur la boucle locale ; sans `TREMA_DEV=1` le login est exigé partout) + `cd ui/web && npm run dev` (proxy `/api`). Les valeurs d'env ne sont renvoyées qu'à la demande (`GET /env/:key`) ; les modifications passent par `PATCH /env {set, unset}` et lancent un job asynchrone suivi en direct. Le serveur refuse tout `Host` autre que localhost/127.0.0.1 ou le domaine configuré et tout POST/PUT sans `Content-Type: application/json` + `X-Trema: 1`. Tests : Node ≥ 22.18 requis (les tests importent des fichiers `.ts` ; voir `.tool-versions`).

**Accès web** : `ui:install` expose aussi l'interface en HTTPS sur `https://trema.<host>` (vhost nginx + certbot). À la première installation, il demande un mot de passe (12 caractères min., haché scrypt dans `~/trema-ui/auth.json`) et affiche le secret TOTP à ajouter dans Google Authenticator. La connexion exige mot de passe + code TOTP ; session de 7 jours, renouvelée à l'usage (cookie `HttpOnly; Secure; SameSite=Strict`), bouton « Déconnexion ». Le login est exigé partout ; seul `TREMA_DEV=1` (développement) l'omet pour les requêtes directes en boucle locale.
- `trema ui:password` change le mot de passe et ferme toutes les sessions.
- Protections : limite de requêtes nginx sur `/api/login`, blocage exponentiel par IP côté serveur + délai fixe, code TOTP à usage unique. Journal des connexions et actions : `~/trema-ui/audit.log` (sans valeurs d'env).
- ⚠️ L'interface donne accès au socket Docker et aux secrets : choisir un mot de passe long.
Le hook `post-receive` écrit `apps/<app>/deploys.log`.

## Déployer Trema lui-même

Depuis le repo trema (branche `main`, arbre propre) : `npm run deploy`.
Utilise `~/.trema_config` et le code du dossier courant : templates Docker, `server:setup`, build + installation de l'UI, hooks de toutes les apps, vérification HTTPS. Pas de tests lancés (rôle de la CI/Usine) ; s'arrête à la première erreur.
