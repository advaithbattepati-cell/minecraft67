# minecraft67

A complete Minecraft clone that runs in a web browser. No build step, no bundler, no
downloads, no external assets. Every texture is drawn procedurally into a canvas and every
sound is synthesized with the WebAudio API, so the whole game is the source you see here.

## Play

```bash
npm start          # serves the repo on http://localhost:8080
```

Then open <http://localhost:8080> and click **Play**. Any static file server works
(`python3 -m http.server` is fine too); the game only needs to be served over `http://`
so that ES modules and the import map resolve.

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| `Space` | Jump (double-tap to fly in creative) |
| `Shift` | Sneak |
| `Ctrl` / double-tap `W` | Sprint |
| Left click | Attack / mine |
| Right click | Use / place |
| Middle click | Pick block |
| `1`–`9`, scroll | Hotbar |
| `E` | Inventory |
| `Q` | Drop item |
| `T` / `/` | Chat / command |
| `F3` | Debug overlay |
| `F5` | Change perspective |
| `Esc` | Pause |

Touch controls appear automatically on touch devices.

## What is in it

- **World** — infinite procedural terrain with continentalness/erosion/peaks-and-valleys
  noise, 3D density for overhangs, cheese/spaghetti/noodle caves, ravines, aquifers, ore
  distributions by depth, and three dimensions (Overworld, Nether, End) with working portals.
- **Biomes** — 55+ biomes with per-biome climate, colours, surface rules, features and mob
  tables.
- **Blocks** — 600+ blocks with the full stairs/slabs/fences/walls/doors/signs families,
  block metadata, block entities, fluids that flow, gravity blocks, growth, fire spread and
  a redstone simulation with pistons, doors, rails and minecarts.
- **Items** — 1000+ items: every tool and armour tier, bows and crossbows, tridents, shields,
  buckets, all foods, all dyes, potions, books, maps, spawn eggs, music discs and more.
- **Crafting** — 550+ recipes, plus smelting (furnace/blast furnace/smoker/campfire),
  brewing, enchanting with the real level algorithm, anvils, grindstones and villager trading.
- **Mobs** — every vanilla mob with goal-based AI and A* pathfinding, from passive animals
  through the raid mobs to the Ender Dragon and the Wither.
- **Structures** — villages, temples, dungeons, mineshafts, strongholds, ocean monuments,
  woodland mansions, nether fortresses, bastions, end cities, ancient cities and more.
- **Survival** — health, hunger, XP, armour, status effects, day/night, weather, sleeping,
  respawning, difficulty levels, and creative/survival/spectator modes.
- **Persistence** — worlds save to IndexedDB, settings to localStorage.

## Layout

```
index.html            shell, import map, boot screen
vendor/               three.js r160 (vendored, MIT)
src/core/             constants, RNG + noise, math utils, service locator, input, settings
src/world/            blocks, chunks, world, biomes, worldgen, features, structures,
                      lighting, block updates, redstone
src/render/           procedural atlas, chunk mesher, chunk/entity renderers, models,
                      skins, sky, particles, item icons
src/entity/           entity physics, player, mobs, AI, projectiles, vehicles, combat, spawning
src/item/             items, inventory, recipes, smelting, brewing, enchanting, effects,
                      loot, trading
src/ui/               HUD, screens, menus, chat, debug overlay, CSS
src/audio/            procedural WebAudio sound engine
src/save/             IndexedDB persistence
tools/                dev server, registry validator, headless browser test
CONTRACT.md           the normative API contract every module implements
```

## Development

```bash
npm start                 # dev server on http://localhost:8080
node tools/validate.mjs   # cross-check the registries in Node (needs `npm i three` locally)
node tools/verify.mjs     # headless Chromium boot + play test, reports console errors
node tools/tour.mjs       # flies the camera to a set of vantage points and screenshots each
node tools/playtest.mjs   # plays the game with real key and mouse events, asserts the world changed
```

`verify.mjs` boots the game in headless Chromium, plays for a while, then prints a JSON report:
console errors, tick and frame timings, entity counts and registry sizes. It exits non-zero on
any error, so it doubles as a smoke test. `tour.mjs` writes `tools/screenshots/`, which is the
quickest way to tell whether a rendering change actually looks right.

`playtest.mjs` is the one that answers "is it actually playable": it sends real keyboard and
mouse events into the page and then checks the world changed as a player would expect - W moves
you, holding left click breaks the block under the crosshair, the drop lands and is collected,
right click places it back, E opens the inventory, and so on. It goes through `input.js` and
`player.js` rather than poking internals. The single concession is that headless Chromium will
not grant pointer lock, so the lock flag is set directly before the mouse tests.

All three drive the game through `window.__mc`, which `main.js` exposes: `quickStart()`,
`startNewWorld()`, `loadSavedWorld()`, `switchDimension()`, `counts()` and `broken()`. Check
`broken()` after a change - `main.js` deliberately degrades instead of crashing when one module
is unhappy, so a dead subsystem is otherwise silent.

`CONTRACT.md` is the source of truth for every module boundary. Read it before changing
anything that another module imports.

## Licence

Code in this repository is provided as-is for educational purposes. Minecraft is a trademark
of Mojang Studios; this project is an independent reimplementation and is not affiliated with
or endorsed by Mojang or Microsoft. `vendor/three.module.min.js` is three.js, MIT licensed.
