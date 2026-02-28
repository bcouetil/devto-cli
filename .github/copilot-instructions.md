# Instructions Copilot

Ce dépôt est un CLI Node.js/TypeScript pour publier des articles markdown sur dev.to.

## Skills disponibles

Les skills sont des guides spécialisés pour des tâches récurrentes :

| Skill                                      | Description                                                        |
| ------------------------------------------ | ------------------------------------------------------------------ |
| [development](skills/development/SKILL.md) | Guide de développement du CLI (compilation, conventions de sortie) |
| [testing](skills/testing/SKILL.md)         | Guide de test du CLI (chemins articles, commandes de test)         |

## Prompt files disponibles

Les prompt files sont des commandes `/` personnalisées :

| Commande | Description                                 |
| -------- | ------------------------------------------- |
| `/obey`  | Résumé des skills et configurations Copilot |

## Conventions générales

- Langue principale : français
- Code source en anglais
- Utiliser `chalk` pour les sorties colorées (voir skill development)
- Toujours compiler avec `npx tsc` avant de tester
- Ne pas utiliser de tests embarqués, tester manuellement via le CLI `dev`
