# Format de scène & exemples

Une **scène** = le graphe nodal complet sérialisé en JSON. C'est exactement ce
que produisent les boutons **💾 Save / 📂 Load** de l'éditeur (mode Graph).

## Format

```jsonc
{
  "version": 1,
  "title": "…",            // optionnel, informatif
  "outputId": "round",      // le nœud affiché / exporté
  "nodes": [
    {
      "id": "body",
      "position": { "x": 0, "y": 0 },   // position sur le canvas
      "data": {
        "nodeType": "box",              // type de nœud (cf. NODE_SPECS)
        "params": { "x": 70, "y": 45, "z": 22 }
      }
    }
    // …
  ],
  "edges": [
    {
      "id": "e0",
      "source": "body",          // nœud source
      "sourceHandle": "out",     // toujours "out"
      "target": "hollow",        // nœud cible
      "targetHandle": "in",      // nom du port d'entrée (ou d'un param câblé)
      "style": { "stroke": "#ff8c42" }  // couleur = type de socket
    }
    // …
  ]
}
```

### STL / polices importés
Les params fichier (`importSTL`, `textToSvg`) portent un `ArrayBuffer`. À la
sauvegarde il est encodé en base64 : `"params": { "stl": { "__ab": "<base64>" } }`.
Au chargement, `__ab` est redécodé — **la scène est donc autonome**, STL inclus.

## Charger une scène
Mode **Graph** → **📂 Load** → choisir un `.json`. Le graphe se reconstruit et
s'évalue ; le nœud `outputId` s'affiche. Exporte ensuite en STL / SVG / STEP.

## Exemples fournis (`examples/`)
Générés et **vérifiés** par `npm run scenes` (chaque scène est évaluée avant
écriture) :

| Fichier | Type | Ce que ça montre |
|---|---|---|
| `hollow-tray.json` | 3D | box → **shell** (ouverture dessus, faceSelect) → **fillet** arêtes verticales |
| `bolt-flange.json` | 3D | cylindre − perçage central − **cercle de boulons** (arrayRadial3d + boolean3d) |
| `name-plate.json` | 2D laser | **Score/Cut** : contour rouge + rainage bleu (remplace l'intérieur par un `Text → SVG`) |
| `living-hinge.json` | 2D laser | **charnière vivante** : champ de fentes fines (arrayLinear2d + boolean2d) |
| `coaster.json` | 2D laser | disque + anneau de trous (arrayRadial2d) |

Pour régénérer : `npm run scenes`.
