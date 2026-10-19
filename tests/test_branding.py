import copy
import json
from pathlib import Path
import tempfile
import unittest

from processor.branding import (
    CHANNEL_BADGE, CHANNEL_HANDLE, CHANNEL_NAME, CHANNEL_SIGNATURE,
    ensure_channel_signature, normalize_branding,
)
from processor.captions import escrever_post, escrever_post_youtube
from processor.render_batch import normalizar_cortes


class BrandingTests(unittest.TestCase):
    def test_legacy_publication_references_are_normalized_without_changing_urls_or_other_accounts(self):
        text = (
            "OS4 Cortes: siga @os4.cortes. #OS4CORTES e os4cortes. "
            "@os4cortes_arquivo @os4.cortes.oficial https://github.com/Lucascristao/os4cortes "
            "https://os4cortes.netlify.app/ OS4"
        )
        expected = (
            "OS4 de Direita: siga @os4dedireita. #os4dedireita e os4dedireita. "
            "@os4cortes_arquivo @os4.cortes.oficial https://github.com/Lucascristao/os4cortes "
            "https://os4cortes.netlify.app/ OS4"
        )
        self.assertEqual(normalize_branding(text), expected)
        self.assertEqual(normalize_branding(expected), expected)

    def test_legacy_signature_becomes_current_and_existing_cta_is_not_duplicated(self):
        legacy = "Siga @os4.cortes para mais insights diários sobre negócios e liderança."
        self.assertEqual(ensure_channel_signature(legacy), CHANNEL_SIGNATURE)
        self.assertEqual(ensure_channel_signature(f"{legacy}\n\n{CHANNEL_SIGNATURE}"), CHANNEL_SIGNATURE)
        custom = "Acompanhe @OS4DEDIREITA e participe da conversa."
        self.assertEqual(ensure_channel_signature(custom), custom)
        self.assertEqual(ensure_channel_signature(ensure_channel_signature("Uma análise.")),
                         f"Uma análise.\n\n{CHANNEL_SIGNATURE}")

    def test_both_post_formats_use_current_identity_and_preserve_source_links(self):
        source_url = "https://github.com/Lucascristao/os4cortes"
        with tempfile.TemporaryDirectory() as directory:
            post = escrever_post(
                Path(directory) / "vertical.txt", "OS4 Cortes comenta",
                "Siga @os4.cortes para mais insights diários sobre negócios e liderança.",
                "#politica #OS4CORTES #os4",
            ).read_text(encoding="utf-8")
            self.assertTrue(post.startswith(f"{CHANNEL_NAME} comenta"))
            self.assertEqual(post.count(CHANNEL_HANDLE), 1)
            self.assertIn(CHANNEL_SIGNATURE, post)
            self.assertIn("#politica", post)
            self.assertNotIn("#os4", post.lower())
            youtube = escrever_post_youtube(
                Path(directory) / "youtube.txt", "OS4 Cortes comenta #shorts",
                f"Veja a fonte: {source_url}", ["politica", "os4cortes"],
            ).read_text(encoding="utf-8")
            self.assertIn(CHANNEL_SIGNATURE, youtube)
            self.assertIn(source_url, youtube)
            self.assertNotIn("#shorts", youtube.splitlines()[0])
            self.assertIn("Tags / Palavras-chave: politica, os4dedireita", youtube)

    def test_batch_updates_owned_metadata_and_preserves_literal_editorial_source_and_speech(self):
        plan = {
            "version": 1, "source": {"label": "Fonte OS4 Cortes", "date": "2026-10-18"},
            "scenes": [
                {"id": "opening", "kind": "narration", "text": "O convidado citou OS4 Cortes.",
                 "background": {"start": 1, "end": 4},
                 "visual": {"title": "O que foi dito?", "lines": []},
                 "tts": {"delivery": "question"}, "evidence": [{"start": 1, "end": 4}]},
                {"id": "source", "kind": "clip", "start": 1, "end": 4},
            ],
        }
        cut = {"titulo": "OS4 Cortes comenta", "inicio": 0, "fim": 10,
               "descricao": "Canal OS4 Cortes", "legenda_post": "Acompanhe @os4cortes",
               "tags": ["#os4cortes", "politica"], "editorial": plan}
        before = copy.deepcopy(cut)
        result = normalizar_cortes(json.dumps([cut]))[0]
        self.assertEqual(cut, before)
        self.assertEqual(result["titulo"], f"{CHANNEL_NAME} comenta")
        self.assertEqual(result["descricao"], f"Canal {CHANNEL_NAME}")
        self.assertEqual(result["legenda_post"], f"Acompanhe {CHANNEL_HANDLE}")
        self.assertEqual(result["tags"], ["#os4dedireita", "politica"])
        self.assertEqual(result["editorial"]["source"], plan["source"])
        self.assertEqual(result["editorial"]["scenes"][0]["text"], plan["scenes"][0]["text"])

    def test_editorial_badge_uses_new_name_and_preserves_pure_os4_logo_text(self):
        from processor.editorial_visuals import EditorialScene
        self.assertEqual(EditorialScene(title="Uma análise").brand, CHANNEL_BADGE)
        self.assertEqual(EditorialScene(title="Uma análise", brand="OS4 CORTES").brand, CHANNEL_NAME)
        self.assertEqual(EditorialScene(title="Uma análise", brand="OS4").brand, "OS4")


if __name__ == "__main__":
    unittest.main()
