# Diagram design

Read this when creating an arrangement or changing its structure. Let the explanation determine the objects and layout.

## Choose the visual structure

A dominant journey or control flow often benefits from a spine with optional branches beside it. Layers can form columns; parallel modes can form rows; ownership can form clusters. A comparison benefits from corresponding concepts aligned across alternatives. Use a Portal when a separate detail Canvas helps the reader navigate the explanation.

Choose what each Node represents consistently within a part of the diagram. A state model centers on states and transitions. A navigation map centers on destinations and actions. Include the intermediate behavior that matters to the user's question. Distinguish observations from hypothesized causes through wording and Note content.

The structure works when a reader can find the focal concept or path and understand the major relationships from the Canvas.

## Choose objects and appearance

Notes carry durable concepts, Links carry visible relationships, and Portals navigate to detail Canvases. Regions clarify meaningful boundaries around nearby elements. Lines can separate lanes or mark a threshold. Proximity and whitespace often communicate grouping on their own.

Set an `appearance` that helps identify each Node. Use `card` for reading text, Symbols for recognizable concepts, and `decision` or `terminal` for branching or endpoints. Reuse an appearance for concepts of the same kind. Read the apply schema for the available values.

Use color when it distinguishes a meaningful group or repeated relationship class. Keep the palette learnable. A region's low `fillOpacity`, typically 0.06 to 0.12, keeps its members legible. Neutral Links work for relationships that need only a label and direction.

## Place at a readable scale

Coordinates are world-space centers. On an empty Canvas, place a coherent cluster. On an existing Canvas, inspect element positions and bounds, then anchor changes to neighbors and preserve user adjustments outside the requested change.

Align the main path and place secondary branches nearby. Keep related elements closer together than separate groups. Derive region bounds from member bounds plus padding. Favor compact spacing that leaves titles and curves readable. A Canvas can extend beyond one viewport when the explanation needs the space.

The app's default text sizes are 17 World points for Cards and 14 for Symbol titles and Link labels. Symbol glyphs derive their size from the title font size unless explicitly set. Use proportional scaling when the user requests a size adjustment across the diagram.

Place Nodes so Links travel through whitespace. Short predicates make curve labels easier to read. Keep explanatory detail in Note prose when it adds little to the visual relationship.

## Inspect and repair

Use CLI context geometry and `data.vision.diagnostics` for mechanical inspection. Each issue includes element IDs in `subjects`, viewport-space `bounds`, and world-space `worldBounds`. Choose moves from inspected positions and world-space bounds.

Prioritize faults that obstruct reading, such as overlapping Nodes, Links through unrelated Nodes, and unreadable labels. Judge low gaps and crossings by the intended path. Offscreen elements matter when the user requests a single-screen overview or necessary content is clipped; a navigable Canvas can have intentional offscreen content.

Collect related faults into a focused repair, dry-run it, apply it, and check affected diagnostics. Stop when the affected area is readable. If the same obstruction persists after a repair, report it and explain the broader layout change it needs. Diagnostics describe geometry; the user's question determines whether the explanation succeeds.
