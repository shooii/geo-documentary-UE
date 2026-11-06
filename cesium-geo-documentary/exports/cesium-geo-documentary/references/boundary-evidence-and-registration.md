# Boundary evidence, SHP ingestion, and map registration

## Source priority and hard stop

Use boundary evidence in this order:

1. Statutory or official GIS services and files: WFS, GeoJSON, GPKG, SHP, geodatabases, or downloadable open-data packages.
2. Credible public administrative-boundary datasets with documented date, level, and limitations.
3. Official planning atlases or PDF maps that visibly contain the required boundary level.

If none can produce a reliable boundary, stop formal generation. Never use Voronoi cells, centroid partitions, hand drawing, visual guessing, road buffers, or interpolated polygons as administrative boundaries.

## ESRI Shapefile contract

Treat a Shapefile as a multi-file dataset, not a lone `.shp` file.

- Require `.shp`, `.shx`, `.dbf`, and `.prj`. Read `.cpg` when present. Record optional `.sbn`, `.sbx`, and metadata files without requiring them.
- Preserve every original sidecar unchanged. Write normalized output to a separate directory.
- Detect the DBF encoding from `.cpg`; otherwise use a declared encoding. Fail if names contain replacement glyphs, mojibake, or Unicode private-use characters until a verified ID-to-name correction map is supplied.
- Parse the `.prj`, record the source CRS, and transform with `always_xy` semantics to EPSG:4326. Never infer latitude/longitude merely because coordinate values look plausible.
- Require polygon or multipolygon geometry for administrative areas. Reject line or point SHP files when area boundaries are expected.
- Preserve stable IDs from an authoritative DBF field. Reject missing and duplicate IDs.
- Run validity repair conservatively, retain the original geometry, and report every changed or simplified feature.
- Treat adjacent administrative polygons as a coverage. Validate the full set with `coverage_is_valid` and simplify it together with `coverage_simplify(..., simplify_boundary=False)`. If the coverage is invalid, keep the original unsimplified geometries and report the topology issue; never fall back to per-feature `simplify` because it can create shared-edge gaps and overlaps.
- Preserve every `MultiPolygon` part and interior ring. Never keep only the largest polygon of a village, forest farm, enclave, island, or management unit.
- Write a parent geometry independently when supplied. If the parent is derived by dissolving child features, label it `union-of-child-shapefile-features`; do not claim it is an independently sourced legal parent boundary.
- Use `scripts/import-shapefile.py` when its field mapping fits the source. Supply `--name-map` for verified DBF name corrections and `--expected-children` when the complete count is known.

## Official PDF or planning-atlas registration

When only an official planning map or PDF contains the required township or village boundaries:

1. Render the selected page at high resolution with the PDF workflow.
2. Confirm that the legend explicitly identifies the needed administrative-boundary class.
3. Choose multiple well-distributed control points from unambiguous coastlines, road intersections, bridges, or settlement centers. Do not cluster all control points in one corner.
4. Register the map, report per-point and RMS residuals, and reject a fit that is visually good only near the control points.
5. Vectorize the official lines, close polygons along the actual mapped boundaries, and clip exactly to the verified parent boundary.
6. Label the result `official-planning-map-registered-vectorization`, not a statutory or cadastral boundary.

## Four-part QA gate

All registered or digitized boundary sets must pass:

- Coverage QA: every required child appears exactly once and the parent coverage is complete within the declared tolerance.
- Residual QA: control-point residuals and the transform model are recorded and within the project threshold.
- Topology QA: valid polygons, no unexplained gaps or overlaps, stable IDs, correct containment, and correct multipart/island handling.
- Coverage-preservation QA: compare raw/output coverage validity, point and part counts, sum-area minus union-area, union hole count/area, and parent outer-boundary symmetric difference.
- Visual overlay QA: high-resolution overlays are inspected against the official source map and satellite/coastline context. A 100% numeric coverage result is not sufficient when lines do not follow the official map.

For township boundaries derived from an official planning atlas, inspect every shared line. If any boundary closes along a generated shortcut rather than the official line, do not use it in a formal video.
