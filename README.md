# nodal-maker

**Un outil de CAO/FAO paramétrique nodal qui tourne entièrement dans le navigateur** —
conçu pour l'**impression 3D résine** et la **découpe laser / Cricut**. On câble des nœuds
en un graphe (à mi-chemin entre Fusion360 et Blender), on ajuste des paramètres, et on
obtient en direct des solides B-rep et des profils 2D exportables en STL / STEP / 3MF /
SVG / DXF.

🔗 **En ligne :** https://tibus.github.io/nodal-maker/
📐 **Comment ça marche :** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

![capture](./poc-screenshot.png)

---

## Ce que ça fait

- **Graphe de nœuds** — un DAG typé d'environ 80 nœuds. Les fils transportent des valeurs
  typées (profil 2D · solide · mesh · nombre · texte · sélection) ; la couleur des ports
  indique ce qui se branche où.
- **Deux moteurs géométriques, dans un Web Worker** — [replicad](https://replicad.xyz) /
  OpenCascade pour la modélisation **B-rep exacte** (extrusion, révolution, loft, congé,
  coque, booléens, filetages, export STEP) et [Manifold](https://github.com/elalish/manifold)
  pour le **travail mesh robuste** (booléens, enveloppes convexes, infill gyroïde, collision).
- **Sketcher 2D à contraintes** — points/lignes/arcs avec coïncidence, parallélisme,
  tangence, cotes… résolus en direct par Levenberg–Marquardt. Esquisse sur un plan de base
  *ou sur une face quelconque sélectionnée*.
- **Modes Simple / Expert** — Expert = le graphe de nœuds complet ; **Simple** = un
  formulaire généré automatiquement (galerie de vignettes + uniquement les paramètres
  exposés par l'auteur) pour qu'un utilisateur non technique n'ait qu'à ajuster des valeurs
  et voir le modèle se mettre à jour. Sans toucher aux nœuds.
- **Picking en direct** — clique une face/arête dans le viewport pour câbler automatiquement
  un nœud de sélection ; les sélections de faces survivent à la régénération (elles sont
  stockées comme *critères*, pas comme des ids fragiles — le problème du *topological
  naming*, résolu).

## Aperçu des fonctionnalités

| Domaine | Ce que tu obtiens |
|---|---|
| **Impression résine** | évidement + trous de drainage, infill lattice, infill **gyroïde**, auto-orientation, génération de supports, découpe pour plateau, analyse surplombs & épaisseur de paroi, contrôle watertight, estimation coût/temps résine |
| **Laser / Cricut** | living hinge, nesting, coins dogbone/T-bone, micro-joints (hold-in-sheet), compensation de kerf, boîtes à encoches, calques DXF CUT/SCORE, import/export SVG & DXF |
| **Modélisation** | extrusion (taper/twist), poche, perçages paramétriques, révolution, loft, sweep, boss-on-cap, congé à rayon variable, chanfrein, coque, répétitions (linéaire/radiale/**sur chemin**), texte gravé/embossé sur une face |
| **Analyse & viewport** | vue en coupe, outil de mesure, propriétés de masse, couleur par corps, export vidéo turntable |
| **Import/export** | STL, STEP, 3MF, SVG, DXF, PNG, WebM |

## Démarrage rapide

```bash
npm install
npm run dev          # éditeur interactif — ouvre l'URL affichée
```

```bash
npm run build        # typecheck + build de production
npm test             # suite Vitest (58 tests : éval du kernel, expr, solver, exports…)
npm run thumbs:examples   # (re)génère les vignettes d'exemples manquantes (screenshots WebGL)
```

Smoke tests headless (sans navigateur) : `npm run smoke`, `npm run smoke:sketch`,
`npm run smoke:mesh`, `npm run scenes`.

## Stack technique

TypeScript (strict, ESM) · React 18 + [React Flow](https://reactflow.dev) · Three.js ·
replicad/OpenCascade (WASM) · Manifold (WASM) · comlink · Vite · Vitest · Playwright.
Pas de backend — une SPA entièrement statique, déployée sur GitHub Pages à chaque push sur
`main` (la suite de tests conditionne le déploiement).

## Organisation du projet

```
src/kernel/    le moteur de graphe (nodes.ts), le worker, les wrappers des deux kernels, les exporteurs
src/sketch/    le sketcher 2D à contraintes (sans framework) : model · solver · build
src/           App, NodeEditor (React Flow), SketchEditor, viewport (Three.js)
examples/      55 projets d'exemple           public/thumbs/  leurs vignettes PNG
scripts/       génération de vignettes & scènes, smoke tests
test/          la suite Vitest
```

Voir [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) pour la visite complète : le flux de
données, le cache d'évaluation, le solver de contraintes, le viewport, le configurateur, et
**comment ajouter un nœud en 4 éditions**.

## Statut

Bien au-delà du spike de dé-risquage d'origine — c'est un outil fonctionnel avec un
déploiement en ligne, une large bibliothèque de nœuds, le configurateur Simple/Expert, une
vraie suite de tests et du CI/CD. Ça reste un projet solo et une cible mouvante ; attends-toi
à des aspérités et consulte la section *Décisions de design & limites connues* du document
d'architecture.
