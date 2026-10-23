import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from processor.batch_control import BatchControl, BatchStopped
from processor import progress


class BatchControlTests(unittest.TestCase):
    def control(self, output, emitter):
        return BatchControl("request", "folder", output, 5, emitter)

    def test_pause_persists_error_and_ignores_stale_decision(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as tmp:
            decisions = []
            def send(stage, overall, detail, **fields):
                if stage != "aguardando_decisao":
                    return {"control": {"action": "wait", "decisionId": None}}
                persisted = json.loads((Path(tmp)/"render-batch-result.json").read_text(encoding="utf-8"))
                self.assertEqual(persisted["failedCount"], 1)
                self.assertEqual(fields["status"], "paused")
                self.assertEqual(fields["cut_error"]["error"], "quota esgotada")
                decisions.append(fields["decision_id"])
                return {"control": {"action": "continue", "decisionId": "old" if len(decisions) == 1 else fields["decision_id"]}}
            control = self.control(tmp, send)
            with patch("processor.batch_control.callback_configured", return_value=True), \
                    patch("processor.batch_control.latest_control", return_value={}), \
                    patch("processor.batch_control.time.sleep") as sleep:
                control.failed_cut({"titulo": "Corte 1"}, 1, RuntimeError("quota esgotada"))
            self.assertEqual(len(decisions), 2)
            self.assertEqual(decisions[0], decisions[1])
            sleep.assert_called_once()
            self.assertEqual(control.consecutive_failures, 1)

    def test_explicit_stop_after_failure_and_callback_unavailable_both_fail_closed(self):
        for response, expected, calls in (("stop", "cancelled", 1), (None, "error", 3)):
            with self.subTest(response=response), tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as tmp:
                def send(stage, overall, detail, **fields):
                    return None if response is None else {"control": {"action": response, "decisionId": fields["decision_id"]}}
                emitter = Mock(side_effect=send)
                control = self.control(tmp, emitter)
                with patch("processor.batch_control.callback_configured", return_value=True), \
                        patch("processor.batch_control.latest_control", return_value={}), \
                        patch("processor.batch_control.time.sleep"), self.assertRaises(BatchStopped) as raised:
                    control.failed_cut({"titulo": "Corte 1"}, 1, RuntimeError("falha"))
                self.assertEqual(raised.exception.status, expected)
                self.assertEqual(emitter.call_count, calls)
                self.assertEqual(control.errors[0]["index"], 1)

    def test_progress_returns_callback_control_and_keeps_decision_when_heartbeat_waits(self):
        progress._last_control.clear()
        response = {"ok": True, "control": {"action": "stop", "decisionId": "decision"}}
        with patch.object(progress, "_post", return_value=response):
            self.assertEqual(progress.emit("aguardando_decisao", 10, status="paused", decision_id="decision",
                                           cut_error={"index": 1}, completed_count=0, failed_count=1,
                                           consecutive_failures=1), response)
        progress._remember_control({"control": {"action": "wait", "decisionId": None}})
        self.assertEqual(progress.latest_control(), response["control"])
        progress._last_control.clear()

    def test_post_parses_control_json(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"ok":true,"control":{"action":"continue","decisionId":"id"}}'
        with patch.dict(progress.os.environ, {"OS4_PROGRESS_URL": "https://example.com/progress", "OS4_REQUEST_ID": "r", "OS4_CALLBACK_TOKEN": "test-token"}), \
                patch.object(progress.urllib.request, "urlopen", return_value=response):
            self.assertEqual(progress._post({"status": "paused"})["control"]["decisionId"], "id")

    def test_terminal_partial_batch_preserves_saved_percentage_and_failure_counts(self):
        result = {"requestedCount": 5, "completedCount": 2, "failedCount": 3, "consecutiveFailures": 1}
        with patch.object(progress, "emit") as emitter:
            progress.completed("2/5 salvos; 3 falhas", result)
        self.assertEqual(emitter.call_args.args[1], 44.0)
        self.assertEqual(emitter.call_args.kwargs["failed_count"], 3)

    def test_generic_failure_preserves_last_percent_instead_of_signalling_completion(self):
        with patch.object(progress, "_post"):
            progress.emit("preparando_cortes", 2)
        with patch.object(progress, "emit") as emitter:
            progress.failed("Falha antes da renderização", "capa inválida")
        self.assertEqual(emitter.call_args.args[1], 2.0)

    def test_stale_stop_cannot_poison_a_new_decision(self):
        progress._last_control.clear()
        with patch.object(progress, "_post", return_value={"ok": True, "control": {"action": "stop", "decisionId": "old"}}):
            progress.emit("aguardando_decisao", 10, status="paused", decision_id="new")
        self.assertEqual(progress.latest_control(), {})
        progress._last_control.clear()

    def test_heartbeat_stop_remains_visible_to_batch_between_operations(self):
        import time
        progress._last_control.clear()
        with patch.object(progress, "_post", return_value={"ok": True, "control": {"action": "wait", "decisionId": None}}) as post:
            progress.emit("tracking", 10)
            post.return_value = {"ok": True, "control": {"action": "stop", "decisionId": None}}
            stop = progress.start_heartbeat(.01)
            try:
                deadline = time.monotonic() + 1
                while progress.latest_control().get("action") != "stop" and time.monotonic() < deadline:
                    time.sleep(.01)
                with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as tmp:
                    with self.assertRaises(BatchStopped):
                        self.control(tmp, Mock()).check_stop()
            finally:
                stop.set()
                progress._last_control.clear()

    def test_paused_heartbeat_preserves_required_cut_error_and_matching_decision(self):
        import time
        with patch.object(progress, "_post", return_value={"ok": True, "control": {"action": "wait", "decisionId": "id"}}) as post:
            progress.emit("aguardando_decisao", 10, status="paused", decision_id="id", cut_error={"index": 2, "error": "capa"})
            stop = progress.start_heartbeat(.01)
            try:
                deadline = time.monotonic() + 1
                while post.call_count < 2 and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertGreaterEqual(post.call_count, 2)
                heartbeat = post.call_args.args[0]
                self.assertEqual(heartbeat["status"], "paused")
                self.assertEqual(heartbeat["decision_id"], "id")
                self.assertEqual(heartbeat["cut_error"], {"index": 2, "error": "capa"})
                self.assertNotIn("ready_cut", heartbeat)
            finally:
                stop.set()


if __name__ == "__main__":
    unittest.main()
