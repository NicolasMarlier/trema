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
Installer sur le VM : `trema ui:install` (rsync + service systemd, redémarre au reboot, écoute sur 127.0.0.1:4000, sans dépendances). Ensuite `trema ui` ouvre le tunnel SSH et le navigateur. Le serveur refuse tout `Host` autre que localhost/127.0.0.1 (ou le domaine public) et tout POST/PUT sans `Content-Type: application/json` + `X-Trema: 1`.

**Accès web** : `ui:install` expose aussi l'interface en HTTPS sur `https://trema.<host>` (vhost nginx + certbot). À la première installation, il demande un mot de passe (12 caractères min., haché scrypt dans `~/trema-ui/auth.json`) et affiche le secret TOTP à ajouter dans Google Authenticator. La connexion exige mot de passe + code TOTP ; session de 7 jours, renouvelée à l'usage (cookie `HttpOnly; Secure; SameSite=Strict`), bouton « Déconnexion ». Par le tunnel SSH, aucune connexion n'est demandée.
- `trema ui:password` change le mot de passe et ferme toutes les sessions.
- `trema ui:unexpose` supprime le vhost et `auth.json` : retour au tunnel seul (`ui:install` réexpose).
- Protections : limite de requêtes nginx sur `/api/login`, blocage exponentiel par IP côté serveur + délai fixe, code TOTP à usage unique. Journal des connexions et actions : `~/trema-ui/audit.log` (sans valeurs d'env).
- ⚠️ L'interface donne accès au socket Docker et aux secrets : choisir un mot de passe long, et préférer `ui:unexpose` si l'accès web ne sert pas.
Le hook `post-receive` écrit `apps/<app>/deploys.log`.
