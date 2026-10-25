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
