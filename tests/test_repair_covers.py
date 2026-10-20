"""Cover repair must never alter videos, sharing, names or parent folders."""
import copy
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from processor import repair_covers as repair


FOLDER = "session_folder_123"
VIDEO = "source_video_1234"
FIRST = "cover_file_000007"
SECOND = "cover_file_000010"


def repairs():
    return [{"file_id": file_id, "aspect": aspect, "cover": {"version": 1,
             "template_id": template, "title": title}, "ranges": [[20, 30]], "source_label": "Papo de Elite"}
            for file_id, aspect, template, title in ((FIRST, "9:16", "01_central", "ACORDO IMPROVÁVEL?"),
                                                    (SECOND, "16:9", "02_lateral", "COMO ELA CONSEGUE SAIR?"))]


class FakeDrive:
    def __init__(self):
        self.events = []
        self.metadata = {FOLDER: {"id": FOLDER, "mimeType": "application/vnd.google-apps.folder"},
                         VIDEO: {"id": VIDEO, "name": "original.mp4", "mimeType": "video/mp4", "parents": [FOLDER]}}
        for file_id in (FIRST, SECOND):
            self.metadata[file_id] = {"id": file_id, "name": f"{file_id}_capa.jpg", "mimeType": "image/jpeg",
                                      "parents": [FOLDER], "md5Checksum": "old-md5", "capabilities": {"canEdit": True}}
        self.service = MagicMock()
        self.files = self.service.files.return_value
        self.files.get.side_effect = self.get
        self.files.update.side_effect = self.update

    def get(self, **kwargs):
        self.events.append(("get", kwargs["fileId"]))
        return SimpleNamespace(execute=lambda **_: copy.deepcopy(self.metadata[kwargs["fileId"]]))

    def update(self, **kwargs):
        self.events.append(("update", kwargs["fileId"]))
        # The only payload is media bytes. No rename, folder, permission or
        # app manifest operation is permitted by this operational tool.
        assert set(kwargs) == {"fileId", "media_body", "fields", "supportsAllDrives"}
        file_id = kwargs["fileId"]
        self.metadata[file_id]["md5Checksum"] = hashlib.md5(Path(kwargs["media_body"].path).read_bytes()).hexdigest()
        return SimpleNamespace(execute=lambda **_: copy.deepcopy(self.metadata[file_id]))

    def download(self, service, file_id, output):
        self.events.append(("download", file_id))
        output.write_bytes(b"original video bytes")

    def render(self, source, ranges, output, **kwargs):
        self.events.append(("render", output.stem))
        output.write_bytes((kwargs["aspect"] + kwargs["cover"]["title"]).encode())
        return {"applied_template": kwargs["cover"]["template_id"], "selection": {"timestamp": 25.0}, "sha256": "sha256-fixture"}


class RepairCoverTests(unittest.TestCase):
    def setUp(self):
        self.drive = FakeDrive()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.download = patch.object(repair, "_download", side_effect=self.drive.download).start()
        self.addCleanup(patch.stopall)
        patch.object(repair.drive, "MediaFileUpload", create=True,
                     side_effect=lambda path, **_: SimpleNamespace(path=path)).start()

    def run_repair(self, data=None, renderer=None):
        return repair.repair_covers(self.drive.service, FOLDER, VIDEO, repairs() if data is None else data,
                                    self.temp.name, renderer=renderer or self.drive.render)

    def test_all_images_are_prepared_before_media_only_updates_and_hash_verified(self):
        before = copy.deepcopy(self.drive.metadata)
        result = self.run_repair()
        actions = [event[0] for event in self.drive.events]
        self.assertLess(max(i for i, action in enumerate(actions) if action == "render"), actions.index("update"))
        self.assertEqual([item["file_id"] for item in result], [FIRST, SECOND])
        self.assertEqual(self.drive.metadata[VIDEO], before[VIDEO])
        for item in result:
            old, new = before[item["file_id"]], self.drive.metadata[item["file_id"]]
            for key in ("id", "name", "parents", "capabilities", "mimeType"):
                self.assertEqual(old[key], new[key])
            self.assertEqual(item["md5"], new["md5Checksum"])
        self.assertTrue((Path(self.temp.name)/"repair-report.json").is_file())
        self.drive.service.permissions.assert_not_called()
        self.drive.files.create.assert_not_called()

    def test_invalid_second_repair_stops_before_any_drive_operation(self):
        for key, value in (("cover", {"version": 1, "template_id": "04_duas_pessoas", "title": "PAR?"}),
                           ("ranges", [[30, 20]]), ("ranges", [[True, 30]]), ("file_id", "../bad"),
                           ("aspect", "1:1"), ("source_label", "label\nsecret")):
            with self.subTest(key=key, value=value):
                data = repairs()
                data[1][key] = value
                with self.assertRaises(ValueError):
                    self.run_repair(data)
                self.drive.service.files.assert_not_called()

    def test_duplicate_destinations_rejected_before_any_drive_operation(self):
        data = repairs()
        data[1]["file_id"] = FIRST
        with self.assertRaisesRegex(ValueError, "duas vezes"):
            self.run_repair(data)
        self.drive.service.files.assert_not_called()

    def test_all_target_metadata_validated_before_download(self):
        original = copy.deepcopy(self.drive.metadata[SECOND])
        for mutation in ({"parents": ["different_folder"]}, {"mimeType": "video/mp4"},
                         {"name": "not-a-cover.jpg"}, {"trashed": True}, {"capabilities": {"canEdit": False}}):
            with self.subTest(mutation=mutation):
                self.drive.metadata[SECOND] = copy.deepcopy(original)
                self.drive.metadata[SECOND].update(mutation)
                with self.assertRaises(ValueError):
                    self.run_repair()
                self.download.assert_not_called()
                self.drive.files.update.assert_not_called()

    def test_source_must_be_video_in_exact_session_folder(self):
        for key, value in (("parents", [FOLDER, "another_parent"]), ("mimeType", "image/jpeg")):
            with self.subTest(key=key):
                original = copy.deepcopy(self.drive.metadata[VIDEO])
                self.drive.metadata[VIDEO][key] = value
                with self.assertRaises(ValueError):
                    self.run_repair()
                self.download.assert_not_called()
                self.drive.metadata[VIDEO] = original

    def test_second_render_failure_does_not_replace_first_cover(self):
        def fail_second(source, ranges, output, **kwargs):
            if SECOND in output.name:
                raise ValueError("no readable source frame")
            return self.drive.render(source, ranges, output, **kwargs)
        with self.assertRaisesRegex(ValueError, "source frame"):
            self.run_repair(renderer=fail_second)
        self.drive.files.update.assert_not_called()

    def test_concurrent_replacement_aborts_before_any_update(self):
        def concurrent_edit(*args, **kwargs):
            report = self.drive.render(*args, **kwargs)
            self.drive.metadata[SECOND]["md5Checksum"] = "newer-external-cover"
            return report
        with self.assertRaisesRegex(ValueError, "mudou durante"):
            self.run_repair(renderer=concurrent_edit)
        self.drive.files.update.assert_not_called()

    def test_server_checksum_mismatch_is_reported(self):
        actual_update = self.drive.update
        def wrong_checksum(**kwargs):
            response = actual_update(**kwargs).execute()
            response["md5Checksum"] = "wrong-checksum"
            return SimpleNamespace(execute=lambda **_: response)
        self.drive.files.update.side_effect = wrong_checksum
        with self.assertRaisesRegex(RuntimeError, "verificar"):
            self.run_repair()
        self.assertEqual(self.drive.files.update.call_count, 1)


if __name__ == "__main__":
    unittest.main()
