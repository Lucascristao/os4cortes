import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from processor.publisher import publisher_manifest, save_publisher_manifest
from processor import progress

class PublisherTests(unittest.TestCase):
    def test_manifest_scoped_to_folder_not_cloud_credentials(self):
        with patch.dict(os.environ, {"OS4_PROGRESS_URL": "https://os4cortes.netlify.app/.netlify/functions/workflow-progress", "GOOGLE_CLIENT_SECRET": "fixture-secret"}):
            expected = hmac.new(b"fixture-secret", b"os4-publisher:folder", hashlib.sha256).hexdigest()
            self.assertEqual(publisher_manifest("folder")["token"], expected)
            self.assertNotEqual(publisher_manifest("other")["token"], expected)
            with tempfile.TemporaryDirectory() as tmp:
                uploader = Mock()
                save_publisher_manifest(uploader, "folder", Path(tmp))
                content = (Path(tmp) / "_os4_publicador.json").read_text()
                self.assertNotIn("fixture-secret", content)
                self.assertEqual(json.loads(content)["folderId"], "folder")
                uploader.upload.assert_called_once()
    def test_heartbeat_does_not_repeat_readiness_and_stops_after_completion(self):
        with patch.object(progress, "_post") as post:
            progress.emit("cortes", 20, ready_cut={"index": 1})
            stop = progress.start_heartbeat(0.01)
            try:
                time.sleep(0.04)
                self.assertGreaterEqual(post.call_count, 2)
                self.assertIn("ready_cut", post.call_args_list[0].args[0])
                self.assertNotIn("ready_cut", post.call_args_list[-1].args[0])
                progress.completed("fim", {})
                count = post.call_count
                time.sleep(0.04)
                self.assertEqual(post.call_count, count)
            finally:
                stop.set()
