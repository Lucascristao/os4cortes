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
    this.db.prepare("UPDATE jobs SET state='verify' WHERE state='publishing'").run();
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
    const next=this.db.prepare('SELECT max(next) n FROM attempts WHERE network=?').get(network).n || 0;
    return {eligible:count<50 && now>=next,count,next};
  }
  begin(id,now=Date.now(),delay=crypto.randomInt(300,601)*1000) {
    if(delay<300000 || delay>600000) throw new Error('Intervalo inválido');
    return this.transaction(()=>{
      const job=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      if(!job || !['queued','preparing'].includes(job.state)) throw new Error('Pedido já iniciado ou indisponível');
      const p=JSON.parse(job.payload);
      if(!this.eligibility(p.network,now).eligible) throw new Error('Aguardar limite ou intervalo');
      if(this.db.prepare("SELECT id FROM jobs WHERE state='publishing'").get()) throw new Error('Outra publicação está ativa');
      this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),id,p.network,day(now),now,now+delay);
      this.db.prepare("UPDATE jobs SET state='publishing' WHERE id=?").run(id);
      this.db.prepare('INSERT INTO events(id,job,state,at,detail) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),id,'publishing',now,'Intenção persistida antes do clique final');
    });
  }
  set(key,value) {this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value));}
  get(key,fallback=null) {const r=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):fallback;}
  close(){this.db.close();}
}
module.exports={Queue,day};
