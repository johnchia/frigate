import random
import unittest
from typing import Any

import numpy as np

from frigate.track.tracked_object import TrackedObjectAttribute
from frigate.util.object import (
    GRID_SIZE,
    REGION_SOURCE_MOTION,
    REGION_SOURCE_STARTUP,
    REGION_SOURCE_TRACKED,
    average_boxes,
    grid_peak_density,
    rank_regions,
    region_prior,
)


def empty_region_grid() -> list[list[dict[str, Any]]]:
    """Build a region grid with no history, indexed as grid[x][y]."""
    return [[{"sizes": []} for _ in range(GRID_SIZE)] for _ in range(GRID_SIZE)]


class TestBoxStatistics(unittest.TestCase):
    def test_average_boxes_matches_numpy(self) -> None:
        rng = random.Random(0)
        for _ in range(5000):
            boxes = [
                [rng.randint(0, 4000) for _ in range(4)]
                for _ in range(rng.randint(1, 10))
            ]
            expected = [float(np.mean([b[i] for b in boxes])) for i in range(4)]
            self.assertEqual(average_boxes(boxes), expected)


class TestAttribute(unittest.TestCase):
    def test_overlapping_object_selection(self) -> None:
        attribute = TrackedObjectAttribute(
            (
                "amazon",
                0.80078125,
                (847, 242, 883, 255),
                468,
                2.769230769230769,
                (702, 134, 1050, 482),
            )
        )
        objects = [
            {
                "label": "car",
                "score": 0.98828125,
                "box": (728, 223, 1266, 719),
                "area": 266848,
                "ratio": 1.0846774193548387,
                "region": (349, 0, 1397, 1048),
                "frame_time": 1727785394.498972,
                "centroid": (997, 471),
                "id": "1727785349.150633-408hal",
                "start_time": 1727785349.150633,
                "motionless_count": 362,
                "position_changes": 0,
                "score_history": [0.98828125, 0.95703125, 0.98828125, 0.98828125],
            },
            {
                "label": "person",
                "score": 0.76953125,
                "box": (826, 172, 939, 417),
                "area": 27685,
                "ratio": 0.46122448979591835,
                "region": (702, 134, 1050, 482),
                "frame_time": 1727785394.498972,
                "centroid": (882, 294),
                "id": "1727785390.499768-9fbhem",
                "start_time": 1727785390.499768,
                "motionless_count": 2,
                "position_changes": 1,
                "score_history": [0.8828125, 0.83984375, 0.91796875, 0.94140625],
            },
        ]
        assert attribute.find_best_object(objects) == "1727785390.499768-9fbhem"


class TestRegionPrior(unittest.TestCase):
    # (height, width); GRID_SIZE of 8 gives 80px wide by 60px tall cells
    frame_shape = (480, 640)

    def test_cold_grid_scores_zero(self) -> None:
        grid = empty_region_grid()
        self.assertEqual(region_prior([0, 0, 100, 100], self.frame_shape, grid), 0.0)

    def test_density_increases_with_history(self) -> None:
        region = [510, 80, 530, 100]

        # the second populated cell holds the normalizer steady across both grids
        sparse = empty_region_grid()
        sparse[6][1]["sizes"] = [0.1]
        sparse[0][0]["sizes"] = [0.1] * 10

        busy = empty_region_grid()
        busy[6][1]["sizes"] = [0.1] * 5
        busy[0][0]["sizes"] = [0.1] * 10

        self.assertLess(
            region_prior(region, self.frame_shape, sparse),
            region_prior(region, self.frame_shape, busy),
        )

    def test_uses_x_y_indexing(self) -> None:
        """Guard against transposing the grid: it is indexed grid[x][y].

        Mirrors get_region_from_grid, which derives its first index from the
        horizontal centroid and its second from the vertical one.
        """
        # column 6, row 1 covers x in [480, 560) and y in [60, 120)
        grid = empty_region_grid()
        grid[6][1]["sizes"] = [0.1] * 4
        region = [510, 80, 530, 100]

        self.assertGreater(region_prior(region, self.frame_shape, grid), 0.0)

        transposed = empty_region_grid()
        transposed[1][6]["sizes"] = [0.1] * 4

        self.assertEqual(region_prior(region, self.frame_shape, transposed), 0.0)

    def test_clamps_regions_running_past_the_frame(self) -> None:
        grid = empty_region_grid()
        grid[GRID_SIZE - 1][GRID_SIZE - 1]["sizes"] = [0.1]

        self.assertGreater(
            region_prior([600, 450, 900, 700], self.frame_shape, grid), 0.0
        )

    def test_peak_density(self) -> None:
        self.assertEqual(grid_peak_density(empty_region_grid()), 0)

        grid = empty_region_grid()
        grid[2][3]["sizes"] = [0.1] * 7
        grid[5][5]["sizes"] = [0.1] * 2

        self.assertEqual(grid_peak_density(grid), 7)

    def test_precomputed_peak_matches_internal(self) -> None:
        """rank_sourced_regions hoists this out of the per region path."""
        grid = empty_region_grid()
        grid[6][1]["sizes"] = [0.1] * 4
        grid[0][0]["sizes"] = [0.1] * 9
        region = [510, 80, 530, 100]

        self.assertEqual(
            region_prior(region, self.frame_shape, grid),
            region_prior(region, self.frame_shape, grid, grid_peak_density(grid)),
        )


class TestRankRegions(unittest.TestCase):
    frame_shape = (480, 640)

    def test_tracked_regions_precede_motion_and_startup(self) -> None:
        tracked = [100, 100, 140, 140]
        motion = [0, 0, 40, 40]
        startup = [200, 200, 240, 240]

        ordered = rank_regions(
            [
                (REGION_SOURCE_STARTUP, startup),
                (REGION_SOURCE_MOTION, motion),
                (REGION_SOURCE_TRACKED, tracked),
            ],
            self.frame_shape,
            empty_region_grid(),
        )

        self.assertEqual(ordered, [tracked, motion, startup])

    def test_motion_regions_prefer_historically_busy_areas(self) -> None:
        grid = empty_region_grid()
        grid[6][1]["sizes"] = [0.1] * 8

        # equal areas, so only the historical prior separates them
        busy = [510, 80, 530, 100]
        quiet = [10, 300, 30, 320]

        ordered = rank_regions(
            [(REGION_SOURCE_MOTION, quiet), (REGION_SOURCE_MOTION, busy)],
            self.frame_shape,
            grid,
        )

        self.assertEqual(ordered[0], busy)

    def test_cold_grid_falls_back_to_region_size(self) -> None:
        small = [0, 0, 20, 20]
        large = [100, 100, 300, 300]

        ordered = rank_regions(
            [(REGION_SOURCE_MOTION, small), (REGION_SOURCE_MOTION, large)],
            self.frame_shape,
            empty_region_grid(),
        )

        self.assertEqual(ordered[0], large)

    def test_ordering_is_stable_for_equal_scores(self) -> None:
        first = [0, 0, 40, 40]
        second = [40, 0, 80, 40]

        ordered = rank_regions(
            [(REGION_SOURCE_TRACKED, first), (REGION_SOURCE_TRACKED, second)],
            self.frame_shape,
            empty_region_grid(),
        )

        self.assertEqual(ordered, [first, second])

    def test_no_regions(self) -> None:
        self.assertEqual(rank_regions([], self.frame_shape, empty_region_grid()), [])
