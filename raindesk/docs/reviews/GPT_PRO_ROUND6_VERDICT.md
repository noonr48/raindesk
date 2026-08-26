Observed HEAD: 578f267b7e18729d1195a5545186eb185fae483e

Round‑6 findings

[critical] FREEFORM_DESK_V2.md §§1–3; public/js/creative-desk.js worldToScreen / screenToWorld / viewport persistence; public/js/window-manager.js clampRect / installDrag / persist / init; lib/workspace.js SCREEN_TYPES -> Mechanism: The foundational coordinate split remains unchanged. CreativeDesk stores and renders artwork in canonical world coordinates transformed through pan and zoom, while all shipped registry surface types default to space: "screen" and WindowManager persists raw stage-pixel rectangles. Panning or zooming the creative world therefore moves artwork without moving its logically adjacent Scenes, Layers, Beats, Notes, or other creative surfaces. The two models cannot form a coherent endless desk or a future shared group frame. -> Recommendation: Keep Stage 2 as a blocking world-coordinate migration: every creative surface must persist a canonical world rectangle, with a projection layer converting world geometry to screen geometry. Restrict screen-space persistence to explicitly classified application chrome. Docking should be a temporary presentation, not a second coordinate authority. -> Acceptance test: Place each creative surface beside a marked artwork feature; pan, zoom, resize the viewport, reload, dock, minimise, restore, and tear it from a group. Its canonical rectangle must not be rewritten merely because the projection changed, and its relationship to the artwork must remain invariant.

[major] public/js/window-manager.js close; lib/workspace.js upsertWindow / deleteWindow; server-core.js /api/workspace/object and /api/workspace/window/delete -> Mechanism: The Round‑5 error-classification repair prevents transport/authentication/5xx failures from being misclassified as successful absence, but close is still not identity-safe. The model and DOM are discarded before deletion reaches a terminal state; after a failed delete, the only retained signal is a warning flag on the now-inaccessible removed model. There is no durable retry or reconciliation. More importantly, an ungated object upsert creates a missing windowId, so a stale browser tab, legacy writer, or Partner action can recreate a successfully deleted row. A second structural conflict also exhausts the one retry. -> Recommendation: Replace windowId-only lifecycle writes with the generation/incarnation and tombstone protocol defined in Stage 1 below. Keep failed close intents in a durable client outbox until the server confirms that the exact incarnation is tombstoned. Spatial or legacy updates against that incarnation must then be rejected rather than recreating it. -> Acceptance test: Cover immediate open→close, lost create response, lost delete response, repeated delete conflicts, first-attempt and retry-path 404, retry-path 5xx, browser restart with a pending close, and a stale upsert arriving after successful deletion. The old incarnation must never reappear, while an intentional reopen must receive a new identity.

[major] lib/workspace.js write / assertBaseRevision / setViewport / setGroups / setShelf; public/js/window-manager.js writeChain / persistStructure / persistShelfMembership; public/js/creative-desk.js persistViewport / persistObject; public/js/workspace-ui.js persist -> Mechanism: One workspace-wide revision is still incremented by viewport changes, spatial movement, lifecycle changes, grouping, shelving, deletion, and Partner actions. The manager’s writeChain serializes only that manager’s requests; CreativeDesk, WorkspaceShell, other tabs, and Partner execution maintain separate writers. An unrelated pan or legacy-panel drag can therefore invalidate a group or shelf request. On conflict, the manager replays its entire stale local collection once, potentially overwriting disjoint structural edits. -> Recommendation: Split structural, spatial, and viewport revisions. Treat the structural revision as a synchronization cursor rather than a blanket precondition; resolve correctness through generation checks and per-entity versions. Replace whole-array writes with idempotent intents that affect only named windows or groups. -> Acceptance test: Continuously pan, zoom, move world objects, and move legacy panels while two clients and a Partner action perform disjoint group and shelf operations. Spatial and viewport traffic must not conflict with structural traffic, and every disjoint structural intent must survive regardless of arrival order.

[major] public/js/window-manager.js minimise / restore / removeFromGroup / groupWindows / joinGroup; lib/workspace.js setGroups / setShelf / validateWorkspace -> Mechanism: Group and shelf ownership remain non-atomic and multiply represented. minimise() removes the window from the client group but does not call persistStructure(); its ordinary upsert omits groupId, and setShelf() does not remove group membership server-side. A row can consequently be both minimised and grouped after reload. setGroups() permits the same window in multiple group arrays, while the reverse window.groupId silently takes whichever group is processed last. joinGroup() can also transition a target locally without persisting the target’s lifecycle state. -> Recommendation: Make each shelf or group action one server transaction. Group membership must have one canonical authority, shelf membership another canonical authority, and validation must enforce global mutual exclusion. Do not persist a second writable window.groupId; derive it for legacy projections. -> Acceptance test: Property-test random create, group, regroup, join, minimise, restore, close, tear-out, reorder, and reload sequences. Each live window must appear in at most one group or once on the shelf—never both—and active membership, order, reverse projections, and derived lifecycle state must always agree.

[major] public/js/window-manager.js transition / maximise / unmaximise / restore; init minimised-row loop -> Mechanism: The new dock invariant fixes stale docks on floating and tabbed rows, but it conflates “current presentation” with “presentation to resume later.” Calling maximise() on a docked window invokes transition(docked, maximised), which clears the dock. unmaximise() restores the rectangle but cannot restore the edge, permanently converting the window to floating. The shelf exception has the inverse residual: a minimised row retains any stored edge without policy validation. Restoring a non-dockable surface—or a surface with a now-forbidden edge—transitions it to floating but leaves the invalid dock value intact, recreating {state:"floating", dock:...}. -> Recommendation: Replace the free-floating state/dock coupling with a typed presentation record. Shelf membership should override visibility without mutating the underlying presentation; maximisation should carry an explicit previous presentation. A dock edge must exist only inside {kind:"docked", edge}. -> Acceptance test: Dock every eligible surface left and right, maximise/unmaximise, minimise/restore, drag from the shelf, and reload after each transition. Also seed minimised Takes and minimised Layers with every forbidden edge. Valid windows must return to the exact prior presentation; invalid edges must be cleared permanently in one reconciliation pass.

SPECULATIVE [major] public/js/window-manager.js ensureFrame frame-capture listener / bringToFront / renderFrame / renderGroupTabs / installTabTear; test fake DOM dispatch / pointer-capture stubs -> Mechanism: The release-outside repair may not successfully establish capture for real tab drags. A real pointer event reaches the frame’s capture-phase listener before the target tab listener. That listener calls bringToFront(), which calls renderFrame(), which clears and recreates the tab strip. The original target tab is therefore detached before its own handler calls setPointerCapture; that call is catch-suppressed. The fake DOM neither propagates events through ancestors nor implements pointer capture, so the new test cannot expose this sequence. Shelf chips can similarly lose capture if renderShelf() replaces the chip during a live gesture, while lostpointercapture remains deliberately unhandled. -> Recommendation: Own tab gestures from a stable node such as the frame or tab-strip host using delegated hit detection. Do not replace the gesture-owning node while its pointer is live. Handle capture loss with a session token tied to that stable owner, and let a stale terminal affect only the matching session. -> Acceptance test: In a native browser, perform a genuine tab drag—not a direct call to tearOut()—release outside the viewport, re-enter, and immediately reuse the same pointer ID. Repeat while another operation raises the frame or rerenders the shelf. The original session must terminate exactly once and must never consume the later gesture. Removing capture or the session token must make the test fail.

[major] public/js/window-manager.js init repair branches / persist; Round‑5 stale-dock discriminator tests -> Mechanism: Initialization repairs remain best-effort rather than durable. init() clears stale state in memory and calls persist(model), but persist() catches its own failure, emits at most a warning, and resolves successfully. Initialization does not await a confirmed repaired server row or retain a repair intent. The discriminator tests prove that an upsert was attempted, not that the persisted store converged after a failed attempt or concurrent update. A transient outage therefore allows the malformed row to return at the next startup. -> Recommendation: Move invariant normalization into the server’s schema migration/read-write boundary, or emit a durable idempotent repair intent that startup must reconcile. Client initialization may render the repaired state optimistically, but it must retain a visible pending-repair record until a canonical response confirms convergence. -> Acceptance test: Fail the first repair write, restart the manager, interleave a spatial update from another client, and then restore connectivity. The repair must eventually land without losing the newer geometry; subsequent GETs and reloads must contain no malformed dock combination.

[major] public/js/window-manager.js renderFrame / groupWindows / joinGroup / switchTab / gesture ownership -> Mechanism: A group is still a collection of complete independent windows, not one spatial frame. Members retain different rectangles, z-indices, presentation states, restore states, and gesture locks. Switching tabs can jump the visible frame to another rectangle. Hiding also depends on the member remaining in state === "tabbed"; changing one grouped member to docked or maximised can make it remain visible when another member becomes active. Separate member IDs can acquire simultaneous gestures against what appears to be one frame. -> Recommendation: Preserve Stage 4: introduce a first-class group-frame object owning geometry, presentation, z-order, focus, and gesture identity. Group members should own content identity and ordering only. Stage 1 should canonicalize membership but must not prematurely encode group geometry into individual windows. -> Acceptance test: Group windows with deliberately different geometry; switch tabs, resize, dock, maximise, minimise, restore, reload, and initiate gestures from two member tabs. The frame must never jump because active content changed, exactly one content member must be visible, and one group-scoped gesture lock must govern the aggregate.

[major] public/js/app.js init / legacy BeatTrail construction / WorkspaceShell registrations / mountBeatTrail -> Mechanism: Freeform mode still initializes overlapping owners. A legacy BeatTrail is constructed before the mode decision; opening the registry Beats surface constructs another and overwrites state.beatTrail. Destroying that controller can leave the original object present but unreachable through shot-switch and Partner-refresh paths. Layers and Scenes are still registered with WorkspaceShell even when registry-owned equivalents are opened. These owners also remain independent workspace writers. -> Recommendation: Preserve Stage 3 immediately after coordinate unification: decide ownership before constructing controllers, then expose one stable façade per logical surface. Freeform mode must not register legacy owners for registry-owned surfaces, and Partner/shot refresh code must target the façade rather than a replaceable controller instance. -> Acceptance test: Instrument constructor counts, listener counts, DOM owners, and workspace writes for Layers, Scenes, and Beats. In freeform mode there must be exactly one of each through open, close, reopen, shot switch, reload, and Partner refresh; no legacy panel_* writer may mutate a registry-owned surface.

[major] dev/browser-freeform-desk-journey.js page lifecycle / console collection / steps 16–19; tests/frontend/freeform-window-manager.test.js Round‑5 discriminator block; package.json test script -> Mechanism: The new discriminators cover their narrow pre-fix mutations, and step 19 now compares canonical {rect,state,dock}, but the evidence estate still does not cover the real failure boundaries. Close tests use immediately resolved adapters and inspect calls or warnings rather than final server state and restart behavior. Tab tear is invoked directly in the browser journey, bypassing the capture path. “Reload” closes only the DevTools WebSocket and creates a new browser target; old application pages can remain alive. Each new CDP object resets consoleErrors, so the final zero-error assertion sees only the last page. The journey remains fixed at 1440×900, and npm test excludes it. -> Recommendation: Use one target with Page.reload, or explicitly close each old target; aggregate console and exception evidence across the complete run. Add native pointer-terminal tests, deferred network adapters, final GET assertions, mutation testing, and a viewport/browser matrix to the canonical verification command. -> Acceptance test: An injected warning on an early page must fail the final journey after multiple reloads. Mutations removing generation rejection, close retry retention, full resize rollback, tab capture, shelf/group exclusion, width/height restoration, or dock presentation restoration must each cause a deterministic failure.

[major] docs/reviews/GPT_PRO_ROUND5_VERDICT.md roadmap ordering; current workspace, coordinate, ownership, and group models -> Mechanism: The six-stage order should not be rearranged. Building group-frame geometry before canonical structural intents would preserve contradictory membership. Reflowing windows before coordinate unification would normalize the wrong units. Migrating more surfaces before retiring duplicate ownership would add more writers. The Round‑6 delta does, however, expand Stage 1: the new protocol must establish the typed presentation model now, because generation-safe lifecycle operations cannot safely preserve the current overloaded state/dock representation. -> Recommendation: Keep the order (1) identity-safe intent protocol plus typed presentation, (2) world-coordinate unification, (3) bespoke ownership retirement, (4) group-frame model, (5) viewport recovery and browser/viewport matrix, (6) complete keyboard/accessibility surface. Accessibility semantics may be designed in parallel, but final bindings should target the stable group/window frame model. -> Acceptance test: Enforce one blocking invariant gate per stage: no resurrection or lost structural intents; no mixed coordinate authorities; one owner per surface; one frame per group; recoverable equivalent geometry across the viewport matrix; then complete keyboard and screen-reader operation.

[minor] public/js/window-manager.js CreativeSurfaces.register; registry deep-freeze discriminator -> Mechanism: The implementation and test prove detached, frozen top-level placement and flat tool objects, but “deep-freeze” remains overstated. Both {...defaultPlacement} and {...tool} are shallow clones. Any nested configuration, payload, keybinding, menu, or placement metadata remains mutable through a retained source reference and through the returned registry definition. -> Recommendation: Apply a recursive clone-and-freeze routine to declarative JSON-like policy data, reject cycles/functions where inappropriate, or expose private policy through read-only predicates instead of returning data structures. -> Acceptance test: Register nested arrays and objects under placement and contextual tools, mutate every level through both original and retrieved references, and prove that registration output and later behavior remain unchanged.

[minor] public/js/window-manager.js close classifier; public/js/api.js ApiError; server structural route error envelopes -> Mechanism: Retry classification checks for an attached workspace.revision, not explicitly for status === 409. The current server attaches a workspace only to structural conflicts, so the path presently works, but a future 4xx/5xx response carrying diagnostic workspace state would be retried as though it were a conflict. -> Recommendation: Require both error.status === 409 and a valid canonical conflict payload before retrying. Treat every other status according to its explicit class. -> Acceptance test: Return a 502 and a 403 that include workspace diagnostics; neither may retry. Return a 409 without a valid revision; it must fail visibly rather than being treated as adoptable.

[minor] docs/reviews/GPT_PRO_ROUND5_VERDICT.md finding status -> Mechanism: Read as a current verdict, several narrow Round‑5 mechanisms are now stale: non-404 close failures are no longer silently classified as absence; docked shelf restore now clears collapse; anchored-edge resize cancellation restores state/dock/rect; floating and tabbed stale docks are repaired; step 19 now includes width and height through the canonical rectangle; and flat registry source references are detached. The broader identity, durability, coordinate, group/shelf, group-frame, ownership, viewport, and accessibility findings remain open. The release-outside finding remains unproven rather than closed. -> Recommendation: Append a Round‑6 status ledger marking each prior finding closed, partial, open, or superseded mechanism, with the discriminator or residual acceptance case beside it. -> Acceptance test: Every Round‑5 finding must map to a current code path and a test that would fail if its claimed repair were removed; no partial repair may be labelled closed while a listed residual remains reproducible.

STAGE-1 DESIGN
1. Canonical identity and state model

Use server-monotonic generations plus client-generated incarnation IDs and retained tombstones:

JSON
{
  "windowId": "window_layers",
  "generation": 3,
  "incarnationId": "01J...UUID",
  "structureVersion": 12,
  "spatialVersion": 84
}

windowId remains the stable logical name used by the application. generation is assigned by the server and increases every time that logical name is intentionally recreated. incarnationId is generated by the creating client and makes a lost-response retry of window.create distinguishable from a genuinely new reopen. Every spatial, lifecycle, group, shelf, Partner, and inverse operation carries the complete WindowRef:

JSON
{
  "windowId": "window_layers",
  "generation": 3,
  "incarnationId": "01J...UUID"
}

Persist, for every logical ID:

JSON
{
  "identities": {
    "window_layers": {
      "lastGeneration": 3,
      "latestIncarnationId": "01J...UUID"
    }
  },
  "tombstones": {
    "window_layers": {
      "generation": 3,
      "incarnationId": "01J...UUID",
      "closedAt": "2026-08-27T00:00:00.000Z",
      "structuralRevision": 91
    }
  }
}

The generation counter is never reset or inferred from the live windows[] collection. The latest tombstone is retained even after the live row is gone. This kills the stale-tab and Partner resurrection race: an old upsert can no longer create a missing row merely because its windowId is absent. The current implementation has no equivalent identity or tombstone and still creates missing IDs through upsertWindow().

Canonical v4 storage should remove writable derived fields:

JSON
{
  "schemaVersion": 4,
  "structuralRevision": 91,
  "spatialRevision": 644,
  "viewportRevision": 37,
  "legacyRevision": 811,

  "windows": [{
    "ref": {
      "windowId": "window_layers",
      "generation": 3,
      "incarnationId": "01J...UUID"
    },
    "type": "layers_panel",
    "space": "world",
    "entityRef": "layers:main",
    "presentation": {
      "kind": "docked",
      "edge": "left"
    },
    "beforeMaximise": null,
    "collapsed": false,
    "pinned": false,
    "locked": false,
    "spatial": {
      "x": 100,
      "y": 120,
      "width": 380,
      "height": 600,
      "rotation": 0,
      "scale": 1,
      "zIndex": 14
    },
    "structureVersion": 12,
    "spatialVersion": 84
  }],

  "groups": [{
    "groupId": "group_01J...",
    "version": 7,
    "members": [
      {"windowId": "window_scenes", "generation": 2, "incarnationId": "..."},
      {"windowId": "window_layers", "generation": 3, "incarnationId": "..."}
    ],
    "active": {"windowId": "window_layers", "generation": 3, "incarnationId": "..."}
  }],

  "shelf": {
    "version": 18,
    "members": []
  }
}

The canonical window has no writable state, groupId, or free-standing dock field:

A ref in shelf.members derives state: "minimised".

A ref in one group derives state: "tabbed".

Otherwise state derives from presentation.kind.

dock exists only as presentation: {kind:"docked", edge}.

Shelf membership does not modify presentation or collapsed; restoring simply removes the ref from the shelf.

Maximisation stores the prior typed presentation in beforeMaximise, so dock→maximise→restore returns to the same edge.

Groups are the sole authority for group order and membership. The shelf is the sole authority for minimised membership. Validation rejects any ref appearing in two groups or in both a group and the shelf.

2. Intent envelope and operation set

All structural operations use one idempotent endpoint:

http
POST /api/workspace/v4/intents
JSON
{
  "actorId": "browser-installation-uuid",
  "intentId": "operation-uuid",
  "knownStructuralRevision": 88,
  "op": {
    "kind": "shelf.minimise",
    "window": {
      "windowId": "window_layers",
      "generation": 3,
      "incarnationId": "01J..."
    }
  }
}

knownStructuralRevision is advisory synchronization context, not a blanket compare-and-swap requirement. Correctness comes from the generation and entity preconditions below.

Intent	Required payload and atomic effect
window.create	{windowId, incarnationId, expectedLastGeneration, type, space, entityRef, presentation, spatial, flags}. Assign generation = lastGeneration + 1; repeated creation with the same incarnation returns the same result.
window.close	{window: WindowRef}. Remove the exact incarnation from any group and shelf, clear active focus, delete the live row, and write its tombstone in one commit.
window.setPresentation	`{window, mode:"floating"
window.setFlags	{window, patch:{collapsed?,pinned?,locked?}, expectedStructureVersion}. Avoid last-writer overwrites of independent flags.
shelf.minimise	{window}. Remove the ref from its group, repair the group active member or dissolve it, then add the ref once to the shelf. Preserve presentation and user collapse.
shelf.restore	`{window, mode:"resume"
group.create	{members:[WindowRef...], active, expectedContainers?}. Atomically detach every member from prior groups/shelf and create one ordered group.
group.join	`{member, target:{window?:WindowRef,groupId?}, position:"end"
group.leave	`{member, expectedGroupId, mode:"resume"
group.activate	{groupId, member}. Last-write-wins only while the member remains in that group.
group.reorder	`{groupId, member, before:null
group.dissolve	{groupId, expectedGroupVersion}. Return members to their latent presentations and delete the group.
focus.set	`{window:null

A successful response returns only canonical affected records and the receipt:

JSON
{
  "ok": true,
  "actorId": "browser-installation-uuid",
  "intentId": "operation-uuid",
  "duplicate": false,
  "structuralRevision": 92,
  "spatialRevision": 645,
  "changed": {
    "windows": [],
    "groups": [],
    "shelf": {"version": 19, "members": []},
    "tombstones": []
  },
  "receipt": {
    "kind": "shelf.minimise",
    "appliedAt": "2026-08-27T00:00:00.000Z"
  }
}

The server retains an intent-receipt ledger keyed by (actorId, intentId). Repeating the same key and same body returns the original response without a revision bump. Reusing the key with a different body returns 409 IDEMPOTENCY_KEY_REUSED. The incarnation ID independently protects window.create after an old receipt has been compacted.

3. Spatial and viewport surface

Spatial and viewport traffic must not use the structural intent revision:

http
PATCH /api/workspace/v4/windows/{windowId}/{generation}/spatial
PUT   /api/workspace/v4/viewport
GET   /api/workspace/v4
GET   /api/workspace/v4/intents/{actorId}/{intentId}

Spatial request:

JSON
{
  "incarnationId": "01J...",
  "actorId": "browser-installation-uuid",
  "mutationId": "drag-uuid",
  "patch": {
    "x": 140,
    "y": 180,
    "width": 420,
    "height": 330,
    "zIndex": 21
  }
}

For the same live incarnation, spatial writes remain arrival-order last-write-wins and increment only that window’s spatialVersion plus the aggregate spatialRevision. mutationId deduplicates a retry after a lost response. A closed or replaced incarnation returns 410 WINDOW_GENERATION_GONE; it never creates a row. Viewport writes increment only viewportRevision.

A structural intent that also requires placement—shelf.restore with floatingAt or group.leave with a drop point—commits the structural and spatial components atomically and increments both revision domains.

4. Conflict and merge semantics

The protocol should use explicit machine-readable outcomes:

Duplicate intent: return the original receipt and canonical result.

Close of the same tombstoned incarnation: idempotent success.

Operation against an older/tombstoned generation: 410 WINDOW_GENERATION_GONE with the tombstone.

Operation against a logical ID that now has a newer incarnation: 409 INCARNATION_REPLACED with the current live ref.

Member moved to another group or shelf before an operation: 409 CONTAINER_CHANGED with the current group/shelf records.

Stale reorder or dissolve: 409 GROUP_CHANGED with the current group and version.

Invalid dock edge or presentation: 422 PRESENTATION_NOT_ALLOWED.

Two disjoint intents: merge regardless of an old knownStructuralRevision.

Two group.join ... position:"end" intents for distinct free members: both may commit in server arrival order if the target group still exists.

Relative-position join or reorder: require expectedGroupVersion.

group.activate: last-write-wins while membership is still valid.

Close racing minimise/group join: close removes whichever current container won first; the later container operation receives 410.

Transport failure: retry the same intentId; never manufacture a new intent or replay a stale full collection.

This eliminates the current second-conflict problem because unrelated writes no longer invalidate the operation. It also prevents the existing group/shelf whole-array retry from overwriting another client’s disjoint edit. The present routes and storage model use a single revision and whole collections, so these semantics cannot be layered safely onto the current request shape.

5. Client adoption and durable outbox

Each browser installation creates a persistent actorId. Before applying an optimistic structural change, the client writes the full intent to an IndexedDB outbox. The rules are:

Optimistically update the rendered model, but retain the canonical incarnation and a visible pending marker.

A close may remove the frame visually, but the manager retains a pending-close record and blocks reopening that logical ID until the server resolves it.

Send intents in local order where user intent requires ordering; correctness must not depend on that order relative to other writers.

On success or duplicate success, replace every returned affected entity—do not merge or resend local group/shelf arrays—then delete the outbox entry.

On transport failure, retain and retry the same intent.

On 409 or 410, adopt the supplied canonical entities and mark the local intent conflicted or obsolete. Do not blindly replay it under a new revision.

On boot, reconcile/replay the outbox before auto-opening default windows.

Apply spatial responses only when their generation matches and their spatialVersion is not older than the currently adopted version.

Keep warnings in a user-recoverable persistence-status surface; console.warn is diagnostic evidence, not lifecycle recovery.

Partner action receipts and inverses must store WindowRef, not only targetId. A revert targeting a closed and reopened logical window must fail with INCARNATION_REPLACED rather than moving the new incarnation. The existing Partner executor stores and applies targetId-based workspace actions, so it must be routed through the same v4 executor.

6. Migration and legacy compatibility

Perform one server-side v3→v4 migration with an exact .pre-v4.bak backup and atomic replacement:

Assign generation 1 and a persisted incarnation ID to every live v3 row.

Convert valid state:"docked" rows to typed dock presentations.

Convert maximised rows to maximised presentation with a floating fallback, because v3 does not durably store the prior presentation.

Put state:"minimised" refs on the canonical shelf while retaining a valid dock presentation for later resume; invalid edges become floating.

Build canonical groups from groups[]; remove duplicate membership deterministically in stored group order and write a migration-repair receipt.

When a ref is both grouped and shelved, shelf ownership wins and the ref is removed from its group, preserving recoverability.

Repair active members and dissolve empty groups.

Do not carry minimisation-derived collapsed:true into the user-collapse flag.

Remove writable window.groupId, state, and free-standing dock from canonical storage.

Keep the existing external surfaces during migration:

GET /api/workspace continues returning a schema-v3 projection, including derived windows[].state, window.groupId, dock, shelf.windowIds, objects, and revision: legacyRevision. New clients use GET /api/workspace/v4.

POST /api/workspace/object becomes a compatibility adapter:

Existing live legacy world_* and panel_* rows may receive spatial and presentation updates.

Missing legacy IDs with no identity history may create generation 1 through a synthetic v4 create intent.

A missing ID with a tombstone may never be recreated through this route.

Missing window_* IDs are rejected with 410; the freeform manager must use window.create.

The adapter internally executes one transaction and updates legacyRevision, even though it may increment separate structural/spatial revisions.

/api/workspace/groups, /api/workspace/shelf, and /api/workspace/window/delete remain temporary compatibility adapters. They accept the current baseRevision against legacyRevision, compute the requested diff, and execute corresponding v4 intents atomically. They return the existing v3 projection and deprecation metadata. Once WindowManager is migrated, these routes should have no current-tree freeform caller.

CreativeDesk and WorkspaceShell may continue using their existing API initially, because their IDs are constrained legacy namespaces. Their compatibility writes must still be generation-aware internally and tombstone-safe.

Partner actions keep their public approve/execute/accept/revert API, but workspace.applyAction() becomes a v4 intent client. Receipts and inverses include the exact generation.

Migration order inside Stage 1:

Land schema v4, migration, canonical validator, intent executor, and legacy projections.

Add protocol/property tests and dual-client concurrency tests.

Move WindowManager to v4 create/intent/spatial APIs and durable outbox.

Route Partner workspace actions through the v4 executor.

Leave CreativeDesk and WorkspaceShell on adapters until Stages 2 and 3.

Remove collection-replacement routes only after repository search proves no caller remains.

7. Race-to-mechanism map
Existing race or invariant failure	Stage‑1 mechanism that eliminates it
Open followed by immediate close	Ordered intent outbox plus close of the exact generation
Lost create response	Stable incarnation ID and idempotent intent receipt
Lost delete response / retry 5xx	Same-intent replay and receipt lookup
Stale tab or Partner update resurrects a closed row	Tombstone plus mandatory generation on every update
Second unrelated revision change defeats delete retry	Entity intent; no global structural compare-and-swap
Pan or legacy drag invalidates group/shelf request	Separate spatial, viewport, and structural revisions
Two disjoint group edits overwrite each other	Member-level intents and per-group versions
Minimise leaves a window grouped	Atomic shelf.minimise
Duplicate/multi-group membership	One canonical group collection plus global validator
Dock→maximise loses dock	Typed presentation plus beforeMaximise
Shelf restore produces stale or forbidden dock	Policy-validated latent presentation
Partner inverse mutates a reopened window	Generation-bearing inverse receipt
Legacy upsert recreates a tombstoned freeform ID	Tombstone-aware compatibility adapter

Stage 1 deliberately does not solve world projection, duplicate UI ownership, group-frame geometry, viewport recovery, or accessibility. Those remain the ordered Stages 2–6.

TOP‑3 next work items

Implement the Stage‑1 identity-safe intent protocol — very high impact / medium-to-high effort.
Acceptance criterion: Immediate close, lost responses, repeated retries, stale tabs, Partner execution/revert, simultaneous clients, group changes, and shelf changes complete without resurrection, invalid hybrid ownership, unrelated conflicts, or lost disjoint edits. Every successful or conflicted operation returns canonical affected entities and an idempotent receipt.

Unify every creative surface onto canonical world coordinates — highest architectural impact / high effort.
Acceptance criterion: Creative windows preserve their relationship to artwork through pan, zoom, viewport resize, docking, grouping, shelving, maximisation, reload, and restoration without rewriting canonical geometry. Only explicitly designated application chrome remains screen-fixed.

Retire bespoke surface ownership before building the first-class group frame — high impact / medium effort.
Acceptance criterion: Freeform mode has one controller, one DOM owner, one listener set, and one persistence writer for each logical surface. Shot switching, Partner refreshes, close/reopen, and reload continue through stable façades with no orphaned legacy owners or panel_* writes for registry-owned surfaces.