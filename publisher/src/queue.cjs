const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const day = (ms) => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Fortaleza',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
class Queue {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, evidence TEXT);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, job TEXT, network TEXT NOT NULL, day TEXT NOT NULL, started INTEGER NOT NULL, next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, job TEXT, state TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT, synced INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.prepare("UPDATE jobs SET state='verify', evidence='Publicação interrompida. Verificar antes de reenviar.' WHERE state='publishing'").run();
    this.db.prepare("UPDATE jobs SET state='queued' WHERE state='preparing'").run();
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try {const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;} }
  add(p,now=Date.now()) {
    if(!p.id || !['youtube','instagram','tiktok'].includes(p.network) || !p.account || !p.videoFileId) throw new Error('Pedido inválido');
    const fp=crypto.createHash('sha256').update(JSON.stringify([p.videoFileId,p.network,p.account])).digest('hex');
    return this.db.prepare('INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,NULL)').run(p.id,fp,JSON.stringify(p),'queued',now).changes === 1;
  }
  list() { return this.db.prepare('SELECT * FROM jobs ORDER BY created').all().map(r=>({...r,payload:JSON.parse(r.payload)})); }
  status(id,state,detail='',now=Date.now()) { this.transaction(()=>{this.db.prepare('UPDATE jobs SET state=?,evidence=? WHERE id=?').run(state,detail,id);this.db.prepare('INSERT INTO events(id,job,state,at,detail) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),id,state,now,detail);}); }
  eligibility(network,now=Date.now()) {
    const count=this.db.prepare('SELECT count(*) n FROM attempts WHERE network=? AND day=?').get(network,day(now)).n;
    const next=Math.max(this.db.prepare('SELECT max(next) n FROM attempts WHERE network=?').get(network).n || 0, this.get('network_next', {})[network] || 0);
    return {eligible:count<50 && now>=next,count,next};
  }
  begin(id,now=Date.now(),delay=crypto.randomInt(180,301)*1000) {
    if(delay<30000 || delay>600000) throw new Error('Intervalo inválido');
    return this.transaction(()=>{
      const job=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if(!job || !['queued','preparing'].includes(job.state)) throw new Error('Pedido já iniciado ou indisponível');
      const p=JSON.parse(job.payload);
      if(!this.eligibility(p.network,now).eligible) throw new Error('Aguardar limite ou intervalo');
      const active=this.db.prepare("SELECT payload FROM jobs WHERE state='publishing'").all();
      if(active.length>=2 || active.some(j=>JSON.parse(j.payload).network===p.network)) throw new Error('Rede ou limite de envios simultâneos ocupado');
      this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),id,p.network,day(now),now,now+delay);
      this.db.prepare("UPDATE jobs SET state='publishing' WHERE id=?").run(id);
      this.db.prepare('INSERT INTO events(id,job,state,at,detail) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),id,'publishing',now,'Início de tentativa e intervalo persistidos');
    });
  }
  completedTodayJobIds(now = Date.now()) {
    try {
      const todayStr = day(now);
      const rows = this.db.prepare("SELECT at, job FROM events WHERE state='completed'").all();
      const unique = new Set();
      for (const r of rows) {
        if (day(r.at) === todayStr) {
          unique.add(r.job);
        }
      }
      return unique;
    } catch {
      return new Set();
    }
  }
  completedTodayCount(now = Date.now()) {
    return this.completedTodayJobIds(now).size;
  }
  retry(id, now = Date.now()) {
    return this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if (!job) throw new Error('Corte não encontrado na fila');
      if (!['failed','cancelled'].includes(job.state)) throw new Error('Verifique a publicação antes de reenviar este corte.');
      this.db.prepare("UPDATE jobs SET state='queued', evidence='Reenfileirado manualmente' WHERE id=?").run(id);
      this.db.prepare('INSERT INTO events(id,job,state,at,detail) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), id, 'queued', now, 'Reenfileirado pelo usuário');
      return true;
    });
  }
  retryAllFailed(now = Date.now()) {
    return this.transaction(() => {
      const failed = this.db.prepare("SELECT id FROM jobs WHERE state='failed'").all();
      for (const j of failed) {
        this.db.prepare("UPDATE jobs SET state='queued', evidence='Reenfileirado em lote' WHERE id=?").run(j.id);
        this.db.prepare('INSERT INTO events(id,job,state,at,detail) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), j.id, 'queued', now, 'Reenfileiramento de falhas em lote');
      }
      return failed.length;
    });
  }
  delete(id) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
      this.db.prepare('DELETE FROM attempts WHERE job=?').run(id);
      this.db.prepare('DELETE FROM events WHERE job=?').run(id);
      return true;
    });
  }
  set(key,value) {this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value));}
  get(key,fallback=null) {const r=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):fallback;}
  stage(id, state, detail, now=Date.now()) {
    this.db.prepare('INSERT INTO events(id,job,state,at,detail) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),id,state,now, typeof detail==='string'?detail:JSON.stringify(detail));
  }
  history(limit=200) {
    return this.db.prepare('SELECT e.at,e.state,e.detail,j.payload FROM events e LEFT JOIN jobs j ON j.id=e.job ORDER BY e.at DESC LIMIT ?').all(limit).map(e=>{
      const p=e.payload?JSON.parse(e.payload):{};
      return {at:e.at,state:e.state,detail:e.detail,network:p.network,cutIndex:p.cutIndex};
    });
  }
  confirmation(id) {
    const row=this.db.prepare("SELECT detail FROM events WHERE job=? AND state='publication_confirmed' ORDER BY at DESC LIMIT 1").get(id);
    try{return row?JSON.parse(row.detail):null;}catch{return null;}
  }
  markVerified(id) {
    const job=this.list().find(j=>j.id===id);
    if(!job || job.state!=='verify') throw new Error('Publicação não está aguardando verificação.');
    this.status(id,'completed','Publicação conferida na rede pelo usuário.');
  }
  close(){this.db.close();}
}
module.exports={Queue,day};
