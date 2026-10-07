# In-App Direct Editing — Plan (Phase 1: static text)

**Status:** in progress (spike). **Date:** 2026-07-01.
**Decided with user:** Studio round-trip rejected (mobile UX + engine divergence). Editing stays in-app. Position-move is a *later* phase via reorder/align + `margin` offset (NOT detach-to-absolute — breaks responsive layout). This doc covers Phase 1 only: **static text content editing.**

## Scope
Enter edit via the ✏️ → tap a **static text** layer → inline input → replace its `content`. That's it.

## Where
- **CreateApp `done` screen** — where `<BitePlayer doc>` + the ✏️ FAB already live.
- ✏️ becomes a 2-way choice: **[✏️ 직접 편집] / [💬 AI로 수정]** (AI = the existing refine flow).
- An edit commits as a **new version** (`setVersions([...prev, {label, doc}])`) → reuses version-history/revert.
- **Persistence:** no new endpoint. Existing `share()` → `POST /api/apps {doc}` saves the latest doc.

## Design
1. **BitePlayer opt-in edit mode** — new props `editable?: boolean`, `onSelectText?(sel|null)`. `editable` in the init effect deps: when on, **skip `attachEventBridge`** (taps don't drive the app) and attach a host click listener that selects an editable text node. Default off → player unchanged.
2. **Editable-text detection (the "되는 척" guard)** — a layer is editable iff: `shape==='text'`, `content` is a plain string (no `$props`, no `${`), and its id is **not** a bound `.content` target in `runtime.bindings`. Bound text (score/live) and component-instance text (`$props`, rendered as `<inst>__<sub>` ids) are **not** selectable. Uses the live `runtime.bindings` as source of truth, not doc guessing.
3. **Hit-test** — reuse the `__snackHit` approach: `forEachNode` → `node.display.getBounds()` (canvas-CSS px), pick the smallest editable node whose bounds contain the tap. Report `{layerId, rect(client coords), text}`.
4. **Inline input** — CreateApp overlays a fixed-position `<input>` at the reported rect; commit → `setLayerContent(doc, id, text)` (deep-clone + find-by-id) → new version → `[doc]` re-render.

## Verify
- `pnpm player:build` + tsc 0.
- counter-tap smoke: `counterLabel`/`tapLabel` editable ✓; `countText`/`lastActionText` (bound) + NavBar/StatCard/GhostButton text (`$props`) **locked** ✓.

## Update (2026-07-01, after first live test)
- **Mouse was broken** (worked on touch only). Two causes, both fixed: (1) Pixi's canvas EventSystem stops propagation at the target → moved the tap listener to **capture phase**; (2) mousedown on the canvas **stole focus** → the auto-focused input blurred and closed instantly → added a capture `mousedown` `preventDefault` on the host.
- **UX upgraded to a bottom sheet + feedback** (was a tiny inline input, felt like "nothing happened"): entering edit mode outlines every editable text with a **dashed lime hint**; tapping any static text shows a **selection box** (lime=editable, red=locked); an editable tap opens a **bottom edit sheet** (field + 저장/취소); a locked tap opens the sheet with a **"🔒 자동으로 바뀌는 값" note** (so every tap reacts). App **freezes** (tick paused) while editing for stable layout. BitePlayer now reports `onEditableRects` + `editable` flag on selection.

## Update — multi-scene state switcher (2026-07-01)
Multi-state apps hid non-current-scene text via `.visible` bindings, so hints from every state piled up on the landing scene. Added a **scene chip bar** (dynamic from `scene.states`; friendly labels 시작/진행/결과/문제 N…; hidden when 1 state). Switching a chip **re-mounts with `scene.initialState` overridden** to that state — `renderer.applyState` alone can't switch it because visibility is runtime-binding-driven, not layer-set-driven. Also filter hints/selection to **currently-visible** text (`isShown` walks own+ancestor visibility) so hidden-state text isn't hinted.

**Verified via workflow** (14 agents): 10 templates spanning 1/2/3/4/13 states → **10/10 pass** (chips match state count; each state shows only its own text, no cross-scene overlap; edit persists). Adversarial review (4 dimensions) surfaced + fixed:
- **[HIGH]** edit-mode flags leaked across 새로/build/pick/switch → new app opened frozen in edit mode. Fixed: `resetEdit()` on those paths + disable mode-switch while editing + clamp `editState` when the doc changes. (regression test `_edit-leak.mjs`)
- gacha-draw's bottom `hint` was covered by the bottom edit bar → made the bar `pointer-events:none` (only 완료 tappable).
- schema: state-scoped layers are `extraLayers`, not `layers` (latent; no current template uses it).

Deferred (low): same-id-different-content-per-state map collapse (needs `extraLayers`, none ship it); Pixi re-init flash per chip tap (unavoidable given binding-driven visibility; review confirmed no leak).

## Non-goals (this phase)
Position move; bound/dynamic text; component `propValues` text (nav title, button labels — natural next step); `/p/:slug` post-share editing (ownership/auth); multiline/rich text.
