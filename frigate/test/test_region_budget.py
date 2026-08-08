import unittest

from frigate.scheduler.budget import RegionBucket, derive_budget
from frigate.util.object import (
    REGION_SOURCE_MOTION,
    REGION_SOURCE_TRACKED,
    apply_region_budget,
)


class TestDeriveBudget(unittest.TestCase):
    def test_no_measurements_yet(self) -> None:
        self.assertIsNone(derive_budget([], 4, 2))
        self.assertIsNone(derive_budget([0.0], 4, 2))

    def test_no_cameras(self) -> None:
        self.assertIsNone(derive_budget([0.01], 0, 2))

    def test_single_detector_single_camera(self) -> None:
        # 10ms per inference is 100/s, less the utilization headroom
        self.assertEqual(derive_budget([0.01], 1, 2), 85)

    def test_capacity_is_split_across_cameras(self) -> None:
        self.assertEqual(derive_budget([0.01], 10, 2), 8)

    def test_detectors_add_capacity(self) -> None:
        self.assertEqual(derive_budget([0.01, 0.01], 1, 2), 170)

    def test_floor_applies_when_oversubscribed(self) -> None:
        # one slow detector shared by many cameras would round down to zero
        self.assertEqual(derive_budget([1.0], 100, 2), 2)


class TestRegionBucket(unittest.TestCase):
    def test_unset_rate_allows_nothing(self) -> None:
        self.assertEqual(RegionBucket().allowance(now=5.0), 0)

    def test_refills_with_elapsed_time(self) -> None:
        bucket = RegionBucket()
        bucket.set_rate(10)
        bucket.tokens = 0.0
        bucket.updated = 0.0

        self.assertEqual(bucket.allowance(now=0.5), 5)

    def test_burst_is_capped_at_one_second(self) -> None:
        bucket = RegionBucket()
        bucket.set_rate(10)
        bucket.tokens = 0.0
        bucket.updated = 0.0

        # a long quiet period must not bank an unbounded balance
        self.assertEqual(bucket.allowance(now=100.0), 10)

    def test_consume_cannot_go_negative(self) -> None:
        bucket = RegionBucket()
        bucket.set_rate(10)
        bucket.tokens = 10.0

        bucket.consume(4)
        self.assertEqual(bucket.tokens, 6.0)

        bucket.consume(100)
        self.assertEqual(bucket.tokens, 0.0)

    def test_lowering_the_rate_drops_a_stale_balance(self) -> None:
        bucket = RegionBucket()
        bucket.set_rate(10)
        bucket.tokens = 10.0

        bucket.set_rate(3)
        self.assertEqual(bucket.tokens, 3.0)


class TestApplyRegionBudget(unittest.TestCase):
    def setUp(self) -> None:
        self.tracked = [0, 0, 10, 10]
        self.motion_a = [10, 0, 20, 10]
        self.motion_b = [20, 0, 30, 10]
        self.motion_c = [30, 0, 40, 10]
        self.ranked = [
            (REGION_SOURCE_TRACKED, self.tracked),
            (REGION_SOURCE_MOTION, self.motion_a),
            (REGION_SOURCE_MOTION, self.motion_b),
            (REGION_SOURCE_MOTION, self.motion_c),
        ]

    def test_allowance_covering_everything_keeps_order(self) -> None:
        self.assertEqual(
            apply_region_budget(self.ranked, 10, 0.1),
            [self.tracked, self.motion_a, self.motion_b, self.motion_c],
        )

    def test_no_allowance_runs_nothing(self) -> None:
        self.assertEqual(apply_region_budget(self.ranked, 0, 0.1), [])

    def test_keeps_the_highest_ranked_regions(self) -> None:
        self.assertEqual(
            apply_region_budget(self.ranked, 2, 0.0),
            [self.tracked, self.motion_a],
        )

    def test_reserves_a_slot_for_the_starved_tail(self) -> None:
        # one of three slots explores, and it comes from the motion tier's tail
        self.assertEqual(
            apply_region_budget(self.ranked, 3, 0.34),
            [self.tracked, self.motion_a, self.motion_c],
        )

    def test_never_gives_up_the_top_region_to_explore(self) -> None:
        self.assertEqual(apply_region_budget(self.ranked, 1, 0.9), [self.tracked])

    def test_no_exploration_without_motion_regions(self) -> None:
        ranked = [
            (REGION_SOURCE_TRACKED, self.tracked),
            (REGION_SOURCE_TRACKED, self.motion_a),
            (REGION_SOURCE_TRACKED, self.motion_b),
        ]

        self.assertEqual(
            apply_region_budget(ranked, 2, 0.5), [self.tracked, self.motion_a]
        )
