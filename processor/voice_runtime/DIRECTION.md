# Direção vocal OS4 — registro grave discreto

Referência auditada somente para tom: [Plotquake, commit 7a4e5f6](https://github.com/Lucascristao/Plotquake/tree/7a4e5f6d572cabd18138f9667ddc1109dd4e9db7), especialmente [worker/synthesize_narration.py](https://github.com/Lucascristao/Plotquake/blob/7a4e5f6d572cabd18138f9667ddc1109dd4e9db7/worker/synthesize_narration.py) e [docs/AUDIO_DIRECTION.md](https://github.com/Lucascristao/Plotquake/blob/7a4e5f6d572cabd18138f9667ddc1109dd4e9db7/docs/AUDIO_DIRECTION.md).

O Plotquake usa Gemini 3.8 Live/Charon. Seu prompt orienta ressonância de peito e estabilidade de tom e distância do microfone. Além da interpretação, ele aplica −1 semitom após gerar a voz, com compensação de tempo e preservação do número de amostras. O grave que se ouve nessa referência não pode ser atribuído somente ao prompt.

O OS4 mantém português brasileiro, curiosidade e conversa direta. A direção global pede ressonância suave e registro confortável um pouco mais grave, com a mesma presença na abertura e nas retomadas. Não importa a cadência documental em inglês, suspense permanente, solenidade ou voz de trailer. Música, efeitos e formato ficam fora desta adaptação.

## RAW e master são etapas diferentes

O sintetizador entrega PCM16 mono 24 kHz bruto, sem transposição, EQ, velocidade ou regravação. O manifesto registra `raw_audio_treatment: none`, `raw_pitch_semitones: 0` e `effects_applied: false`, com escopo explícito dos WAVs brutos.

O mesmo manifesto solicita `master_pitch_semitones: -1` e `master_pitch_stage: derived-narration-master-only`. `master_pitch_applied: false` significa que a síntese ainda não executou essa etapa. O compositor deve aplicar a mesma calibração **uma vez** sobre as narrações derivadas, conservar duração, deixar os excertos originais sem pitch e registrar o que de fato aplicou. Nunca executar novamente a transposição sobre um master já tratado nem alterar os WAVs de origem.

A direção gerativa participa dos fingerprints e invalida voz antiga incompatível. A calibração separada do master não entra no cache de síntese: mudar apenas esse valor não deve comprar outra geração. A versão e o ganho/pitch do master precisam participar do cache do compositor.

## Continuidade e limites

A implementação efetiva auditada tanto no O Dinheiro Explica quanto no Plotquake abre sessões separadas por cena. O holder do runtime portado permite gestão de retry, mas seu escopo é deliberadamente uma cena. Ele não comprova uma sessão contínua entre falas.

Este perfil preserva a mesma voz Charon, modelo, direção global, timbre solicitado e distância percebida do microfone. Mantém isolamento de sessão, leitura literal e validação de fidelidade. Não promete identidade acústica perfeita entre gerações. Reaproveitar uma sessão sem consumir corretamente o fim de turno poderia misturar eventos ou contexto; o runtime não assume essa segurança sem prova real.

## Próxima amostra

Gerar as mesmas três locuções aprovadas com o perfil atual, sem mudar roteiro nem fonte. Conferir fidelidade e alinhamento, montar com um único tratamento tonal comum e comparar as três entradas, suas retomadas e uma pergunta. A leitura do WAV e do MP4 precisa verificar naturalidade e estabilidade percebida; métricas e o ID da voz não substituem essa escuta. Uma síntese única seguida de divisão por palavras alinhadas é uma alternativa futura para comparar continuidade, sem ampliar o fluxo atual por suposição.
