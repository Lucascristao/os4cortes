"""Offline batch routing, preflight, publisher compatibility and recovery tests."""
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from processor import render_batch as batch
from processor.editorial_plan import editorial_fingerprint
from processor.lower_third import LowerThird


def plan(label="Fonte"):
    return {
        "version": 1, "source": {"label": label, "date": ""},
        "scenes": [
            {"id": "abertura", "kind": "narration", "text": "O que esta fala esclarece?",
             "background": {"start": 10, "end": 13},
             "visual": {"title": "O que foi dito?", "kicker": "SEGUNDO A FONTE", "lines": []},
             "tts": {"delivery": "explain", "cues": []},
             "evidence": [{"start": 10, "end": 14}]},
            {"id": "fala", "kind": "clip", "start": 10.05, "end": 19.95},
        ],
    }


def cut(*, aspect="9:16", editorial=True, label="Fonte"):
    value = {"titulo": "Uma resposta", "inicio": 10, "fim": 20, "formato": aspect,
             "legenda_post": "Comentário próprio e crédito.", "descricao": "Descrição e crédito.",
             "hashtags": ["#assunto"], "tags": ["assunto do vídeo"], "saida_suave": False}
    if editorial:
        value["editorial"] = plan(label)
    return value


class FakeUploader:
    def __init__(self):
        self.downloads = []
        self.uploads = []

    def download(self, file_id, path, progress_cb=None):
        self.downloads.append(file_id)
        Path(path).write_text("{}", encoding="utf-8")

    def upload(self, path, *, folder_id):
        path = Path(path)
        self.uploads.append({"name": path.name, "data": path.read_bytes(), "folder": folder_id})
        return f"file-{len(self.uploads)}"


class Harness:
    def __init__(self, cuts, *, mode=None, key="unit-test-key", extra=()):
        # Keep test-owned data in the checkout; Windows app-container TEMP ACLs
        # can otherwise deny child-directory creation even for offline tests.
        self.temp = tempfile.TemporaryDirectory(prefix=".test-editorial-batch-", dir=Path(__file__).resolve().parents[1])
        self.root = Path(self.temp.name)
        self.work, self.out, self.cache = (self.root/name for name in ("work", "out", ".editorial-cache"))
        self.uploader = FakeUploader()
        self.factory = Mock(return_value=self.uploader)
        self.renderer = Mock(side_effect=self.render)
        self.tracking = Mock(side_effect=self.track)
        self.cinematic = Mock(side_effect=self.track)
        self.completed, self.failed, self.emit = Mock(), Mock(), Mock()
        self.heartbeat = Mock()
        self.argv = ["render_batch", "--request-id", "request", "--folder-id", "folder",
                     "--video-file-id", "video", "--transcript-json-file-id", "transcript",
                     "--cuts-json", json.dumps(cuts), "--workdir", str(self.work),
                     "--output", str(self.out), "--editorial-cache-root", str(self.cache)]
        if mode is not None:
            self.argv += ["--cut-mode", mode]
        self.argv += list(extra)
        self.key = key

    @staticmethod
    def touch(path, data=b"media"):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def render(self, video, transcript, editorial, output, **kwargs):
        voice = Path(kwargs["voice_dir"])
        self.touch(voice/"accepted.wav", b"accepted voice")
        if editorial["source"]["label"] == "Falha":
            raise RuntimeError("Síntese de uma cena rejeitada")
        output = Path(output)
        return {
            "video": self.touch(output), "srt": self.touch(output.with_suffix(".srt"), b"timed captions"),
            "capa": self.touch(output.with_name(output.stem+"_capa.jpg")),
            "report": self.touch(output.with_suffix(".render-report.json"), b"{}"),
        }

    def track(self, video, start, end, output, **kwargs):
        return self.touch(output)

    def captions(self, transcript, video, start, end, **kwargs):
        video = Path(video)
        return (self.touch(video.with_suffix(".srt")),
                self.touch(video.with_name(video.stem+"_legenda.mp4")),
                self.touch(video.with_name(video.stem+"_capa.jpg")))

    def __enter__(self):
        self.stack = ExitStack()
        self.stack.enter_context(patch("sys.argv", self.argv))
        self.stack.enter_context(patch.dict(batch.os.environ, {"GEMINI_API_KEY": self.key}))
        substitutions = {
            "uploader_por_env": self.factory, "save_publisher_manifest": Mock(),
            "start_heartbeat": Mock(return_value=self.heartbeat),
            "completed": self.completed, "failed": self.failed, "emit": self.emit,
            "render_editorial_cut": self.renderer,
            "render_tracking_9x16": self.tracking, "render_cinematic_16x9": self.cinematic,
            "carregar_palavras": Mock(return_value=[{"texto": "fala", "inicio": 10.8, "fim": 19.9}]),
            "criar_legendas_corte": Mock(side_effect=self.captions),
            "criar_srt_limpo": Mock(side_effect=lambda transcript, path, *args: self.touch(path)),
            "gerar_capa_16x9": Mock(side_effect=lambda video, path: self.touch(path)),
            "garantir_archivo_black": Mock(return_value=self.root/"fonts"/"ArchivoBlack-Regular.ttf"),
        }
        for name, value in substitutions.items():
            self.stack.enter_context(patch.object(batch, name, value))
        return self

    def __exit__(self, *args):
        self.stack.__exit__(*args)
        self.temp.cleanup()


class EditorialBatchModesTests(unittest.TestCase):
    def test_editorial_requires_every_plan_before_key_or_drive(self):
        with Harness([cut(), cut(editorial=False)], mode="editorial", key="") as h:
            with self.assertRaisesRegex(ValueError, "Corte 2:.*todos os cortes"):
                batch.main()
            h.factory.assert_not_called()
            h.renderer.assert_not_called()

    def test_editorial_requires_key_before_uploader_or_download(self):
        with Harness([cut()], mode="editorial", key="") as h:
            with self.assertRaisesRegex(RuntimeError, "GEMINI_API_KEY"):
                batch.main()
            h.factory.assert_not_called()
            self.assertFalse(h.uploader.downloads)
            h.renderer.assert_not_called()

    def test_voice_cache_must_stay_outside_temporary_work(self):
        with Harness([cut()], mode="editorial") as h:
            h.argv += ["--editorial-cache-root", str(h.work/"cache")]
            accepted = h.touch(h.work/"cache"/"accepted.wav", b"existing accepted voice")
            with self.assertRaisesRegex(ValueError, "fora do diretório temporário"):
                batch.main()
            h.factory.assert_not_called()
            self.assertTrue(accepted.exists())

    def test_default_simple_routes_both_legacy_formats_without_key_or_compositor(self):
        # Even an incidental plan in a package does not opt the simple mode into TTS.
        with Harness([cut(editorial=False), cut(aspect="16:9")], key="") as h:
            self.assertEqual(batch.main(), 0)
            h.renderer.assert_not_called()
            h.tracking.assert_called_once()
            h.cinematic.assert_called_once()
            batch.garantir_archivo_black.assert_not_called()
            self.assertAlmostEqual(h.tracking.call_args.args[1], 10.72)
            self.assertEqual(h.cinematic.call_args.kwargs["fade_out_visual"], True)
            self.assertNotIn("errors", h.completed.call_args.args[1])
            self.assertIn("2 cortes concluídos", h.completed.call_args.args[0])

    def test_explicit_simple_keeps_legacy_fail_fast(self):
        with Harness([cut(editorial=False), cut(editorial=False)], mode="simple", key="") as h:
            h.tracking.side_effect = RuntimeError("legacy render failed")
            with self.assertRaisesRegex(RuntimeError, "legacy render failed"):
                batch.main()
            self.assertEqual(h.tracking.call_count, 1)
            h.renderer.assert_not_called()
            h.failed.assert_called_once()

    def test_editorial_routes_formats_and_exact_plan_without_silent_span_adjustment(self):
        cuts = [cut(), cut(aspect="16:9")]
        expected = batch.normalizar_cortes(json.dumps(cuts))
        with Harness(cuts, mode="editorial", extra=("--lower-third-mode", "crop", "--lower-third-height", ".30")) as h:
            with patch.object(batch, "ajustar_inicio_sem_silencio", side_effect=AssertionError("must not trim")):
                self.assertEqual(batch.main(), 0)
            self.assertEqual(h.renderer.call_count, 2)
            h.tracking.assert_not_called()
            h.cinematic.assert_not_called()
            for index, call in enumerate(h.renderer.call_args_list):
                self.assertEqual(call.args[2], expected[index]["editorial"])
                self.assertEqual(call.kwargs["aspect"], cuts[index]["formato"])
                self.assertEqual(call.kwargs["lower_third"], LowerThird("crop", .30))
                self.assertEqual(call.kwargs["font_dir"], h.root/"fonts")
                self.assertEqual(call.kwargs["voice_dir"], h.cache/editorial_fingerprint(expected[index]["editorial"])/"voice")
            self.assertFalse(h.work.exists())
            self.assertTrue(list(h.cache.rglob("accepted.wav")))

    def test_editorial_files_and_post_metadata_remain_publisher_compatible(self):
        with Harness([cut(), cut(aspect="16:9")], mode="editorial") as h:
            self.assertEqual(batch.main(), 0)
            names = [item["name"] for item in h.uploader.uploads]
            self.assertTrue(any(name.endswith("_legenda.mp4") for name in names))
            self.assertTrue(any(name.endswith("_16x9.mp4") for name in names))
            self.assertEqual(sum(name.endswith("_post.txt") for name in names), 2)
            self.assertEqual(sum(name.endswith(".srt") for name in names), 2)
            self.assertFalse(any("report" in name or "cache" in name or name.endswith(".wav") for name in names))
            result = h.completed.call_args.args[1]
            self.assertEqual(result["completedCount"], 2)
            self.assertEqual(result["errors"], [])
            for row in result["cuts"]:
                self.assertEqual(row["files"]["videoLegenda"], row["files"]["video"])

    def test_one_editorial_failure_preserves_accepted_voice_and_continues_batch(self):
        with Harness([cut(label="Falha"), cut(label="Aceita")], mode="editorial") as h:
            self.assertEqual(batch.main(), 0)
            self.assertEqual(h.renderer.call_count, 2)
            detail, result = h.completed.call_args.args
            self.assertIn("1/2", detail)
            self.assertNotIn("2 cortes concluídos", detail)
            self.assertEqual([error["index"] for error in result["errors"]], [1])
            self.assertEqual([row["index"] for row in result["cuts"]], [2])
            self.assertEqual(len(list(h.cache.rglob("accepted.wav"))), 2)
            self.assertFalse(h.work.exists())
            self.assertEqual(json.loads((h.out/"render-batch-result.json").read_text(encoding="utf-8"))["errors"], result["errors"])

    def test_all_editorial_failures_report_errors_and_return_failure(self):
        with Harness([cut(label="Falha")], mode="editorial") as h:
            self.assertEqual(batch.main(), 1)
            h.completed.assert_not_called()
            terminal = h.emit.call_args.kwargs
            self.assertEqual(terminal["status"], "error")
            self.assertEqual(terminal["result"]["completedCount"], 0)
            self.assertEqual(len(terminal["result"]["errors"]), 1)
            self.assertTrue((h.out/"render-batch-result.json").exists())

    def test_editorial_upload_failure_is_reported_without_stopping_the_next_cut(self):
        with Harness([cut(), cut()], mode="editorial") as h:
            original_upload = h.uploader.upload
            def upload(path, **kwargs):
                if Path(path).name.startswith("corte_01_"):
                    raise RuntimeError("Falha controlada no upload")
                return original_upload(path, **kwargs)
            h.uploader.upload = upload
            self.assertEqual(batch.main(), 0)
            result = h.completed.call_args.args[1]
            self.assertEqual([row["index"] for row in result["cuts"]], [2])
            self.assertEqual([error["index"] for error in result["errors"]], [1])
            self.assertIn("upload", result["errors"][0]["error"])

    def test_workflow_never_caches_voice_on_public_repositories(self):
        workflow = (Path(__file__).parents[1]/".github/workflows/renderizar.yml").read_text(encoding="utf-8")
        for action in ("actions/cache/restore@v4", "actions/cache/save@v4"):
            prefix = workflow[:workflow.index(action)].split("      - name:")[-1]
            self.assertIn("github.event.repository.private == true", prefix)
            self.assertIn("inputs.cut_mode == 'editorial'", prefix)
        save = workflow[:workflow.index("actions/cache/save@v4")].split("      - name:")[-1]
        self.assertIn("always()", save)
        self.assertIn("${{ inputs.video_file_id }}-${{ github.run_id }}-${{ github.run_attempt }}", workflow)
        self.assertNotIn("actions/upload-artifact", workflow)


if __name__ == "__main__":
    unittest.main()
