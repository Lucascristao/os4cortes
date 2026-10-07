function buildYouTubeTitle(rawTitle, postText, maxChars = 70) {
  let text = '';
  // Prioriza o título real com acentos da primeira linha do postText se disponível
  if (postText) {
    const firstLine = postText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (firstLine && firstLine.length > 3) {
      text = firstLine;
    }
  }
  if (!text) {
    text = (rawTitle || 'Corte').trim();
  }

  // Remove prefixos numéricos redundantes ("Corte 01:", "01 - ", etc.)
  let s = text.replace(/^(?:corte\s*\d+[\s:_-]*|\d+[\s:._-]*)/i, '').replace(/#shorts/gi, '').replace(/\s+/g, ' ').trim();

  // Se tem separador com convidado ou programa (" | " ou " - ")
  if (s.includes(' | ') || s.includes(' - ')) {
    const separador = s.includes(' | ') ? ' | ' : ' - ';
    const partes = s.split(separador).map(p => p.trim()).filter(Boolean);
    const gancho = partes[0];
    const complemento = partes.slice(1).join(separador);

    // Se o gancho principal já for forte e explicativo (>= 25 caracteres), usamos o gancho direto para máxima viralidade
    if (gancho.length >= 25 && gancho.length <= maxChars) {
      s = gancho;
    } else if (gancho.length + separador.length + complemento.length <= maxChars) {
      s = `${gancho}${separador}${complemento}`;
    } else {
      s = gancho;
    }
  }

  // Se ainda assim passar de maxChars, trunca elegantemente na última palavra completa (nunca corta uma palavra no meio)
  if (s.length > maxChars) {
    const sub = s.slice(0, maxChars);
    const lastSpace = sub.lastIndexOf(' ');
    if (lastSpace > 25) {
      s = sub.slice(0, lastSpace);
    } else {
      s = sub;
    }
  }

  // Limpa pontuações soltas no final
  s = s.replace(/[\s|_:-]+$/, '').trim();
  return s || 'Corte';
}

module.exports = { buildYouTubeTitle };
