"""Optional visual style: safe typography, unambiguous timing and real media."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from processor.covers import TITLE_FONT
from processor.editorial_paper import literal_anchor, paper_layout, paper_overlay, paper_sequence, paper_timeline, video_box
from processor.editorial_visuals import Canvas
from processor.editorial_renderer import scene_fingerprint, _caption_assets, preflight_editorial_visuals


class PaperVisualTests(unittest.TestCase):
    def setUp(self):
        self.scene = {'id':'opening','kind':'narration','text':'Uma fala sobre o assunto.',
                      'visual':{'title':'O que essa resposta esclarece?', 'kicker':'SEGUNDO A FONTE',
                                'lines':['O que ela confirma', 'O que diz não saber']}}

    def test_support_anchor_requires_complete_unique_phrase(self):
        words=[{'texto':x,'inicio':i*.4,'fim':(i+1)*.4} for i,x in enumerate('A intenção importa. A intenção muda.'.split())]
        self.assertIsNone(literal_anchor(words,'intenção'))
        self.assertIsNone(literal_anchor(words,'intenção prova'))
        self.assertEqual(literal_anchor(words,'INTENÇÃO IMPORTA'),.4)

    def test_timing_is_contiguous_bounded_and_respects_readable_holds(self):
        scene=copy.deepcopy(self.scene)
        scene['visual']['lines']=['Um apoio longo com várias palavras precisa permanecer visível por tempo suficiente.', 'Segundo apoio', 'Terceiro apoio']
        for duration in (.1,1.,2.,5.,20.):
            with self.subTest(duration=duration):
                steps=paper_timeline(scene,duration)
                self.assertEqual(steps[0]['start'],0)
                self.assertEqual(steps[-1]['end'],duration)
                for i,step in enumerate(steps):
                    self.assertGreater(step['end'],step['start'])
                    if i:
                        self.assertEqual(steps[i-1]['end'],step['start'])
                        required=max(1.4,min(4.,len(scene['visual']['lines'][step['stage']].split())/3.5))
                        self.assertGreaterEqual(step['end']-step['start']+1e-9,required)
        self.assertEqual(len(paper_timeline(scene,1.)),1)

    def test_uses_unique_aligned_words_instead_of_percent_when_readable(self):
        words=[{'texto':word,'inicio':3+i*.2,'fim':3+(i+1)*.2} for i,word in enumerate('O que ela confirma'.split())]
        steps=paper_timeline(self.scene,12,words)
        self.assertEqual(steps[1]['start'],3)
        self.assertEqual(steps[1]['timing'],'literal-support')

    def test_both_formats_keep_full_text_and_window_outside_captions(self):
        scene=copy.deepcopy(self.scene)
        scene['visual']['lines']=['O cidadão pode comparar as propostas e acompanhar o uso dos impostos sem depender de promessas feitas durante a eleição.']
        for aspect in ('9:16','16:9'):
            canvas=Canvas.for_format(aspect)
            layout=paper_layout(scene,canvas=canvas,font_path=TITLE_FONT,credit='Fonte: Uma entrevista')
            x,y,w,h=video_box(canvas)
            self.assertEqual(w%2,0)
            self.assertEqual(h%2,0)
            self.assertLess(y+h,canvas.safe_zones()['captions'][1])
            self.assertEqual(layout['supports'][0]['text'].split(),scene['visual']['lines'][0].split())
            for item in (layout['title'],*layout['supports'],layout['credit']):
                bounds,box=item['bounds'],item['box']
                self.assertLessEqual(bounds[2],box[2])
                self.assertLessEqual(bounds[3],box[3])

    def test_card_replaces_video_window_and_brand_stays_still(self):
        canvas=Canvas.for_format(width=540)
        first=paper_overlay(self.scene,canvas=canvas,font_path=TITLE_FONT,stage=-1)
        second=paper_overlay(self.scene,canvas=canvas,font_path=TITLE_FONT,stage=0)
        x,y,w,h=video_box(canvas)
        self.assertEqual(first.getpixel((x+w//2,y+h//2))[3],0)
        self.assertEqual(second.getpixel((x+w//2,y+h//2))[3],255)
        box=(0,0,canvas.width,round(canvas.height*.13))
        self.assertEqual(first.crop(box).tobytes(),second.crop(box).tobytes())

    def test_unrenderable_support_fails_preflight_without_paid_or_media_work(self):
        scene=copy.deepcopy(self.scene)
        scene['visual']['lines']=['W'*140]
        plan={'visual_style':'paper','source':{'label':'Fonte','date':''},'scenes':[scene]}
        with patch('processor.covers.normalize_cover') as cover, self.assertRaisesRegex(ValueError,'visual.lines'):
            preflight_editorial_visuals(plan,canvas=Canvas.for_format(),font_path=TITLE_FONT)
        cover.assert_not_called()

    def test_graphic_assets_are_bounded_independent_of_scene_length(self):
        canvas=Canvas.for_format(width=360)
        with tempfile.TemporaryDirectory() as folder:
            concat,steps=paper_sequence(self.scene,folder,canvas=canvas,font_path=TITLE_FONT,duration=180)
            self.assertLessEqual(len(list(Path(folder).glob('*.png'))),len(steps)*round(canvas.fps*.28))
            durations=[float(line.split()[1]) for line in concat.read_text().splitlines() if line.startswith('duration ')]
            self.assertAlmostEqual(sum(durations),180,places=6)

    def test_style_invalidates_visual_cache_for_source_and_narration(self):
        args={'source_hash':'same','canvas':[1080,1920,30],'lower_third':['off',0],'words':[]}
        for scene in (self.scene,{'id':'source','kind':'clip','start':1,'end':3}):
            self.assertNotEqual(scene_fingerprint(scene,**args),scene_fingerprint(dict(scene,_visual_style='paper'),**args))

    def test_paper_caption_palette_preserves_subtitle_text_and_optional_burn(self):
        words=[{'texto':'Uma','inicio':0,'fim':.5},{'texto':'fala.','inicio':.5,'fim':1}]
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for burn in (False,True):
                ass,cues=_caption_assets(words,root,canvas=Canvas.for_format(),font_path=TITLE_FONT,
                                          font_name='Archivo Black',duration=1,burn_captions=burn,visual_style='paper')
                self.assertEqual(cues[0]['text'],'Uma fala.')
                self.assertIn('Uma fala.',(root/'captions.srt').read_text(encoding='utf-8'))
                data=ass.read_text(encoding='utf-8')
                self.assertEqual('Dialogue:' in data,burn)
                if burn:
                    self.assertIn(r'\c&H0000679F&',data)
                    self.assertNotIn(r'\c&H00FFFFFF&',data)


if __name__=='__main__':
    unittest.main()
