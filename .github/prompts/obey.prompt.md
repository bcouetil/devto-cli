---
name: obey
description: Résumé des skills et configurations Copilot du workspace
---

Parcours tous les fichiers de configuration Copilot de ce workspace :

1. **Instructions racine** : `.github/copilot-instructions.md`
2. **Skills** : tous les fichiers `SKILL.md` dans `.github/skills/*/`
3. **Prompt files** : tous les fichiers `.prompt.md` dans `.github/prompts/`
4. **Instructions spécifiques** : tous les fichiers `*.instructions.md` dans `.github/instructions/`

Pour chaque élément trouvé, donne un résumé en **une phrase maximum**.

Format de sortie attendu :

## 📋 Instructions racine
- [résumé]

## 🛠️ Skills
- **[nom]** : [résumé]

## 💬 Prompt files
- **/[commande]** : [résumé]

## 📁 Instructions spécifiques
- **[fichier]** : [résumé]

Si une section est vide, indique "Aucun".
