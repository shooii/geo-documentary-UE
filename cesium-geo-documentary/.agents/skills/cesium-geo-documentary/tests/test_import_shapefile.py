from __future__ import annotations

import importlib.util
import json
import math
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "import-shapefile.py"
SPEC = importlib.util.spec_from_file_location("import_shapefile", SCRIPT_PATH)
assert SPEC and SPEC.loader
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class CoverageSimplificationTests(unittest.TestCase):
    def test_valid_coverage_simplifies_shared_edges_without_changing_outer_union(self) -> None:
        shared_edge = [(5, 0), (5, 1), (4.9, 2), (5.1, 3), (5, 4), (5, 5)]
        left = IMPORTER.Polygon([(0, 0), *shared_edge, (0, 5), (0, 0)])
        right = IMPORTER.Polygon([(5, 0), (10, 0), (10, 5), (5, 5), *reversed(shared_edge[1:-1]), (5, 0)])

        simplified, report = IMPORTER.simplify_polygon_coverage([left, right], 0.25)

        self.assertTrue(report["rawCoverageValid"])
        self.assertTrue(report["outputCoverageValid"])
        self.assertTrue(report["applied"])
        self.assertEqual(report["mode"], "coverage-preserving")
        self.assertLess(report["outputPointCount"], report["rawPointCount"])
        self.assertAlmostEqual(report["outputSumAreaMinusUnionAreaSourceUnits2"], 0.0, places=9)
        self.assertAlmostEqual(report["outerUnionSymmetricDifferenceSourceUnits2"], 0.0, places=9)
        self.assertTrue(IMPORTER.coverage_is_valid(simplified))

    def test_invalid_coverage_is_not_simplified_feature_by_feature(self) -> None:
        first = IMPORTER.Polygon([(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)])
        overlapping = IMPORTER.Polygon([(1, 0), (3, 0), (3, 2), (1, 2), (1, 0)])

        output, report = IMPORTER.simplify_polygon_coverage([first, overlapping], 1.0)

        self.assertFalse(report["rawCoverageValid"])
        self.assertFalse(report["outputCoverageValid"])
        self.assertFalse(report["applied"])
        self.assertIsNone(report["snapGrid"])
        self.assertFalse(report["snapApplied"])
        self.assertEqual(report["mode"], "skipped-invalid-coverage")
        self.assertTrue(output[0].equals_exact(first, 0.0))
        self.assertTrue(output[1].equals_exact(overlapping, 0.0))
        self.assertEqual(report["outputPointCount"], report["rawPointCount"])

    def test_float_noise_on_a_shared_edge_is_snapped_back_to_a_valid_coverage(self) -> None:
        # Same shape as the coverage-preserving test above, except the right-hand
        # polygon carries the seam a GIS union leaves behind: it overlaps its
        # neighbour by one nanometre. Nothing is visibly wrong, but the polygons
        # are no longer an exact coverage, so coverage_is_valid rejects the set and
        # the importer used to fall back to unsimplified geometry with ok:false.
        shared_edge = [(5, 0), (5, 1), (4.9, 2), (5.1, 3), (5, 4), (5, 5)]
        drifted = [(x - 1e-9 if x == 5 else x, y) for x, y in shared_edge]
        left = IMPORTER.Polygon([(0, 0), *shared_edge, (0, 5), (0, 0)])
        right = IMPORTER.Polygon([*drifted, (10, 5), (10, 0), (5 - 1e-9, 0)])

        self.assertFalse(IMPORTER.coverage_is_valid([left, right]))

        output, report = IMPORTER.simplify_polygon_coverage([left, right], 0.25)

        self.assertFalse(report["rawCoverageValid"])
        self.assertTrue(report["outputCoverageValid"])
        self.assertTrue(report["applied"])
        self.assertEqual(report["snapGrid"], 1e-7)
        self.assertTrue(report["snapApplied"])
        self.assertEqual(report["mode"], "coverage-preserving-after-precision-snap")
        self.assertTrue(IMPORTER.coverage_is_valid(output))
        self.assertLess(report["outputPointCount"], report["rawPointCount"])
        self.assertAlmostEqual(report["outputSumAreaMinusUnionAreaSourceUnits2"], 0.0, places=9)

    def test_the_repair_ladder_never_reaches_past_the_simplification_tolerance(self) -> None:
        self.assertEqual(IMPORTER.coverage_snap_grids(1.0), IMPORTER.COVERAGE_SNAP_GRIDS)
        # A disabled simplification still gets the whole ladder: the snap is then
        # the only thing standing between a hairline hand edit and a failed import.
        self.assertEqual(IMPORTER.coverage_snap_grids(0.0), IMPORTER.COVERAGE_SNAP_GRIDS)
        self.assertEqual(IMPORTER.coverage_snap_grids(0.01), (1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2))
        # 港门镇 needs the coarse end of the ladder, so the cap has to cut there too.
        self.assertEqual(
            IMPORTER.coverage_snap_grids(0.2),
            (1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 5e-2, 7.5e-2, 1e-1, 1.5e-1, 2e-1)
        )
        self.assertEqual(IMPORTER.COVERAGE_SNAP_GRIDS[-1], 2.5e-1)
        self.assertEqual(sorted(IMPORTER.COVERAGE_SNAP_GRIDS), list(IMPORTER.COVERAGE_SNAP_GRIDS))

    def test_a_hairline_overlap_outlives_the_old_ladder_and_the_wider_one_repairs_it(self) -> None:
        # 草潭镇 (440823113) after: neighbouring villages whose seam was edited
        # 2 mm past each other. The old ladder stopped at 1e-5, so every candidate
        # kept the 2 mm sliver and, because `ok` is gated on `outputCoverageValid`,
        # the town aborted with "自动提取乡镇边界失败" even though the defect is
        # invisible on screen. Only the grids added by the widened ladder (1e-2
        # here) round both seams onto the same line and close it.
        left = IMPORTER.Polygon([(0, 0), (5, 0), (5, 5), (0, 5), (0, 0)])
        right = IMPORTER.Polygon([(5 - 0.002, 0), (10, 0), (10, 5), (5 - 0.002, 5), (5 - 0.002, 0)])

        self.assertFalse(IMPORTER.coverage_is_valid([left, right]))
        self.assertFalse(IMPORTER.coverage_is_valid(
            [IMPORTER.polygonal(IMPORTER.set_precision(item, 1e-5)) for item in (left, right)]
        ))

        output, report = IMPORTER.simplify_polygon_coverage([left, right], 1.0)

        self.assertTrue(report["outputCoverageValid"])
        self.assertTrue(report["applied"])
        # A grid the pre-fix ladder never tried - the regression this guards.
        self.assertEqual(report["snapGrid"], 0.01)
        self.assertGreater(report["snapGrid"], 1e-5)
        self.assertEqual(report["snapGridsAttempted"], list(IMPORTER.COVERAGE_SNAP_GRIDS))
        self.assertEqual(report["mode"], "coverage-preserving-after-precision-snap")
        self.assertTrue(IMPORTER.coverage_is_valid(output))
        # The doubled-up sliver is gone: the parent is exactly the two squares.
        self.assertAlmostEqual(IMPORTER.unary_union(output).area, 50.0, places=9)

    def test_a_wider_hairline_seam_is_closed_by_one_of_the_coarser_rungs(self) -> None:
        # 港门镇 (440823112) after: one village's seam was edited a few centimetres
        # past its neighbours'. Every rung at or below the previous 5 cm top keeps a
        # sliver (0.05 m here), and the rung that finally rounds both copies onto the
        # same line is 10 cm - outside the ladder that shipped before 港门镇.
        left = IMPORTER.Polygon([(0, 0), (5, 0), (5, 5), (0, 5), (0, 0)])
        right = IMPORTER.Polygon([(5 - 0.03, 0), (10, 0), (10, 5), (5 - 0.03, 5), (5 - 0.03, 0)])

        self.assertFalse(IMPORTER.coverage_is_valid([left, right]))
        self.assertFalse(IMPORTER.coverage_is_valid([
            IMPORTER.polygonal(IMPORTER.set_precision(item, 5e-2)) for item in (left, right)
        ]))

        output, report = IMPORTER.simplify_polygon_coverage([left, right], 1.0)

        self.assertTrue(report["outputCoverageValid"])
        self.assertTrue(report["applied"])
        self.assertEqual(report["snapGrid"], 1e-1)
        self.assertGreater(report["snapGrid"], 5e-2)
        self.assertEqual(report["mode"], "coverage-preserving-after-precision-snap")
        self.assertTrue(IMPORTER.coverage_is_valid(output))
        self.assertAlmostEqual(IMPORTER.unary_union(output).area, 50.0, places=9)

    def test_a_real_overlap_survives_the_whole_ladder_and_still_fails_the_import(self) -> None:
        # 40 cm of genuine overlap is a topology error, not a hand-edit artefact:
        # the ladder must leave it alone rather than pick a winner for the operator.
        # The widest rung (25 cm) is what decides where that line sits, so the
        # fixture is one rung clear of it - a seam that a snap could close would
        # otherwise be indistinguishable from the hairline this ladder exists for.
        left = IMPORTER.Polygon([(0, 0), (5, 0), (5, 5), (0, 5), (0, 0)])
        right = IMPORTER.Polygon([(4.6, 0), (10, 0), (10, 5), (4.6, 5), (4.6, 0)])

        output, report = IMPORTER.simplify_polygon_coverage([left, right], 1.0)

        self.assertFalse(report["outputCoverageValid"])
        self.assertIsNone(report["snapGrid"])
        self.assertFalse(report["applied"])
        self.assertEqual(report["mode"], "skipped-invalid-coverage")
        self.assertTrue(output[0].equals_exact(left, 0.0))
        self.assertTrue(output[1].equals_exact(right, 0.0))

    def test_a_failed_coverage_is_explained_with_its_numbers_and_the_report(self) -> None:
        # The studio shows this verbatim, so it has to carry the cause and the
        # next step rather than just {"ok": false}.
        message = IMPORTER.describe_failure(
            [{"id": "440823113201", "valid": True}],
            {
                "outputCoverageValid": False,
                "outputUnionHoleAreaSourceUnits2": 0.22014439033163802,
                "rawSumAreaMinusUnionAreaSourceUnits2": 0.23206883668899536,
                "snapGridsAttempted": list(IMPORTER.COVERAGE_SNAP_GRIDS)
            },
            1.6331653625723097e-09,
            "renders/diagnostics/440823113-shapefile-import.json"
        )

        self.assertTrue(message.startswith("自动提取乡镇边界失败："))
        self.assertIn("0.220 平方米缝隙", message)
        self.assertIn("0.232 平方米图斑重叠", message)
        self.assertIn("25 厘米", message)
        self.assertIn("renders/diagnostics/440823113-shapefile-import.json", message)

    def test_a_failed_import_names_the_invalid_village_features(self) -> None:
        message = IMPORTER.describe_failure(
            [{"id": "440823113201", "valid": False}, {"id": "440823113202", "valid": True}],
            {"outputCoverageValid": True},
            0.0,
            "renders/diagnostics/x-shapefile-import.json"
        )

        self.assertIn("1 个村级图斑几何无效", message)
        self.assertIn("440823113201", message)

    def test_hetou_export_keeps_all_reliable_boundary_parts_and_separates_tour_units(self) -> None:
        project_root = IMPORTER.PROJECT_ROOT
        children_document = json.loads(
            (project_root / "data" / "normalized" / "440823114-children.geojson").read_text(encoding="utf-8")
        )
        parent_document = json.loads(
            (project_root / "data" / "normalized" / "440823114.geojson").read_text(encoding="utf-8")
        )
        region = json.loads(
            (project_root / "data" / "regions" / "440823114.json").read_text(encoding="utf-8")
        )

        features = children_document["features"]
        features_by_id = {str(item["properties"]["id"]): item for item in features}
        geometries = [IMPORTER.shape(item["geometry"]) for item in features]
        parent_geometry = IMPORTER.shape(parent_document["features"][0]["geometry"])
        child_union = IMPORTER.polygonal(IMPORTER.unary_union(geometries))

        self.assertEqual(len(features), 13)
        self.assertTrue(IMPORTER.coverage_is_valid(geometries))
        self.assertAlmostEqual(parent_geometry.symmetric_difference(child_union).area, 0.0, places=15)
        self.assertEqual(IMPORTER.polygon_hole_metrics(child_union)[0], 0)
        self.assertEqual(IMPORTER.polygon_part_count(IMPORTER.shape(features_by_id["440823114403"]["geometry"])), 4)
        self.assertEqual(IMPORTER.polygon_part_count(IMPORTER.shape(features_by_id["440823114402"]["geometry"])), 20)

        for unit_id in ["440823114403", "440823114402"]:
            properties = features_by_id[unit_id]["properties"]
            self.assertEqual(properties["unitRole"], "supplemental-management-unit")
            self.assertEqual(properties["classification"], "forest-farm-management-unit")

        self.assertEqual(len(region["tourChildIds"]), 11)
        self.assertEqual(len(region["boundaryUnitIds"]), 13)
        self.assertNotIn("440823114403", region["tourChildIds"])
        self.assertNotIn("440823114402", region["tourChildIds"])
        self.assertIn("440823114403", region["boundaryUnitIds"])
        self.assertIn("440823114402", region["boundaryUnitIds"])
        # Portrait framing is derived from the boundary, so it is not pinned to a
        # literal here: a re-import recomputes it through
        # `portrait_overview_camera`. What has to hold is that the portrait
        # establishing shot is cut from the full-area preset, and that it aims at
        # the boundary the record itself describes -- preserving a profile
        # against a refreshed `center` is exactly how 草潭镇 440823113 ended up
        # framed 873 m west of its own boundary.
        portrait = region["cameraProfiles"]["portrait"]
        self.assertLess(portrait["height"], region["cameraPreset"]["height"])
        self.assertEqual(portrait["pitch"], region["cameraPreset"]["pitch"])
        # Aiming at the boundary means aiming near `center`, but not exactly at
        # it: the target is recentred so the *drawn* box is centred, and a pitched
        # camera's projection is not affine. The bound is well under the 873 m
        # staleness this record once carried.
        target_offset_m = math.hypot(
            (portrait["longitude"] - region["center"][0])
            * 111_320
            * math.cos(math.radians(region["center"][1])),
            (portrait["latitude"] - region["center"][1]) * 110_570,
        )
        self.assertLess(target_offset_m, 1_500)

    def test_the_portrait_camera_centres_the_drawn_extent_not_the_geographic_one(self) -> None:
        # The frame of a pitched camera is a trapezoid, so a target parked on the
        # geographic centre leaves the drawing off centre -- 草潭镇 440823113
        # measured 1.0 % of frame left-right and 2.4 % top-bottom on the shipped
        # player. `portrait_overview_camera` walks the target to the fixed point;
        # replay the camera it returns and the projected box must come back
        # centred, and inside the safe fraction on both axes.
        bounds = (109.7275986, 21.2402835, 109.8682074, 21.3720235)
        camera = IMPORTER.portrait_overview_camera(bounds)

        west, south, east, north = bounds
        latitude = (south + north) / 2
        metres_per_degree_longitude = 111_320 * math.cos(math.radians(latitude))
        centre = [(west + east) / 2, latitude]
        offset_east = (camera["longitude"] - centre[0]) * metres_per_degree_longitude
        offset_north = (camera["latitude"] - centre[1]) * 110_570
        half_width_m = abs(east - west) * metres_per_degree_longitude / 2
        half_height_m = abs(north - south) * 110_570 / 2
        points = [
            (east_m - offset_east, north_m - offset_north)
            for east_m in (-half_width_m, half_width_m)
            for north_m in (-half_height_m, half_height_m)
        ]
        tangent_horizontal, tangent_vertical = IMPORTER._portrait_overview_tangents()
        box = IMPORTER._portrait_overview_projected_box(
            points, camera["height"], tangent_horizontal, tangent_vertical
        )

        self.assertIsNotNone(box)
        min_x, max_x, min_y, max_y = box
        # Within the loop's own convergence tolerance, which is 1e-4 of a
        # half-frame -- 0.005 % of the frame, far inside a pixel.
        tolerance = IMPORTER.PORTRAIT_OVERVIEW_RECENTER_TOLERANCE
        self.assertLessEqual(abs((min_x + max_x) / 2), tolerance)
        self.assertLessEqual(abs((min_y + max_y) / 2), tolerance)
        share = IMPORTER.PORTRAIT_OVERVIEW_SAFE_FRACTION
        self.assertLessEqual(max(abs(min_x), abs(max_x)), share + 1e-6)
        self.assertLessEqual(max(abs(min_y), abs(max_y)), share + 1e-6)
        # The recentring is what earns the tighter fit: the same extent parked on
        # the geographic centre needs a longer range.
        self.assertLess(camera["height"], IMPORTER._portrait_overview_range(
            [(east_m, north_m) for east_m in (-half_width_m, half_width_m) for north_m in (-half_height_m, half_height_m)],
            tangent_horizontal,
            tangent_vertical,
        ))


if __name__ == "__main__":
    unittest.main()
