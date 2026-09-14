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

    def test_timestamp_carry(self):
        self.assertEqual(srt_tempo(59.9999),'00:01:00,000')

if __name__=='__main__': unittest.main()

