function sanitizeDiagnostic(value) {
  return String(value ?? '')
    .replace(/Call log:[\s\S]*/i, 'Detalhes internos da requisição omitidos.')
    .replace(/\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*:[^\r\n]*/gi, '[cabeçalho oculto]')
    .replace(/([?&](?:token|access_token|refresh_token|confirm|uuid|key)=)[^\s&]+/gi, '$1[oculto]')
    .replace(/\bBearer\s+[\w.+\/-]+/gi, 'Bearer [oculto]');
}
module.exports = { sanitizeDiagnostic };
