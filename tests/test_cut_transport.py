import base64
import copy
import gzip
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from processor.cut_transport import COMPRESSED_PREFIX, MAXIMUM_DECOMPRESSED_BYTES, decode_cuts_json
from processor.render_batch import main, normalizar_cortes


def encoded(payload):
    return COMPRESSED_PREFIX + base64.b64encode(gzip.compress(payload, mtime=0)).decode("ascii")


class CutTransportTests(unittest.TestCase):
    def test_shared_node_fixture_arrives_as_forty_intact_plans_and_preserves_array_dict_compatibility(self):
        fixture = json.loads((Path(__file__).parent / "fixtures" / "editorial-transport-40.json").read_text(encoding="utf-8"))
        expected = []
        for index in range(fixture["count"]):
            cut = copy.deepcopy(fixture["template"])
            cut["titulo"] = f"Corte {index + 1:02d}: {fixture['template']['titulo']}"
            expected.append(cut)
        raw = decode_cuts_json(fixture["transport"])
        self.assertGreater(len(raw), 60_000)
        self.assertEqual(json.loads(raw), expected)
        normalized_plain = normalizar_cortes(raw)
        normalized_compressed = normalizar_cortes(fixture["transport"])
        self.assertEqual(normalized_compressed, normalized_plain)
        self.assertEqual(len(normalized_compressed), 40)
        self.assertEqual(normalized_compressed[39]["editorial"]["scenes"][0]["text"], expected[39]["editorial"]["scenes"][0]["text"])
        wrapped = json.dumps({"cortes": expected}, ensure_ascii=False)
        self.assertEqual(normalizar_cortes(wrapped), normalized_plain)
        self.assertEqual(normalizar_cortes(encoded(wrapped.encode("utf-8"))), normalized_plain)
        self.assertEqual(decode_cuts_json(wrapped), wrapped)

    def test_invalid_or_oversized_compressed_payloads_fail_before_drive_or_rendering(self):
        valid_gzip = gzip.compress(b"[]", mtime=0)
        cases = [
            (COMPRESSED_PREFIX + "@@@", "base64 inválido"),
            (COMPRESSED_PREFIX, "gzip inválido"),
            (COMPRESSED_PREFIX + base64.b64encode(b"not-gzip").decode(), "gzip inválido"),
            (COMPRESSED_PREFIX + base64.b64encode(valid_gzip[:-4]).decode(), "gzip inválido"),
            (encoded(b"x" * (MAXIMUM_DECOMPRESSED_BYTES + 1)), "512000 bytes"),
            (encoded(b"\xff"), "UTF-8 válido"),
            (COMPRESSED_PREFIX + "A" * 60_000, "60000 caracteres"),
        ]
        for raw, expected_error in cases:
            args = ["render_batch", "--request-id", "test", "--folder-id", "folder",
                    "--video-file-id", "source", "--transcript-json-file-id", "transcript",
                    "--cuts-json", raw, "--workdir", ".work-invalid-transport-test",
                    "--output", ".output-invalid-transport-test"]
            with self.subTest(error=expected_error), patch("sys.argv", args), \
                    patch("processor.render_batch.Path.mkdir"), patch("processor.render_batch.shutil.rmtree"), \
                    patch("processor.render_batch.start_heartbeat"), patch("processor.render_batch.failed"), \
                    patch("processor.render_batch.uploader_por_env") as uploader, \
                    patch("processor.render_batch.render_editorial_cut") as renderer:
                with self.assertRaisesRegex(ValueError, expected_error):
                    main()
                uploader.assert_not_called()
                renderer.assert_not_called()

    def test_exact_expansion_limit_is_accepted_but_oversized_concatenated_members_are_rejected(self):
        raw = b" " * MAXIMUM_DECOMPRESSED_BYTES
        self.assertEqual(len(decode_cuts_json(encoded(raw)).encode("utf-8")), MAXIMUM_DECOMPRESSED_BYTES)
        joined = gzip.compress(raw, mtime=0) + gzip.compress(b"x", mtime=0)
        with self.assertRaisesRegex(ValueError, "512000 bytes"):
            decode_cuts_json(COMPRESSED_PREFIX + base64.b64encode(joined).decode("ascii"))


if __name__ == "__main__":
    unittest.main()
