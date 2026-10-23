const crypto = require('node:crypto');

const BRAND_NAME = 'OS4 de Direita';
const BRAND_ACCOUNT = '@os4dedireita';
const BRAND_SIGNATURE = `Siga ${BRAND_ACCOUNT} para mais insights com análises e comentários.`;
const NETWORKS = ['tiktok', 'instagram', 'youtube'];
const TEXT_FIELDS = ['titulo', 'title', 'postText', 'caption', 'description', 'descricao'];

function canonicalAccount(account) {
  return typeof account === 'string' && /^@?os4[._]?cortes$/i.test(account.trim()) ? BRAND_ACCOUNT : account;
}

function canonicalAccounts(accounts) {
  const next = {...accounts};
  for (const network of NETWORKS) {
    const current = next[network];
    const account = current?.account ? canonicalAccount(current.account) : BRAND_ACCOUNT;
    if (current?.account !== account) next[network] = {...current, account, status: current?.status || 'Informada; confirmação visual pendente'};
  }
  return next;
}

function rebrandText(text) {
  if (typeof text !== 'string') return text;
  // Match processor/branding.py: only owned text changes, never source URLs,
  // repository URLs or paths that happen to contain the old project name.
  return text.split(/(https?:\/\/[^\s<>]+)/gi).map((part, index) => index % 2 ? part : part
    .replace(/Siga\s+@os4(?:[._]?cortes|dedireita)\s+para mais (?:insights diários sobre negócios e liderança|análises e comentários de direita)\.?/gi, BRAND_SIGNATURE)
    .replace(/(?<![\w@])@os4[._]?cortes(?!\w|\.\w)/gi, BRAND_ACCOUNT)
    .replace(/(?<![\w#])#os4[._]?cortes(?!\w|\.\w)/gi, '#os4dedireita')
    .replace(/(?<![\w\/@#\\])os4\s+cortes\b/gi, BRAND_NAME)
    .replace(/(?<![\w\/@#\\])os4[._]?cortes(?!\w|\.\w)/gi, 'os4dedireita')
  ).join('');
}

function rebrandPayload(payload, updateText = true) {
  const next = {...payload, account: canonicalAccount(payload.account)};
  if (updateText) for (const field of TEXT_FIELDS) if (typeof next[field] === 'string') next[field] = rebrandText(next[field]);
  return next;
}

const fingerprint = p => crypto.createHash('sha256').update(JSON.stringify([p.videoFileId, p.network, p.account])).digest('hex');

// Change identity labels only. IDs, states, attempts, evidence, browser profiles,
// encrypted settings and file paths must survive a channel rename unchanged.
function migrateQueueBranding(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='accounts'").get();
    const originalAccounts = row ? JSON.parse(row.value) : {};
    const accounts = canonicalAccounts(originalAccounts);
    const accountsChanged = JSON.stringify(accounts) !== JSON.stringify(originalAccounts);
    let jobsChanged = 0;
    if (accountsChanged) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('accounts', JSON.stringify(accounts));
    for (const job of db.prepare('SELECT id,fingerprint,payload,state FROM jobs').all()) {
      const payload = JSON.parse(job.payload);
      const next = rebrandPayload(payload, !['completed', 'publishing', 'verify'].includes(job.state));
      const serialized = JSON.stringify(next);
      if (serialized === job.payload) continue;
      const nextFingerprint = fingerprint(next);
      // A pre-existing alias can point at a job already recorded under the new
      // name. Keep both records and the existing unique key in that case.
      const duplicate = db.prepare('SELECT id FROM jobs WHERE fingerprint=? AND id<>?').get(nextFingerprint, job.id);
      db.prepare('UPDATE jobs SET payload=?,fingerprint=? WHERE id=?').run(serialized, duplicate ? job.fingerprint : nextFingerprint, job.id);
      jobsChanged++;
    }
    db.exec('COMMIT');
    return {accountsChanged, jobsChanged};
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {BRAND_NAME, BRAND_ACCOUNT, BRAND_SIGNATURE, canonicalAccount, canonicalAccounts, rebrandText, rebrandPayload, migrateQueueBranding};
