# HANDOFF — contexte de conception (session web → local)

Ce fichier résume les décisions prises pendant la session web qui a créé ce
repo, pour qu'une session Claude Code locale (ou toi) reparte avec tout le
contexte. À lire avec `README.md` (findings du spike) et le code de `src/`.

## Vision

Un **générateur de modèles 3D paramétriques en nodal**, à destination de
l'impression 3D, que des utilisateurs customisent en changeant des paramètres
(texte, valeurs) ou en éditant le graphe de nœuds. Besoins exprimés :

- offset 2D, input SVG extrudé, extrude sur résultante d'extrude (en prenant le
  couvercle ou les faces de contour) ;
- **flaguer des faces** (ex. les faces de contour d'un extrude) pour les
  réutiliser plus tard, même si la géométrie a changé depuis ;
- **texte → SVG → extrude** (paramètres texte convertis en SVG) ;
- **pas que du CAD** : aussi **importer des STL** pour les modifier ;
- stack **TypeScript / React**.

## Décisions d'architecture

1. **Deux noyaux géométriques**, unifiés par un graphe à types de données :
   - **B-rep (CAO)** : `replicad` (wrapper TS d'**OpenCascade/OCCT**, WASM).
     Offset 2D, extrude, sélection de faces, congés, export STEP. → déjà en place.
   - **Mesh (STL)** : **Manifold** (Google, WASM). Booléens robustes garantis
     manifold, décimation, repair. → **pas encore fait** (spike n°2).
2. **Pont entre les deux** : `B-rep → Mesh` (tessellation) = facile, sens unique.
   `Mesh → B-rep` = à éviter (reconstruction de surface). Les opérations mixtes
   (ex. booléen CAO×STL) se font dans le domaine mesh via Manifold.
3. **Sockets typés** dans le graphe (`sketch2d | solid | mesh`) ; insérer
   automatiquement un nœud `Tessellate` quand on branche un solide sur un nœud
   mesh-only.
4. **Problème du topological naming** (réutiliser une face après régénération) :
   résolu en stockant une **requête/critère**, pas un id de face. Les `faceId`
   d'OCCT sont instables entre deux régénérations.
5. **Off-thread** : OCCT (et Manifold) tournent dans des **Web Workers**
   (comlink), jamais sur le thread UI.
6. **Éditeur nodal** : cible = **React Flow** (`@xyflow/react`) par-dessus le
   moteur de graphe `src/kernel/nodes.ts`. Pour l'instant le graphe est câblé en
   dur dans `src/kernel/model.ts`.

## Ce que le spike a déjà prouvé (voir README)

- Pipeline `svgInput → offset2d → extrude → bossOnCap` de bout en bout.
- Extrude sur le couvercle d'un extrude (bossage).
- Tagging de faces `top/side/bottom` + sélecteur `resolveTopCap` par critères
  qui **survit à la régénération** (faceId change, le couvercle reste retrouvé).
- Export STL.
- Vérifié en **headless** (`npm run smoke`) et dans un **vrai navigateur**.

## Carte des fichiers

| Fichier | Rôle |
|---|---|
| `src/kernel/nodes.ts` | Moteur de graphe typé (DAG) + nœuds géo (B-rep + mesh) + tagging + `resolveTopCap` |
| `src/kernel/manifold.ts` | Domaine mesh (Manifold) : `setManifold`, `MeshData`, ↔ Manifold, `booleanMesh`, `repairMesh`, `segmentMesh` |
| `src/kernel/stl.ts` | Parseur/writer STL binaire ↔ `MeshData` |
| `src/kernel/specs.ts` | Métadonnées de nœuds (ports/params/couleurs), **sans dépendance runtime** — importable côté UI sans tirer le WASM |
| `src/NodeEditor.tsx` | Éditeur nodal React Flow (nœuds typés, palette, éval live) |
| `src/kernel/svgPath.ts` | Parseur SVG path → drawing replicad (point d'entrée du futur nœud texte→SVG) |
| `src/kernel/model.ts` | Câble le graphe par défaut depuis les params |
| `src/kernel/worker.ts` / `client.ts` | Worker OCCT + pont comlink |
| `src/viewport.ts` | Viewport Three.js, 1 matériau par tag de face |
| `src/App.tsx` | UI : toggle **Form / Graph**, sliders + import STL (form), montage `NodeEditor` (graph), export STL, viewport partagé |
| `scripts/smoke.ts` | Preuve headless spike n°1 (Node) — `npm run smoke` |
| `scripts/smoke-mesh.ts` | Preuve headless spike n°2 / pont mesh — `npm run smoke:mesh` |

### Détails techniques à connaître (pièges déjà résolus)

- replicad 0.23 **n'a pas** `drawSVG` → parseur maison dans `svgPath.ts`
  (gère `M L H V C Q Z`, premier contour fermé seulement ; **trous = TODO**).
- L'OCCT (`replicad-opencascadejs`) est un **module ESM** (`export default`)
  dont la branche Node d'emscripten lit `__dirname`/`require` en globals libres.
  Sous Node ESM il faut les **shim** (voir `scripts/smoke.ts` `initOCCT`). Dans
  le worker navigateur, la branche WEB/WORKER est prise → aucun shim nécessaire.
- Init worker : `import initOpenCascade from ".../replicad_single.js"` +
  `import wasmUrl from ".../replicad_single.wasm?url"`, puis
  `setOC(await initOpenCascade({ locateFile: () => wasmUrl }))`.
- `vite.config.ts` : `optimizeDeps.exclude: ["replicad-opencascadejs"]` +
  `worker.format: "es"`.
- `mesh()` renvoie `{ triangles, vertices, normals, faceGroups }` où
  `faceGroups[i] = { start, count, faceId }` (start/count en indices de
  triangles ; faceId = hash **instable**).

## Prochaines étapes (par ordre logique)

1. ~~**Spike n°2 — pont mesh**~~ ✅ **FAIT** (headless). Manifold (WASM) intégré,
   type de socket `mesh`, nœuds `tessellate` (B-rep→mesh), `importSTL`, `repair`,
   `boolean` (union/diff/inter), + `segmentMesh` (régions coplanaires flaguables).
   Prouvé par `npm run smoke:mesh` : replicad → STL → import (soup) → repair
   (weld 1128→190 verts) → booléen CAO×STL (diff) → export STL + round-trip.
   Détails techniques ci-dessous.
   - ✅ **Navigateur câblé aussi** : Manifold init dans le **même worker** qu'OCCT
     (voir décision ci-dessous), UI **Import STL** + case « cut » dans `App.tsx`,
     `meshToPayload` rend le mesh dans le viewport existant sans le modifier.
     Vérifié dans un vrai navigateur : import STL → repair → booléen CAO×STL live,
     0 erreur console.
2. ~~**React Flow** par-dessus `nodes.ts`~~ ✅ **FAIT** : `src/NodeEditor.tsx`
   (palette, ports typés colorés, édition de params inline, sélection du nœud
   affiché, éval live via `worker.evalGraph`). Toggle **Form / Graph** dans
   `App.tsx`. Auto-insertion d'un `tessellate` quand on branche un `solid` sur
   une entrée `mesh`. Vérifié navigateur : édition live + sélection de sortie OK.
   - ✅ **Cache par nœud FAIT** : `evalGraphCached` (nodes.ts) + cache persistant
     dans le worker. Hash content-addressed (type+params+hashes enfants) ; changer
     un param ne recalcule que ce nœud + son aval, l'amont est servi du cache.
     Vérifié : run identique = 100 % hits ; changer la hauteur d'extrude = svg+offset
     réutilisés, seul l'extrude recalculé. Éviction fenêtre 2 runs avec `.delete()`
     des shapes OCCT.
   - ✅ **Suppression nœud/arête + sérialisation FAIT** : émission par signature
     (topologie/params, ignore les déplacements) → la suppression marche via ⌫ ;
     boutons 💾 Save / 📂 Load (JSON, ArrayBuffers en base64).
   - ✅ **Params scalaires = ports d'entrée optionnels FAIT** : tout param nombre/
     texte est aussi un **port optionnel** (anneau creux vs port structurel plein).
     Non câblé → valeur par défaut éditable inline ; câblé → valeur du nœud amont
     (`◀ linked`). Nœuds sources **Number** / **Text**. Résolu par `resolveInputs`
     dans nodes.ts (route les ports param vers `params`). Types de socket
     `number`/`text` ajoutés. Vérifié navigateur (Number 40 → hauteur d'extrude).
3. ~~**Nœud `texte → SVG`** via **opentype.js**~~ ✅ **FAIT** : nœud `textToSvg`
   (params text + size + font uploadée .ttf/.otf) → `opentype.getPath` → path `d`
   → `svgPathToDrawing`. Vérifié navigateur : « A » extrudé avec son contre-poinçon.
   Import namespace `import * as opentype` (pas de default export en ESM).
4. ~~Améliorer le parseur SVG : multi-contours + trous~~ ✅ **FAIT (arcs inclus)** :
   `svgPath.ts` gère `S/s`, `T/t` (courbes lissées), `A/a` (**arcs elliptiques →
   béziers cubiques**), et les **sous-chemins multiples → trous** (containment
   centroïde-dans-polygone, aire décroissante). Débloque les glyphes « O/Q/A ».

### Reste à faire (nouveau backlog)

- ✅ Cache : borne LRU (256 entrées) en plus de la fenêtre 2 runs — FAIT.
- ✅ Éditeur : **undo/redo** (⌘Z / ⇧⌘Z + boutons, historique 100) et
  **validation des connexions** (`isValidConnection` → React Flow refuse le drop
  incompatible ; plus de rejet silencieux) — FAIT.
- ✅ Nœud texte : **polices système** via la **Local Font Access API**
  (`queryLocalFonts`, Chromium, permission + onglet visible requis) + repli upload
  `.ttf/.otf` — FAIT (`FontField` dans NodeEditor). Erreur gérée proprement si
  l'API est absente ou l'accès refusé.
- ✅ **Nœud `Transform` (translation) + gizmo 3D** — FAIT : nœud solid→solid
  (`tx/ty/tz`, ports optionnels nombre) ; quand il est le nœud affiché, un gizmo
  Three.js `TransformControls` apparaît sur l'objet et écrit `tx/ty/tz` en direct
  (pont `NodeEditor.onReady` → `App` → `viewport.showTranslateGizmo`). Le viewport
  ne recentre plus le mesh (coords réelles) et ne re-cadre qu'au 1er rendu.
  Vérifié navigateur : drag → objet déplacé + param move Y = 30,5.
  - **Suite** : rotation/échelle (gizmo modes rotate/scale), transform sur mesh.
- Éditeur : auto-layout, groupes de nœuds, copier/coller.

### Spike n°2 — notes techniques (Manifold)

- Package **`manifold-3d`** 3.5.1 (ESM pur). Init : `Module({locateFile})` puis
  **`.setup()` obligatoire**. Contrairement à OCCT, **aucun shim** `__dirname`/
  `require` nécessaire sous Node ESM.
- Piège résolution Node : l'export `.` de `manifold-3d` n'a qu'une condition
  `import` → `require.resolve("manifold-3d")` échoue. Résoudre le `.wasm` via
  `require.resolve("manifold-3d/manifold.wasm")` et importer le JS via `import()`.
- Format Manifold `Mesh = { numProp, vertProperties (xyz interleavés), triVerts }`.
  Notre `MeshData` = `{ vertices: Float32Array (xyz plat), indices: Uint32Array }`.
- `Manifold.ofMesh` **throw** si non-manifold ; vérifier `.status()`. `Mesh.merge()`
  = la brique **repair** (weld des sommets coïncidents) — indispensable après un
  import STL (soup à sommets non partagés).
- `manifold.ts` n'appelle jamais l'init (comme `nodes.ts` n'appelle pas `setOC`) :
  le caller injecte via **`setManifold(mf)`**. Pas de dépendance circulaire :
  `nodes.ts → manifold.ts` uniquement.
- Les valeurs `mesh` du graphe sont des `MeshData` transférables ; conversion
  ↔ Manifold à chaque op (copie en trop, mais découplé du cycle de vie WASM —
  optimisation batch = plus tard).
- **Décision : un seul worker pour les deux noyaux** (déviation du plan initial
  « 2e worker »). Comme `evalGraph` entrelace nœuds B-rep et mesh dans un même
  graphe (extrude → tessellate → boolean vs un STL), les deux WASM doivent
  cohabiter là où l'évaluation tourne. `worker.ts` fait donc
  `Promise.all([initOpenCascade, initManifold])`.
- Navigateur : `import initManifold from "manifold-3d"` +
  `import wasmUrl from "manifold-3d/manifold.wasm?url"` ; `manifold-3d` ajouté à
  `optimizeDeps.exclude`. Warning Vite `node:module externalized` = bénin
  (branche Node de la glue emscripten, jamais prise en Web Worker).

## Comment lancer

```bash
npm install
npm run smoke   # preuve géométrie headless
npm run dev     # PoC interactif
```
