import unittest
from processor.captions import CaptionStyle, agrupar_palavras, melhor_quebra, texto_ass_grupo, srt_tempo

def words(text, step=0.3):
    return [{'texto':w,'inicio':i*step,'fim':(i+1)*step} for i,w in enumerate(text.split())]

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

