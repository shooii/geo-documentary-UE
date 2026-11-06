# Boundary schema

Normalize every region to EPSG:4326 and store:

- stable geographic code, name, normalized `levelRole`, official `levelName`, and parent ID;
- original and display geometry paths;
- center, representative label point, bbox, and area;
- source CRS and source record;
- source format, complete source-file list, DBF encoding when applicable, and any verified name-correction map;
- recommended camera preset;
- `boundaryUnitIds` for every reliable displayed polygon unit, `tourChildIds` for narrated destinations, coverage-manifest status, narrated feature IDs, and content references;
- supplemental-unit role/classification, such as `supplemental-management-unit` and `forest-farm-management-unit`, with default label/tour policy.

Validate geometry type, coordinate range, self-intersection, MultiPolygon handling, interior rings, duplicate IDs, parent-child relationships, gaps, overlaps, and role transitions. Preserve the original high-resolution data before simplification. Simplify a valid polygon coverage as one shared-edge-preserving set; never simplify neighboring administrative features independently.

For SHP input, store `.shp/.shx/.dbf/.prj` paths and `.cpg` when present. Distinguish an independently sourced parent boundary from a parent dissolved from child features.

Store parent display geometry separately from child boundaries so the parent can be revealed first. For each narrated river, mountain, lake, bay, island, ridge, road, port, or settlement, store a feature record with type-appropriate geometry, aliases, source, label point, and cue references. Do not represent a river only as a label or a mountain range only as an arbitrary point when better geometry exists.

GeoJSON used in a formal capture must pass the project validator and produce a quality report.
