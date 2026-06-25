---
name: obey
description: Résumé des skills et configurations Cursor du workspace
---

Parcours tous les fichiers de configuration Cursor de ce workspace :

1. **Instructions racine** : `.cursor/rules/*.mdc` avec `alwaysApply: true`
2. **Skills** : tous les fichiers `SKILL.md` dans `.cursor/skills/*/`
3. **Commands** : tous les fichiers `.md` dans `.cursor/commands/`
4. **Instructions spécifiques** : tous les fichiers `.mdc` dans `.cursor/rules/` avec des `globs`

Pour chaque élément trouvé, donne un résumé en **une phrase maximum**.

Format de sortie attendu :

## 📋 Instructions racine
- [résumé]

## 🛠️ Skills
- **[nom]** : [résumé]

## 💬 Commands
- **/[commande]** : [résumé]

## 📁 Instructions spécifiques
- **[fichier]** : [résumé]

Si une section est vide, indique "Aucun".
