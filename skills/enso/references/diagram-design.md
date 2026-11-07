# Diagram design

Read this when sketching layouts or changing an arrangement. What each element carries is in the skill's "Write on the canvas" section. This file covers where elements go.

## Choose the visual structure

Let the subject determine the form: a journey, state model, comparison, architecture, or another useful arrangement. Screens and states can be Nodes, and actions often work as Link labels. When the question is a delay or failure, show the intermediate states where it happens.

A dominant journey or control flow often benefits from a spine with optional branches beside it. Layers can form columns; parallel modes can form rows; ownership can form clusters. A comparison benefits from corresponding concepts aligned across alternatives. Use a Portal when a separate detail Canvas helps the reader navigate the explanation.

A question about how code behaves, such as "how does deleting work?", usually has several flows. Offer both of these layouts:

- **One row per flow:** each row shows what the user does, what happens, and where it lands.
- **A map of the relevant files:** each file or component the question touches is a Node, and each flow is a path of Links in its own color. Shared Nodes show where flows reach the same component, and separate paths show where they don't.

On the file map, a Mark legend names each flow beside its color, and an Excerpt or Mark at each step says what happens there, so following one color reads as that flow's explanation. Two Nodes hold one Link between them, so a step two flows share gets a neutral color and both flows' names in the legend.

Scale decides the layout. A few flows fit one row per flow. A dozen files fit a file map with colored flows. A whole system needs a cluster per subsystem, with Portals into detail Canvases. When the point is a change, put before and after side by side.

Each Canvas, or each region of a large one, makes one point. Move detail that serves a different point to a Portal.

Choose what each Node represents consistently within a part of the diagram. A state model centers on states and transitions. A navigation map centers on destinations and actions.

The structure works when a reader can find the focal concept or path and the major relationships at a glance.

## Choose objects and appearance

Portals navigate to detail Canvases. Regions clarify meaningful boundaries around nearby elements. Lines can separate lanes or mark a threshold. Proximity and whitespace often communicate grouping on their own.

Set an `appearance` that helps identify each Node. Use `card` for reading text, Symbols for recognizable concepts, and `decision` or `terminal` for branching or endpoints. Reuse an appearance for concepts of the same kind. Consult the chosen command's schema for unfamiliar appearance values.

Use color when it distinguishes a meaningful group or repeated relationship class. Keep the palette learnable. A region's low `fillOpacity`, typically 0.06 to 0.12, keeps its members legible. Neutral Links work for relationships that need only a label and direction.

## Place at a readable scale

Coordinates are world-space centers, except for Marks and Excerpts, whose `x` and `y` place the top-left of their text. On an empty Canvas, place a coherent cluster. On an existing Canvas, inspect element positions and bounds, then anchor changes to neighbors and preserve user adjustments outside the requested change.

Align the main path and place secondary branches nearby. Keep related elements closer together than separate groups. Derive region bounds from member bounds plus padding. A region holds exactly its members: it meets another region only by nesting inside it, and every non-member Node sits clear of it. Favor compact spacing that leaves titles and curves readable. A Canvas can extend beyond one viewport when the explanation needs the space.

The app's default text sizes are 17 World points for Cards and 14 for Symbol titles and Link labels. Symbol glyphs derive their size from the title font size unless explicitly set. Use proportional scaling when the user requests a size adjustment across the diagram.

Place Nodes so Links travel through whitespace. Place each Excerpt beside its Node on the side away from the main path, so it reads with the Node without crossing Links.

## Inspect and repair

Use plain CLI context for element geometry, `context --diagnostics` for mechanical inspection, and `context --vision` for the glance. Each issue includes element IDs in `subjects`, viewport-space `bounds`, and world-space `worldBounds`. Choose moves from inspected positions and world-space bounds.

Diagnostics measure Nodes, Links, and labels. Check regions against the plain context geometry: compare each region's bounds with the other regions and with every non-member Node. Repair a crossing by moving the stray Node clear or redrawing the region from its members' bounds.

Prioritize faults that obstruct reading, such as overlapping Nodes, Links through unrelated Nodes, and unreadable labels. Judge low gaps and crossings by the intended path. Offscreen elements matter when the user requests a single-screen overview or necessary content is clipped; a navigable Canvas can have intentional offscreen content.

Collect related faults into a focused repair, dry-run it, apply it, and check affected diagnostics. Stop when the affected area is readable. If the same obstruction persists after a repair, report it and explain the broader layout change it needs. Diagnostics describe geometry. The glance decides whether the explanation succeeds.
