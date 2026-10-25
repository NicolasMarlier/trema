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
0.1.1

# Interface web (`trema ui`)
Tableau de bord (apps, statut, logs, variables d'env, redémarrage, historique des déploiements).
Lancer sur le VM : `npm start` (écoute sur 127.0.0.1:4000, sans dépendances). Depuis le poste : `trema ui` ouvre un tunnel SSH. Ne jamais l'exposer publiquement (accès au socket Docker et aux secrets).
Le hook `post-receive` écrit `apps/<app>/deploys.log`.
