(function(root,factory){
  const api=factory();
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  if(root)root.GhostLaneRecovery=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const APP="GhostLane";
  const SCHEMA="ghostlane-encrypted-backup-v1";
  const PAYLOAD_SCHEMA="ghostlane-ledger-v1";
  const VERSION=1;
  const LEDGER_KEY="ghostlane_ledger";
  const MAX_FILE_BYTES=5*1024*1024;
  const MAX_INPUT_LEDGER=500;
  const MAX_LEDGER=50;
  const KDF_ITERATIONS=210000;

  const enc=new TextEncoder();
  const dec=new TextDecoder();
  function subtle(){const c=globalThis.crypto;if(!c||!c.subtle)throw new Error("Secure browser cryptography is unavailable.");return c.subtle}
  function randomBytes(length){const out=new Uint8Array(length);globalThis.crypto.getRandomValues(out);return out}
  function b64(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s)}
  function unb64(value){try{const s=atob(value),out=new Uint8Array(s.length);for(let i=0;i<s.length;i++)out[i]=s.charCodeAt(i);return out}catch{throw new Error("Encrypted backup encoding is invalid.")}}
  function text(value,max){return typeof value==="string"?value.slice(0,max):""}
  function coord(value,min,max){const n=Number(value);if(!Number.isFinite(n)||n<min||n>max)return"";return n.toFixed(4)}
  function normalizeLedgerItem(value){
    if(!value||typeof value!=="object"||Array.isArray(value))return null;
    const id=text(value.id,120),time=text(value.time,80),hardware=text(value.hardware,200),lat=coord(value.lat,-90,90),lon=coord(value.lon,-180,180);
    if(!id&&!time&&!hardware&&!lat&&!lon)return null;
    return{id,time,hardware,lat,lon};
  }
  function normalizeLedger(values){
    if(!Array.isArray(values))throw new Error("Ledger must be an array.");
    if(values.length>MAX_INPUT_LEDGER)throw new Error("Backup contains too many ledger records.");
    return values.map(normalizeLedgerItem).filter(Boolean);
  }
  function ledgerKey(item){return item.id||JSON.stringify([item.time,item.hardware,item.lat,item.lon])}
  function mergeLedger(currentValues,backupValues){
    const current=normalizeLedger(Array.isArray(currentValues)?currentValues:[]),backup=normalizeLedger(Array.isArray(backupValues)?backupValues:[]),seen=new Set(),merged=[];
    for(const item of current){const k=ledgerKey(item);if(!seen.has(k)){seen.add(k);merged.push(item)}}
    for(const item of backup){if(merged.length>=MAX_LEDGER)break;const k=ledgerKey(item);if(!seen.has(k)){seen.add(k);merged.push(item)}}
    return merged.slice(0,MAX_LEDGER);
  }
  async function derive(passphrase,salt,usages){
    if(typeof passphrase!=="string"||passphrase.length<10)throw new Error("Use a recovery passphrase of at least 10 characters.");
    const base=await subtle().importKey("raw",enc.encode(passphrase),"PBKDF2",false,["deriveKey"]);
    return subtle().deriveKey({name:"PBKDF2",hash:"SHA-256",salt,iterations:KDF_ITERATIONS},base,{name:"AES-GCM",length:256},false,usages);
  }
  async function encryptLedger(ledger,passphrase){
    const clean=normalizeLedger(Array.isArray(ledger)?ledger:[]).slice(0,MAX_LEDGER),salt=randomBytes(16),iv=randomBytes(12),key=await derive(passphrase,salt,["encrypt"]);
    const payload={app:APP,schema:PAYLOAD_SCHEMA,version:VERSION,created:new Date().toISOString(),ledger:clean};
    const cipher=new Uint8Array(await subtle().encrypt({name:"AES-GCM",iv},key,enc.encode(JSON.stringify(payload))));
    return{app:APP,schema:SCHEMA,version:VERSION,created:new Date().toISOString(),kdf:{name:"PBKDF2",hash:"SHA-256",iterations:KDF_ITERATIONS,salt:b64(salt)},cipher:{name:"AES-GCM",iv:b64(iv)},ciphertext:b64(cipher)};
  }
  function validateEnvelope(value){
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Backup must be a JSON object.");
    if(value.app!==APP)throw new Error("This backup belongs to a different app.");
    if(value.schema!==SCHEMA||Number(value.version)!==VERSION)throw new Error("Unsupported GhostLane backup format.");
    if(value.kdf?.name!=="PBKDF2"||value.kdf?.hash!=="SHA-256"||Number(value.kdf?.iterations)!==KDF_ITERATIONS)throw new Error("Unsupported GhostLane backup key derivation.");
    if(value.cipher?.name!=="AES-GCM")throw new Error("Unsupported GhostLane backup cipher.");
    return value;
  }
  async function decryptBackupText(raw,passphrase){
    if(typeof raw!=="string")throw new Error("Backup must be text.");
    if(enc.encode(raw).length>MAX_FILE_BYTES)throw new Error("Backup file is larger than 5 MB.");
    let envelope;try{envelope=validateEnvelope(JSON.parse(raw))}catch(e){if(e instanceof SyntaxError)throw new Error("Backup is not valid JSON.");throw e}
    const salt=unb64(envelope.kdf.salt),iv=unb64(envelope.cipher.iv),cipher=unb64(envelope.ciphertext);
    if(salt.length!==16||iv.length!==12||cipher.length<17)throw new Error("Encrypted backup is malformed.");
    const key=await derive(passphrase,salt,["decrypt"]);
    let plain;try{plain=await subtle().decrypt({name:"AES-GCM",iv},key,cipher)}catch{throw new Error("Wrong passphrase or corrupted GhostLane backup.")}
    let payload;try{payload=JSON.parse(dec.decode(plain))}catch{throw new Error("Decrypted GhostLane backup is invalid.")}
    if(payload?.app!==APP||payload?.schema!==PAYLOAD_SCHEMA||Number(payload?.version)!==VERSION)throw new Error("Decrypted GhostLane backup has an unsupported payload.");
    return normalizeLedger(payload.ledger||[]);
  }
  function readLedger(storage){const raw=storage.getItem(LEDGER_KEY);if(raw===null)return{raw:null,value:[]};try{return{raw,value:JSON.parse(raw)}}catch{return{raw,value:[]}}}
  function restore(storage,backupLedger){
    if(!storage||typeof storage.getItem!=="function"||typeof storage.setItem!=="function")throw new Error("Storage is unavailable.");
    const previous=readLedger(storage),merged=mergeLedger(previous.value,backupLedger);
    try{storage.setItem(LEDGER_KEY,JSON.stringify(merged))}catch(error){try{if(previous.raw===null&&typeof storage.removeItem==="function")storage.removeItem(LEDGER_KEY);else storage.setItem(LEDGER_KEY,previous.raw)}catch{}throw error}
    return merged;
  }
  return{APP,SCHEMA,PAYLOAD_SCHEMA,VERSION,LEDGER_KEY,MAX_FILE_BYTES,MAX_INPUT_LEDGER,MAX_LEDGER,KDF_ITERATIONS,normalizeLedgerItem,normalizeLedger,mergeLedger,encryptLedger,decryptBackupText,restore};
});
