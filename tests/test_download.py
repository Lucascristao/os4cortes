"""Regressões do download: autenticação, URLs bloqueadas e reutilização local."""
import contextlib
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from yt_dlp import YoutubeDL
from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import DownloadError

from processor import download


URL = "https://www.youtube.com/watch?v=_FpwOK_wLTo"
BOT = "Sign in to confirm you’re not a bot"
FORBIDDEN = "unable to download video data: HTTP Error 403: Forbidden"


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.cookies = self.work / "cookies.txt"
        self.cookies.write_text("fixture-cookie-content", encoding="utf-8")
        self.calls = []

    def run_download(self, outcomes, *, use_pot=True, cookies=True):
        outcomes = iter(outcomes)

        def baixar(url, opts):
            self.assertEqual(url, URL)
            self.calls.append(copy.deepcopy(opts))
            error = next(outcomes)
            if error is not None:
                raise error
            (self.work / "video.mp4").write_bytes(b"complete-video")

        with patch.dict(os.environ, {"YTDLP_USE_POT": "1" if use_pot else "0"}), \
                patch.object(download, "_baixar", side_effect=baixar), \
                contextlib.redirect_stdout(io.StringIO()):
            return download.baixar_youtube(
                URL, self.work, cookies_path=self.cookies if cookies else None, altura_maxima=720,
            )

    def test_public_success_does_not_use_account_cookies(self):
        video = self.run_download([None])
        self.assertEqual(video.read_bytes(), b"complete-video")
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn("cookiefile", self.calls[0])

    def test_bot_check_retries_with_cookies_and_keeps_mweb_and_provider(self):
        self.run_download([DownloadError(BOT), None])
        self.assertEqual(len(self.calls), 2)
        public, authenticated = self.calls
        self.assertNotIn("cookiefile", public)
        self.assertEqual(authenticated["cookiefile"], str(self.cookies))
        self.assertEqual(authenticated["extractor_args"], public["extractor_args"])
        self.assertEqual(authenticated["extractor_args"]["youtube"]["player_client"], ["mweb"])
        self.assertIn("youtubepot-bgutilhttp", authenticated["extractor_args"])
        self.assertTrue(authenticated["verbose"])
        self.assertIn("height<=720", authenticated["format"])
        self.assertEqual(self.cookies.read_text(encoding="utf-8"), "fixture-cookie-content")

    def test_403_after_cookies_tries_safari_with_same_authentication(self):
        self.run_download([DownloadError(BOT), DownloadError(FORBIDDEN), None])
        self.assertEqual(len(self.calls), 3)
        fallback = self.calls[-1]
        self.assertEqual(fallback["extractor_args"]["youtube"]["player_client"], ["web_safari"])
        self.assertEqual(fallback["cookiefile"], str(self.cookies))
        self.assertEqual(fallback["extractor_args"]["youtubepot-bgutilhttp"],
                         self.calls[0]["extractor_args"]["youtubepot-bgutilhttp"])

    def test_missing_or_invalid_cookie_path_still_tries_public_safari(self):
        for cookie_path in (None, self.work / "missing.txt", self.work):
            with self.subTest(cookie_path=cookie_path), \
                    patch.dict(os.environ, {"YTDLP_USE_POT": "1"}), \
                    patch.object(download, "_baixar", side_effect=[DownloadError(BOT), None]) as baixar, \
                    patch.object(download, "achar_video", side_effect=[None, self.work / "video.mp4"]), \
                    contextlib.redirect_stdout(io.StringIO()):
                download.baixar_youtube(URL, self.work, cookies_path=cookie_path)
                self.assertEqual(baixar.call_count, 2)
                for call in baixar.call_args_list:
                    self.assertNotIn("cookiefile", call.args[1])
                self.assertEqual(baixar.call_args.args[1]["extractor_args"]["youtube"]["player_client"],
                                 ["web_safari"])

    def test_unusable_formats_can_fall_back_to_another_client(self):
        self.run_download([DownloadError("Requested format is not available"), None])
        self.assertEqual(len(self.calls), 2)

    def test_permanent_block_is_bounded_and_explains_how_to_refresh_cookies(self):
        last = DownloadError(FORBIDDEN)
        with self.assertRaisesRegex(RuntimeError, "Atualize os cookies.*YOUTUBE_COOKIES_B64") as raised:
            self.run_download([DownloadError(BOT), DownloadError(FORBIDDEN), last])
        self.assertEqual(len(self.calls), 3)
        self.assertIs(raised.exception.__cause__, last)
        self.assertNotIn("fixture-cookie-content", str(raised.exception))

    def test_block_without_cookies_explains_configuration(self):
        with self.assertRaisesRegex(RuntimeError, "Configure cookies.*YOUTUBE_COOKIES_B64"):
            self.run_download([DownloadError(BOT), DownloadError(BOT)], cookies=False)
        self.assertEqual(len(self.calls), 2)

    def test_unrelated_errors_are_not_retried_or_misreported_as_authentication(self):
        for message in ("Video unavailable", "No space left on device", "Postprocessing: ffmpeg failed"):
            with self.subTest(message=message):
                self.calls.clear()
                original = DownloadError(message)
                with self.assertRaises(DownloadError) as raised:
                    self.run_download([original])
                self.assertIs(raised.exception, original)
                self.assertEqual(len(self.calls), 1)

    def test_exhausted_format_fallback_preserves_original_error(self):
        last = DownloadError("Requested format is not available")
        with self.assertRaises(DownloadError) as raised:
            self.run_download([DownloadError("Requested format is not available"), last], cookies=False)
        self.assertIs(raised.exception, last)

    def test_format_probes_do_not_hide_an_earlier_bot_check(self):
        with self.assertRaisesRegex(RuntimeError, "Atualize os cookies.*YOUTUBE_COOKIES_B64"):
            self.run_download([
                DownloadError(BOT), DownloadError("Requested format is not available"),
                DownloadError("Requested format is not available"),
            ])
        self.assertEqual(len(self.calls), 3)

    def test_completed_download_is_reused_without_network(self):
        video = self.work / "video.mp4"
        video.write_bytes(b"approved-base-video")
        self.assertEqual(self.run_download([]), video)
        self.assertEqual(self.calls, [])
        self.assertEqual(video.read_bytes(), b"approved-base-video")

    def test_partial_download_is_not_reused_as_a_complete_video(self):
        (self.work / "video.mp4.part").write_bytes(b"partial")
        self.assertEqual(self.run_download([None]).read_bytes(), b"complete-video")
        self.assertEqual(len(self.calls), 1)

    def test_non_pot_mode_keeps_existing_download_options(self):
        self.run_download([None], use_pot=False)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["cookiefile"], str(self.cookies))
        self.assertNotIn("extractor_args", self.calls[0])
        self.assertNotIn("check_formats", self.calls[0])

    def test_real_ytdlp_skips_403_format_and_downloads_available_format(self):
        """Exercita seleção e download HTTP reais, sem acessar o YouTube."""
        requests = []
        content = b"available-mp4-fixture" * 100

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                if self.path == "/blocked.mp4":
                    self.send_error(403)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}"

        class FixtureIE(InfoExtractor):
            _VALID_URL = r"fixture:(?P<id>download)"

            def _real_extract(self, url):
                return {
                    "id": "download", "title": "Download fixture",
                    "formats": [
                        {"format_id": name, "url": f"{base_url}/{name}.mp4", "ext": "mp4",
                         "height": height, "vcodec": "avc1", "acodec": "mp4a"}
                        for name, height in (("available", 360), ("blocked", 720))
                    ],
                }

        def local_ytdlp(opts):
            ydl = YoutubeDL({**opts, "quiet": True, "verbose": False, "noprogress": True,
                             "proxy": "", "cachedir": False}, auto_init=False)
            ydl.add_info_extractor(FixtureIE())
            return ydl

        output = io.StringIO()
        try:
            with patch.dict(os.environ, {"YTDLP_USE_POT": "1"}), \
                    patch.object(download, "YoutubeDL", side_effect=local_ytdlp), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                video = download.baixar_youtube("fixture:download", self.work)
            self.assertEqual(video.read_bytes(), content)
            self.assertIn("/blocked.mp4", requests)
            self.assertIn("/available.mp4", requests)
        except DownloadError:
            self.fail(f"Requisições: {requests}\n{output.getvalue()}")
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()


if __name__ == "__main__":
    unittest.main()
