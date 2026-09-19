import unittest
from processor.captions import CaptionStyle, agrupar_palavras, melhor_quebra, texto_ass_grupo, srt_tempo
from processor.framing import Face, StableFraming


class FramingTests(unittest.TestCase):
    def test_other_person_getting_larger_does_not_steal_target(self):
        framing = StableFraming(0.32)
        left = Face(0.1, 0.2, 0.15, 0.2)
        right = Face(0.65, 0.2, 0.14, 0.2)
        framing.observe([left, right], 0)
        for i in range(1, 60):
            framing.observe([Face(0.58, 0.18, 0.3, 0.35), left], i / 10)
            framing.position(i / 10)
        self.assertLess(framing.center, 0.3)

    def test_brief_loss_holds_position(self):
        framing = StableFraming(0.32)
        framing.observe([Face(0.1, 0.2, 0.15, 0.2)], 0)
        initial = framing.center
        framing.observe([Face(0.7, 0.2, 0.15, 0.2)], 0.4)
        self.assertEqual(framing.position(0.4), initial)

    def test_persistent_replacement_is_acquired(self):
        framing = StableFraming(0.32)
        framing.observe([Face(0.1, 0.2, 0.15, 0.2)], 0)
        for i in range(1, 51):
            framing.observe([Face(0.7, 0.2, 0.15, 0.2)], i / 10)
            framing.position(i / 10)
        self.assertGreater(framing.center, 0.65)

    def test_scene_change_snaps_to_new_subject(self):
        framing = StableFraming(0.32)
        framing.observe([Face(0.1, 0.2, 0.15, 0.2)], 0)
        framing.reset_shot()
        framing.observe([Face(0.7, 0.2, 0.15, 0.2)], 0.04)
        self.assertGreater(framing.position(0.04), 0.7)

    def test_small_head_motion_does_not_move_camera(self):
        framing = StableFraming(0.32)
        framing.observe([Face(0.1, 0.2, 0.15, 0.2)], 0)
        initial = framing.center
        framing.observe([Face(0.11, 0.2, 0.15, 0.2)], 0.1)
        self.assertEqual(framing.position(0.1), initial)

    def test_framing_is_frame_rate_independent(self):
        positions = []
        for fps in [24, 30, 60]:
            framing = StableFraming(0.32)
            framing.observe([Face(0.3, 0.2, 0.15, 0.2)], 0)
            framing.position(0)
            framing.target = Face(0.4, 0.2, 0.15, 0.2)
            for i in range(1, fps + 1):
                framing.position(i / fps)
            positions.append(framing.center)
        self.assertLess(max(positions) - min(positions), 0.005)

    def test_speaking_face_prioritized_over_silent_face(self):
        framing = StableFraming(0.32)
        silent = Face(0.1, 0.2, 0.15, 0.2, confidence=0.9, speaking_score=0.0)
        speaker = Face(0.65, 0.2, 0.14, 0.2, confidence=0.9, speaking_score=0.85)
        framing.observe([silent, speaker], 0)
        self.assertGreater(framing.position(0), 0.65)

    def test_speaker_takes_over_from_silent_listener(self):
        framing = StableFraming(0.32, switch_hold=0.50)
        # Inicialmente apenas o ouvinte está no enquadramento (ouvinte tem rosto maior)
        listener = Face(0.1, 0.2, 0.18, 0.22, confidence=0.9, speaking_score=0.0)
        speaker_silent = Face(0.65, 0.2, 0.14, 0.2, confidence=0.9, speaking_score=0.0)
        framing.observe([listener, speaker_silent], 0)
        self.assertLess(framing.center, 0.3)

        # O falante começa a falar (speaking_score alto), ouvinte continua calado
        for i in range(1, 10):
            t = i * 0.1  # 0.1s até 0.9s
            speaking_face = Face(0.65, 0.2, 0.14, 0.2, confidence=0.9, speaking_score=0.65)
            silent_listener = Face(0.1, 0.2, 0.18, 0.22, confidence=0.9, speaking_score=0.0)
            framing.observe([silent_listener, speaking_face], t)
            framing.position(t)

        # Após 0.5s de fala, o alvo deve ter mudado para o falante e a câmera movido em sua direção
        self.assertEqual(framing.target.center, speaker_silent.center)
        self.assertGreater(framing.center, 0.45)

    def test_brief_pause_in_speech_does_not_reset_candidate(self):
        framing = StableFraming(0.32, switch_hold=0.50)
        listener = Face(0.1, 0.2, 0.18, 0.22, confidence=0.9, speaking_score=0.0)
        speaker_silent = Face(0.65, 0.2, 0.14, 0.2, confidence=0.9, speaking_score=0.0)
        speaker_speaking = Face(0.65, 0.2, 0.14, 0.2, confidence=0.9, speaking_score=0.65)
        speaker_paused = Face(0.65, 0.2, 0.14, 0.2, confidence=0.9, speaking_score=0.15)
        silent_listener = Face(0.1, 0.2, 0.18, 0.22, confidence=0.9, speaking_score=0.0)

        # Início (calados)
        framing.observe([listener, speaker_silent], 0)

        # Falante fala aos 0.1s e 0.2s
        framing.observe([silent_listener, speaker_speaking], 0.1)
        framing.observe([silent_listener, speaker_speaking], 0.2)

        # Pausa curta aos 0.3s (100ms de pausa entre sílabas)
        framing.observe([silent_listener, speaker_paused], 0.3)

        # Retoma aos 0.4s, 0.5s, 0.65s
        framing.observe([silent_listener, speaker_speaking], 0.4)
        framing.observe([silent_listener, speaker_speaking], 0.5)
        framing.observe([silent_listener, speaker_speaking], 0.65)

        # Deve ter completado a troca para o falante
        self.assertEqual(framing.target.center, speaker_speaking.center)


def words(text, step=0.3):
    return [{'texto': w, 'inicio': i * step, 'fim': (i + 1) * step} for i, w in enumerate(text.split())]

class CaptionTests(unittest.TestCase):
    def test_all_words_preserved_and_limits_respected(self):
        source=words('Você não tem uma empresa você só tem um emprego que paga muito bem para ter uma empresa')
        groups=agrupar_palavras(source,CaptionStyle())
        self.assertEqual([w for g in groups for w in g],source)
        self.assertTrue(all(len(g)<=6 for g in groups))
        self.assertTrue(all(len(' '.join(w['texto'] for w in g))<=34 for g in groups))

    def test_pause_is_not_bridged(self):
        source=words('Uma frase curta Outra frase curta')
        for w in source[3:]: w['inicio']+=2; w['fim']+=2
        groups=agrupar_palavras(source,CaptionStyle())
        self.assertEqual(len(groups[0]),3)

    def test_short_phrase_uses_one_line(self):
        self.assertEqual(melhor_quebra(words('sete horas por noite')),4)

    def test_line_break_avoids_leaving_preposition(self):
        source=words('trabalhar dentro do possível')
        self.assertEqual(melhor_quebra(source),1)

    def test_highlight_does_not_change_layout(self):
        source=words('Você não tem uma empresa')
        layouts=[texto_ass_grupo(source,i).count(r'\N') for i in range(len(source))]
        self.assertEqual(len(set(layouts)),1)

    def test_highlight_includes_pop_animation_scale(self):
        source=words('Você não tem uma empresa')
        ass_text = texto_ass_grupo(source, 0)
        self.assertIn(r'\fscx108', ass_text)
        self.assertIn(r'\fscy108', ass_text)
        self.assertIn(r'\fscx100', ass_text)

    def test_timestamp_carry(self):
        self.assertEqual(srt_tempo(59.9999),'00:01:00,000')

    def test_gerar_capa_composicao(self):
        import tempfile
        from pathlib import Path
        from PIL import Image
        from processor.captions import gerar_capa_frame0, DEFAULT_FONT_DIR
        with tempfile.TemporaryDirectory() as td:
            base_dir = Path(td)
            dummy_frame = base_dir / "frame.jpg"
            Image.new("RGB", (1080, 1920), (80, 80, 80)).save(str(dummy_frame))
            destino_capa = base_dir / "capa.jpg"
            capa = gerar_capa_frame0(
                arquivo_video=dummy_frame,
                titulo="Como construir autoridade e escala",
                destino_capa=destino_capa,
                pasta_fontes=DEFAULT_FONT_DIR,
                tempo_frame=0.0,
            )
            self.assertTrue(capa.exists())
            with Image.open(capa) as img:
                self.assertEqual(img.size, (1080, 1920))

if __name__=='__main__': unittest.main()

