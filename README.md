# POLAR AURORA — The Great Penguin Adventure

An original pseudo-3D endless polar runner. Every pixel and every sound is
generated at runtime: **no image files, no audio files, no fonts, no
frameworks, no libraries, no build step, no server.**

Open `index.html` in a browser. That's it.

```
index.html
css/style.css
js/*.js          ← 16 modules, plain classic scripts
```

Loaded as classic `<script>` tags rather than ES modules on purpose: `file://`
+ `type="module"` is blocked by CORS in Chrome, and "runs locally by
double-clicking" was a hard requirement.

---

## Controls

|            | Keyboard              | Touch              |
|------------|-----------------------|--------------------|
| Move lane  | `←` `→` · `A` `D`     | swipe left / right |
| Jump       | `Space` `W` `↑`       | swipe up, or tap   |
| Slide      | `S` `↓`               | swipe down         |
| Pause      | `Esc` `P`             | pause button       |
| Mute       | `M`                   | speaker button     |
| FPS meter  | `F`                   | —                  |

Input is buffered ~140 ms, so a jump pressed just before you land still fires.

---

## How it works

### The projection (`Camera.js`)

World space is `x` lateral, `y` up, `z` forward **relative to the player**. The
penguin sits at `z = 0` forever and the world flows toward `−z`. A pinhole
projection (`scale = focal / depth`) makes approaching objects grow
hyperbolically, which is what sells the depth.

The useful trick: the ice is a flat plane at `y = 0`, so **every screen row maps
to exactly one world depth** (`zAtScreenY`). `GroundRenderer` walks rows
top→bottom and gets perfect perspective texturing — fog, ice bands, the
travelling specular sweep — with no polygons at all. It costs ~0.3 ms.

Anything straight in world space stays straight on screen, so lane dashes, grid
rungs and edge strips are plain 4-point quads needing no subdivision.

### The penguin (`Player.js`)

A chase camera looks at a runner's **back**, which hides the two things that
give a character life: the face and the white belly. So the face and belly
aren't drawn flat — they're **decals on an ellipsoid**, placed by a yaw angle:

```
screenX = radius · sin(θ + yaw)      // where the feature lands
facing  = cos(θ + yaw)               // > 0 means we can see it
```

At rest he alternately glances left and right down the runway, so we see him in
profile — beak out at the silhouette edge, one eye, a legible expression — and
his torso sits in a 3/4 back view with a sliver of belly wrapping one edge. He
snaps his head round to camera when something happens. The yaw does the acting.

Everything else is springs: squash & stretch on takeoff/landing, a verlet
scarf streaming in the slipstream, counter-rotating flippers, a foot cycle.

### Lighting

The aurora is the scene's key light. `BackgroundRenderer.sampleAurora(x)` is
sampled by the ice reflection, the snow field, the mountain rims, the penguin's
rim light and every obstacle — so the whole frame is lit by one source and
stays colour-consistent for free.

### Fairness (`ObstacleManager.js`, `CollisionSystem.js`)

Seven hazards, three verbs. **JUMP** (hole · seal · snowball · broken ice),
**DODGE** (crystal · iceberg), **SLIDE** (arch). Silhouette tells you which
before you can read any detail.

`_emit()` is the only way anything enters the world and it refuses to build a
row with no answer: a row can only be full-width if one input clears all of it.
Spacing derives from *speed*, not a constant, so 45 m/s never becomes a reflex
lottery. Hitboxes are ~85 % of the drawn art.

Collision is **swept along z**: at 42 m/s a prop moves 0.7 m per frame and a
seal is 1.6 m deep, so a naive "overlapping right now?" test eventually misses
one entirely. The swept interval cannot tunnel at any speed or frame time.

### Performance

`Renderer.quality` (1 → 0.35) is one dial every subsystem reads to thin its own
detail. It follows the **median** of recent frame times (one GC hitch shouldn't
downgrade the art permanently), falls fast and climbs slowly so it can't
oscillate.

It is fed the **rAF wall time, not JS time** — Canvas2D rasterises off-thread,
so our own timers report ~2 ms on a frame that actually took 30. Measuring them
made the governor permanently blind (a real bug found during QA).

Measured, 1280×800, Chromium: **~86 fps** on a discrete GPU. Profiling drove
three changes worth ~11 ms/frame:

| change | why |
|---|---|
| sky → half-res buffer | the aurora is pure soft gradient work; it loses nothing at half scale and costs a quarter of the fill |
| one gradient per aurora ribbon | 52 gradients × 4 ribbons per frame was the single most expensive thing in the frame |
| props fade by 130 m, LOD under 11 px | a distant iceberg is a 4 px smudge costing a full gradient stack |

---

## Verification

QA is automated against the real game in Chromium (Playwright), not asserted by
inspection. **51 functional + 14 audio + 8 layout checks**, all passing:

- no console errors, no failed requests, no missing assets (there are none)
- perspective: scale grows with proximity; ground rows map monotonically to depth
- jump / slide / lane changes / clamping, on keyboard **and** touch
- a well-timed jump clears a seal; an arch kills you standing and passes you sliding
- shield absorbs exactly one hit — **and the next hit is fatal** (a shield that
  silently persisted would pass a naive "did I survive?" test forever)
- scoring, HUD, pause freezes the world, resume keeps the run
- procedural generation, difficulty ramp, 9 s soak with stable pools
- audio: an `AnalyserNode` measures real RMS on the master bus — "the
  AudioContext exists" proves nothing, a fully-wired graph can emit silence
- layout: all three lane centres on screen from 360×640 to 3440×1440

Bugs this caught and fixed, among others: the FSM firing `enter` before the DOM
was cached; `destination-in` erasing the runway it was supposed to be
reflecting into; runway quads ending at 80 % of screen height; the quality
governor measuring the wrong clock; portrait focal keying off height alone and
throwing the lanes off both edges; the fish counter rendering underneath the
pause button; and one wing pointing upward because `side * angle` mirrors
across the wrong axis.

---

## Architecture

| module | role |
|---|---|
| `Utils` | math, seeded noise, colour, canvas helpers, pool |
| `StateMachine` | guarded FSM with enter/exit/update |
| `Camera` | pseudo-3D projection, shake, world metrics |
| `InputManager` | keyboard + pointer → four buffered intents |
| `AudioManager` | Web Audio: look-ahead music scheduler, wind, SFX, procedural reverb IR |
| `ParticleSystem` | world-space particles, pooled, two composite batches |
| `BackgroundRenderer` | sky, stars, moon, aurora, clouds, mountains, haze |
| `GroundRenderer` | the frozen runway: rows, reflections, banks, grid, cracks |
| `Player` | the penguin |
| `ObstacleManager` | spawning, solvable patterns, hazard art |
| `CollectibleManager` | pickups, placement, art |
| `CollisionSystem` | swept AABB |
| `UIManager` | every DOM node |
| `Renderer` | canvas, draw order, post, quality governor |
| `Game` | loop, shell FSM, scoring, difficulty, power-ups |
| `main` | boot, and a visible failure mode |
