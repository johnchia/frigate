"""Unit tests for the region grid API endpoints."""

from datetime import datetime

from fastapi import Request

from frigate.api.auth import get_allowed_cameras_for_filter, get_current_user
from frigate.config.camera.detect import DetectConfig
from frigate.models import Event, Regions, Timeline
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp
from frigate.util.object import GRID_SIZE, get_camera_regions_grid


class TestHttpRegionGrid(BaseTestHttp):
    """Test clearing a camera's region grid."""

    def setUp(self):
        super().setUp([Event, Timeline, Regions])
        self.app = super().create_app()

        async def mock_get_current_user(request: Request):
            return {"username": "admin", "role": "admin"}

        self.app.dependency_overrides[get_current_user] = mock_get_current_user

        async def mock_get_allowed_cameras_for_filter(request: Request):
            return ["front_door"]

        self.app.dependency_overrides[get_allowed_cameras_for_filter] = (
            mock_get_allowed_cameras_for_filter
        )

        self.detect = DetectConfig(width=1920, height=1080)
        self._event_seq = 0

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _seed_history(
        self,
        camera: str = "front_door",
        count: int = 5,
        age: float = 3600,
    ) -> None:
        """Create tracked object history that a grid rebuild would ingest.

        `age` is how many seconds before now the events started. Pass a
        negative value to seed activity that is newer than a clear.
        """
        now = datetime.now().timestamp()

        for i in range(count):
            self._event_seq += 1
            event_id = f"event-{self._event_seq}"
            Event.insert(
                id=event_id,
                label="person",
                camera=camera,
                start_time=now - age + i,
                end_time=now - age + 100 + i,
                top_score=0.8,
                score=0.8,
                false_positive=False,
                zones=[],
                thumbnail="",
                region=[0, 0, 320, 320],
                box=[0, 0, 100, 100],
                area=10000,
                data={},
            ).execute()
            Timeline.insert(
                timestamp=now - age + i,
                camera=camera,
                source="tracked_object",
                source_id=event_id,
                class_type="visible",
                # relative x, y, width, height near the middle of the frame
                data={"box": [0.5, 0.5, 0.1, 0.1]},
            ).execute()

    def _populated_cells(self, grid) -> int:
        return sum(1 for column in grid for cell in column if cell["sizes"])

    def test_grid_is_built_from_history_when_never_created(self):
        """A camera with no stored row bootstraps from its full history."""
        self._seed_history()

        grid = get_camera_regions_grid("front_door", self.detect, 320)

        self.assertEqual(len(grid), GRID_SIZE)
        self.assertGreater(self._populated_cells(grid), 0)

    def test_cleared_grid_is_not_rebuilt_from_old_history(self):
        """Clearing must survive a rebuild.

        The stored row is what tells get_camera_regions_grid how far it has
        already ingested. Deleting it instead of emptying it made the next
        rebuild replay the camera's entire history and restore the grid that
        was just cleared.
        """
        self._seed_history()
        self.assertGreater(
            self._populated_cells(
                get_camera_regions_grid("front_door", self.detect, 320)
            ),
            0,
        )

        client = AuthTestClient(self.app)
        response = client.delete("/front_door/region_grid")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])

        rebuilt = get_camera_regions_grid("front_door", self.detect, 320)

        self.assertEqual(len(rebuilt), GRID_SIZE)
        self.assertEqual(self._populated_cells(rebuilt), 0)

    def test_clear_keeps_the_row_and_stamps_last_update(self):
        """The row is emptied in place rather than removed."""
        self._seed_history()
        get_camera_regions_grid("front_door", self.detect, 320)

        before = datetime.now().timestamp()
        client = AuthTestClient(self.app)
        client.delete("/front_door/region_grid")

        stored = Regions.select().where(Regions.camera == "front_door").get()

        self.assertEqual(self._populated_cells(stored.grid), 0)
        self.assertGreaterEqual(stored.last_update, before)

    def test_new_detections_after_clearing_are_still_learned(self):
        """Clearing resets history without disabling future learning."""
        self._seed_history()
        get_camera_regions_grid("front_door", self.detect, 320)

        client = AuthTestClient(self.app)
        client.delete("/front_door/region_grid")

        # activity newer than the clear, so it falls after the stored last_update
        self._seed_history(count=3, age=-60)
        grid = get_camera_regions_grid("front_door", self.detect, 320)

        self.assertGreater(self._populated_cells(grid), 0)

    def test_clear_unknown_camera_returns_404(self):
        client = AuthTestClient(self.app)
        response = client.delete("/not_a_camera/region_grid")

        self.assertEqual(response.status_code, 404)
        self.assertFalse(response.json()["success"])
