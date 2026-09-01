import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=fs.readFileSync('ghostlane-recovery.js','utf8');
const btoa=s=>Buffer.from(s,'binary').toString('base64');
const atob=s=>Buffer.from(s,'base64').toString('binary');
const sandbox={module:{exports:{}},exports:{},globalThis:{},crypto:webcrypto,TextEncoder,TextDecoder,Date,JSON,Math,Number,String,Array,Set,Error,btoa,atob};sandbox.globalThis=sandbox;vm.createContext(sandbox);vm.runInContext(source,sandbox,{filename:'ghostlane-recovery.js'});const R=sandbox.module.exports;
function assert(ok,msg){if(!ok)throw new Error(msg)}
async function rejects(fn,needle,label){let ok=false;try{await fn()}catch(e){ok=String(e.message||e).includes(needle)}assert(ok,label)}
function throws(fn,needle,label){let ok=false;try{fn()}catch(e){ok=String(e.message||e).includes(needle)}assert(ok,label)}

assert(R.APP==='GhostLane','app');assert(R.SCHEMA==='ghostlane-encrypted-backup-v1','schema');assert(R.PAYLOAD_SCHEMA==='ghostlane-ledger-v1','payload schema');assert(R.LEDGER_KEY==='ghostlane_ledger','ledger key');assert(R.MAX_LEDGER===50,'ledger cap');assert(R.KDF_ITERATIONS===210000,'PBKDF2 iterations');
const a={id:'log-1',time:'10:15 AM',hardware:'Flock Safety Camera',lat:'35.4676',lon:'-97.5164'};
const b={id:'log-2',time:'10:16 AM',hardware:'Speed Camera',lat:'35.4700',lon:'-97.5200'};
const pass='correct-horse-battery-staple';
const envelope=await R.encryptLedger([a,b],pass);const serialized=JSON.stringify(envelope);
assert(envelope.kdf.name==='PBKDF2'&&envelope.cipher.name==='AES-GCM','crypto envelope');
assert(!serialized.includes('35.4676')&&!serialized.includes('Flock Safety Camera'),'private ledger is not plaintext in envelope');
const decrypted=await R.decryptBackupText(serialized,pass);assert(decrypted.length===2&&decrypted[0].id==='log-1','encrypted roundtrip');
await rejects(()=>R.decryptBackupText(serialized,'wrong-passphrase-value'),'Wrong passphrase','wrong passphrase rejected');
await rejects(()=>R.encryptLedger([a],'short'),'at least 10','short passphrase rejected');
throws(()=>R.normalizeLedger(Array.from({length:501},()=>a)),'too many','input cap');
const polluted=JSON.parse('{"id":"x","time":"t","hardware":"h","lat":35,"lon":-97,"__proto__":{"polluted":true},"constructor":{"x":1}}');const clean=R.normalizeLedgerItem(polluted);assert(!Object.prototype.hasOwnProperty.call(clean,'__proto__')&&!Object.prototype.hasOwnProperty.call(clean,'constructor'),'prototype keys stripped');
const merged=R.mergeLedger([a],[a,b]);assert(merged.length===2&&merged[0].id==='log-1'&&merged[1].id==='log-2','current-first dedupe');assert(R.mergeLedger([],Array.from({length:100},(_,i)=>({...a,id:`log-${i}`}))).length===50,'50 ledger cap');
class FakeStorage{constructor(raw=null,fail=false){this.raw=raw;this.fail=fail;this.calls=0}getItem(k){return k===R.LEDGER_KEY?this.raw:null}setItem(k,v){this.calls++;if(this.fail&&this.calls===1)throw new Error('simulated write failure');if(k===R.LEDGER_KEY)this.raw=v}removeItem(k){if(k===R.LEDGER_KEY)this.raw=null}}
let storage=new FakeStorage(JSON.stringify([a]));let restored=R.restore(storage,[b]);assert(restored.length===2&&JSON.parse(storage.raw).length===2,'restore write');const before=JSON.stringify([a]);storage=new FakeStorage(before,true);throws(()=>R.restore(storage,[b]),'simulated write failure','write failure surfaced');assert(storage.raw===before,'rollback preserves ledger');

const app=fs.readFileSync('app.js','utf8'),index=fs.readFileSync('index.html','utf8'),ui=fs.readFileSync('ghostlane-recovery-ui.js','utf8'),radar=fs.readFileSync('radar.html','utf8'),vercel=fs.readFileSync('vercel.json','utf8');
assert(app.includes("localStorage.getItem('ghostlane_ledger')")&&app.includes("state.ledger.length > 50"),'production ledger contract');assert(app.includes("ghostlane_nodes"),'node cache exists in app');assert(!source.includes('ghostlane_nodes'),'node cache excluded from backup engine');assert(index.includes('<script src="ghostlane-recovery.js"></script>')&&index.includes('<script src="ghostlane-recovery-ui.js"></script>'),'recovery scripts mounted');assert(ui.includes('AES-GCM')&&ui.includes('passphrase is never stored or sent anywhere'),'privacy disclosure');assert(ui.includes('ghostlane-pre-import-private-ledger-backup.json'),'pre-import encrypted backup');assert(ui.indexOf("download(pre,'ghostlane-pre-import-private-ledger-backup.json')")<ui.indexOf('R.restore(localStorage,incoming)'),'pre-import backup before restore');assert(!ui.includes('localStorage.clear('),'no destructive clear');assert(!ui.includes("localStorage.setItem('pass")&&!ui.includes('sessionStorage.setItem'),'passphrase not persisted');assert(radar.includes('src="/index.html?v=1.7.4"'),'native wrapper surface reaches index');assert(/"deploymentEnabled"\s*:\s*false/.test(vercel),'Git deployment disabled');
console.log('GhostLane encrypted signing-cutover ledger recovery QA passed.');
