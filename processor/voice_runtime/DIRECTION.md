# Direção vocal OS4 — comentarista contextual e registro grave discreto

Referência auditada somente para tom: [Plotquake, commit 7a4e5f6](https://github.com/Lucascristao/Plotquake/tree/7a4e5f6d572cabd18138f9667ddc1109dd4e9db7), especialmente [worker/synthesize_narration.py](https://github.com/Lucascristao/Plotquake/blob/7a4e5f6d572cabd18138f9667ddc1109dd4e9db7/worker/synthesize_narration.py) e [docs/AUDIO_DIRECTION.md](https://github.com/Lucascristao/Plotquake/blob/7a4e5f6d572cabd18138f9667ddc1109dd4e9db7/docs/AUDIO_DIRECTION.md).

O Plotquake usa Gemini 3.8 Live/Charon. Seu prompt orienta ressonância de peito e estabilidade de tom e distância do microfone. Além da interpretação, ele aplica −1 semitom após gerar a voz, com compensação de tempo e preservação do número de amostras. O grave que se ouve nessa referência não pode ser atribuído somente ao prompt.

O OS4 mantém português brasileiro, curiosidade e conversa direta. A direção global pede ressonância suave e registro confortável um pouco mais grave, com a mesma presença na abertura e nas retomadas. Não importa a cadência documental em inglês, suspense permanente, solenidade ou voz de trailer. Música, efeitos e formato ficam fora desta adaptação.

## Personalidade e interpretação contextual

A direção editorial do OS4 é de direita, com um comentarista bem com a vida, próximo e provocativo. Isso define personalidade e leitura do roteiro. O sintetizador não escreve o comentário nem acrescenta posicionamentos, acusações ou ressalvas: lê o texto literal aprovado no pacote. Humor e ironia são intenção de interpretação, sem risadas artificiais, escárnio permanente ou piadas inventadas. Assuntos graves e sofrimento pedem sobriedade e respeito.

O pacote pode declarar `editorial.profile` com `perspective: right`, `topic: politics|economy|business|humor|general`, `tone: conversational|provocative|ironic|playful|explanatory|serious`, `intensity: low|medium|high`, `angle` e `audience_question`. O perfil presente exige os seis campos; `angle` é texto não vazio até 240 caracteres e `audience_question` pode ser vazia até 240. Campos desconhecidos e enums inválidos são rejeitados antes de qualquer síntese. Pacotes antigos sem perfil permanecem sem esse metadado e recebem somente os defaults efetivos right/general/conversational/medium.

Cada cena de narração pode sobrescrever `tts.tone` e `tts.intensity`. O motor resolve a herança por cena, valida os enums e os traduz em instruções fixas. Política recebe presença incisiva sem indignação automática; economia recebe clareza e curiosidade prática; empreendedorismo recebe energia encorajadora sem voz de coach; humor recebe cumplicidade e respeito ao tempo da surpresa. O tom sério suspende sorriso e ironia. A voz continua Charon, com o mesmo timbre, registro de base, proximidade e volume confortável. Ritmo, energia, pausas e entonação acompanham a cena; não se exige mais cadência ou energia idêntica em todo assunto.

`angle` e `audience_question` são metadados do roteiro: ficam no manifesto e no fingerprint, nunca são inseridos como instrução livre nem lidos pelo modelo. Somente os enums validados, traduzidos em diretivas fixas, chegam à interpretação. O texto após `ROTEIRO` é preservado. O perfil efetivo, direções e versão da política participam dos fingerprints para impedir o reaproveitamento da interpretação séria antiga. Um worker ODE externo que não reconheça o contrato contextual é rejeitado antes de sintetizar, em vez de ignorar o perfil.

Esta é uma adaptação local em `tts_config.py`, `voice-policy.json` e no adaptador OS4. Os hashes de proveniência em `ORIGIN.json` continuam identificando os arquivos originais importados. Não foram alterados loop Live, retries, alinhamento, fidelidade lexical, escrita dos WAVs brutos ou tratamento tonal do master.

## RAW e master são etapas diferentes

O sintetizador entrega PCM16 mono 24 kHz bruto, sem transposição, EQ, velocidade ou regravação. O manifesto registra `raw_audio_treatment: none`, `raw_pitch_semitones: 0` e `effects_applied: false`, com escopo explícito dos WAVs brutos.

O mesmo manifesto solicita `master_pitch_semitones: -1` e `master_pitch_stage: derived-narration-master-only`. `master_pitch_applied: false` significa que a síntese ainda não executou essa etapa. O compositor deve aplicar a mesma calibração **uma vez** sobre as narrações derivadas, conservar duração, deixar os excertos originais sem pitch e registrar o que de fato aplicou. Nunca executar novamente a transposição sobre um master já tratado nem alterar os WAVs de origem.

A direção gerativa participa dos fingerprints e invalida voz antiga incompatível. A calibração separada do master não entra no cache de síntese: mudar apenas esse valor não deve comprar outra geração. A versão e o ganho/pitch do master precisam participar do cache do compositor.

## Continuidade e limites

A implementação efetiva auditada tanto no O Dinheiro Explica quanto no Plotquake abre sessões separadas por cena. O holder do runtime portado permite gestão de retry, mas seu escopo é deliberadamente uma cena. Ele não comprova uma sessão contínua entre falas.

Este perfil preserva a mesma voz Charon, modelo, direção global, timbre solicitado e distância percebida do microfone. Mantém isolamento de sessão, leitura literal e validação de fidelidade. Não promete identidade acústica perfeita entre gerações. Reaproveitar uma sessão sem consumir corretamente o fim de turno poderia misturar eventos ou contexto; o runtime não assume essa segurança sem prova real.

## Amostra anterior validada em 18/10/2026

As mesmas três locuções foram geradas com a direção anterior de registro grave e a chave do OS4, sem mudar roteiro nem fonte. Esse teste precede a direção contextual de comentarista, cuja validação nesta revisão é offline. O [job real](https://github.com/Lucascristao/os4cortes/actions/runs/39148541911) recuperou uma vez apenas o fechamento rejeitado por possível repetição e conservou os outros WAVs byte a byte. As três cenas passaram com cobertura ASR integral. Os MP4s vertical e horizontal têm 67,6 segundos e aplicam a calibração tonal comum uma única vez; passaram na decodificação integral e na conferência dos WAVs brutos.

Naturalidade e estabilidade percebida ainda dependem da escuta: métricas e o ID da voz não comprovam identidade acústica perfeita. Uma síntese única seguida de divisão por palavras alinhadas é uma alternativa futura para comparar continuidade, sem ampliar o fluxo atual por suposição.
