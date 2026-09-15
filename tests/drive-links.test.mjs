import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function urlDownloadDrive('),source.indexOf('function resultLink('));
function context(email){const c={URL,$:()=>({textContent:email})};vm.createContext(c);vm.runInContext(functions,c);return c;}
test('download usa a conta do OS4 sem índice fixo nem confirmação forçada',()=>{const c=context('setedodois@gmail.com');const u=new URL(c.urlDownloadDrive('file_123'));assert.equal(u.hostname,'drive.google.com');assert.equal(u.searchParams.get('authuser'),'setedodois@gmail.com');assert.equal(u.searchParams.get('id'),'file_123');assert.equal(u.searchParams.get('export'),'download');assert.equal(u.searchParams.has('confirm'),false);});
test('visualização e pasta preservam parâmetros e selecionam a mesma conta',()=>{const c=context('other+account@gmail.com');const u=new URL(c.driveAccountUrl('https://drive.google.com/file/d/abc/view?resourcekey=key'));assert.equal(u.searchParams.get('resourcekey'),'key');assert.equal(u.searchParams.get('authuser'),'other+account@gmail.com');});
test('não envia email para outros domínios',()=>{const c=context('private@gmail.com');assert.equal(c.driveAccountUrl('https://example.com/file'),'https://example.com/file');});
