# Boundary schema

Normalize every region to EPSG:4326 and store:

- stable geographic code, name, normalized `levelRole`, official `levelName`, and parent ID;
- original and display geometry paths;
- center, representative label point, bbox, and area;
- source CRS and source record;
- source format, complete source-file list, DBF encoding when applicable, and any verified name-correction map;
- recommended camera preset;
- child IDs, coverage-manifest status, narrated feature IDs, and content references.

Validate geometry type, coordinate range, self-intersection, MultiPolygon handling, duplicate IDs, parent-child relationships, gaps, overlaps, and role transitions. Preserve the original high-resolution data before simplification.

For SHP input, store `.shp/.shx/.dbf/.prj` paths and `.cpg` when present. Distinguish an independently sourced parent boundary from a parent dissolved from child features.

Store parent display geometry separately from child boundaries so the parent can be revealed first. For each narrated river, mountain, lake, bay, island, ridge, road, port, or settlement, store a feature record with type-appropriate geometry, aliases, source, label point, and cue references. Do not represent a river only as a label or a mountain range only as an arbitrary point when better geometry exists.

GeoJSON used in a formal capture must pass the project validator and produce a quality report.
