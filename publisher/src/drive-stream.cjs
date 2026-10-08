const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
function confirmationUrl(html, base) {
  const form = html.match(/<form\b[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
  if (form) {
    const result = new URL(decode(form[1]), base);
    for (const input of form[2].matchAll(/<input\b[^>]*>/gi)) {
      const name = input[0].match(/\bname=["']([^"']+)["']/i);
      const value = input[0].match(/\bvalue=["']([^"']*)["']/i);
      if (name && value) result.searchParams.set(decode(name[1]), decode(value[1]));
    }
    return result.href;
  }
  const link = html.match(/href=["']([^"']*[?&](?:amp;)?confirm=[^"']+)["']/i);
  return link ? new URL(decode(link[1]), base).href : null;
}
function cookieHeader(cookies, url) {
  return cookies.filter(c => {
    const domain = c.domain.replace(/^\./, '');
    return (url.hostname === domain || c.domain.startsWith('.') && url.hostname.endsWith('.' + domain)) &&
      url.pathname.startsWith(c.path || '/') && (!c.secure || url.protocol === 'https:') &&
      (!(c.expires > 0) || c.expires > Date.now() / 1000);
  }).map(c => `${c.name}=${c.value}`).join('; ');
}
function receiveCookies(cookies, lines, url) {
  for (const line of lines || []) {
    const pieces = line.split(';');
    const pair = pieces.shift(); const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: url.hostname, path: '/' };
    for (const part of pieces) {
      const [key, ...values] = part.trim().split('='); const value = values.join('=');
      if (key.toLowerCase() === 'domain') cookie.domain = value;
      if (key.toLowerCase() === 'path') cookie.path = value;
      if (key.toLowerCase() === 'secure') cookie.secure = true;
    }
    const domain = cookie.domain.replace(/^\./, '');
    if (url.hostname !== domain && !url.hostname.endsWith('.' + domain)) continue;
    const old = cookies.findIndex(c => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
    if (old >= 0) cookies.splice(old, 1);
    cookies.push(cookie);
  }
}
function googleUrl(url) {
  return url.protocol === 'https:' && (url.hostname === 'drive.google.com' || url.hostname.endsWith('.googleusercontent.com') || url.hostname === 'drive.usercontent.google.com');
}
async function downloadDriveStream(startUrl, destination, options = {}) {
  const cookies = structuredClone(options.cookies || []);
  const partial = destination + '.part';
  const attempts = options.attempts || 3;
  const allowed = options.allowedUrl || googleUrl;
  let expected = 0, etag;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let url = new URL(startUrl);
    try {
      for (let step = 0; step < 12; step++) {
        if (!allowed(url)) throw new Error('Redirecionamento do Drive para endereço não autorizado.');
        let size = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
        const headers = { 'Accept-Encoding': 'identity' };
        const auth = cookieHeader(cookies, url); if (auth) headers.Cookie = auth;
        if (size) { headers.Range = `bytes=${size}-`; if (etag) headers['If-Range'] = etag; }
        const { response, clearDeadline } = await new Promise((resolve, reject) => {
          const transport = url.protocol === 'https:' ? https : http;
          const req = transport.get(url, { headers }, response => resolve({ response, clearDeadline: () => clearTimeout(deadline) }));
          const deadline = setTimeout(() => req.destroy(new Error('Tempo máximo de download excedido.')), options.totalTimeout || 600000);
          req.setTimeout(options.idleTimeout || 60000, () => req.destroy(new Error('Download sem receber dados.')));
          req.on('error', error => { clearTimeout(deadline); reject(error); });
        });
        try {
          receiveCookies(cookies, response.headers['set-cookie'], url);
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume(); url = new URL(response.headers.location, url); continue;
          }
          if (response.statusCode === 416 && size && response.headers['content-range'] === `bytes */${size}`) {
            response.resume(); fs.renameSync(partial, destination); return true;
          }
          if (![200, 206].includes(response.statusCode)) { response.resume(); throw new Error(`Drive retornou HTTP ${response.statusCode}.`); }
          if ((response.headers['content-type'] || '').includes('text/html')) {
            let html = '';
            for await (const chunk of response) { html += chunk.toString(); if (html.length > 2 * 1024 * 1024) throw new Error('Resposta HTML do Drive muito grande.'); }
            const confirmed = confirmationUrl(html, url);
            if (!confirmed) throw new Error('Drive requer acesso à pasta ou retornou uma página de erro.');
            url = new URL(confirmed); continue;
          }
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
          if (response.statusCode === 206 && (!range || Number(range[1]) !== size)) {
            response.destroy(); throw new Error('Drive retornou posição de retomada inválida.');
          }
          if (response.statusCode === 200) size = 0; // O servidor ignorou Range: recomeça, sem anexar bytes duplicados.
          expected = range ? Number(range[3]) : Number(response.headers['content-length'] || 0);
          etag = response.headers.etag;
          await pipeline(response, fs.createWriteStream(partial, { flags: size ? 'a' : 'w' }));
          if (expected && fs.statSync(partial).size !== expected) throw new Error('Download incompleto; será retomado.');
          fs.renameSync(partial, destination);
          return true;
        } finally { clearDeadline(); if (!response.complete) response.destroy(); }
      }
      throw new Error('Excesso de redirecionamentos ou confirmações do Drive.');
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, options.retryDelay ?? 1000));
    }
  }
}
module.exports = { downloadDriveStream, confirmationUrl, cookieHeader };
