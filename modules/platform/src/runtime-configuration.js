import {createPrivateKey,createPublicKey} from 'node:crypto';
export class RuntimeConfigurationError extends Error{constructor(issues){super(`Invalid production configuration: ${issues.join('; ')}`);this.code='NUV_CONFIGURATION_INVALID';this.issues=issues;}}
const url=(value,protocols)=>{try{return protocols.includes(new URL(value).protocol);}catch{return false;}};
const integer=(value,min,max)=>Number.isSafeInteger(Number(value))&&Number(value)>=min&&Number(value)<=max;
export function validateRuntimeConfiguration(env){if(env.NUVRION_RUNTIME_PROFILE!=='production')return {profile:'local',valid:true};const issues=[];
  if(!url(env.NUVRION_DATABASE_URL,['postgres:','postgresql:']))issues.push('NUVRION_DATABASE_URL must be a PostgreSQL URL');
  if(!url(env.NUVRION_BROKER_URL,['amqp:','amqps:']))issues.push('NUVRION_BROKER_URL must be an AMQP URL');
  let encryptionKeys={};try{encryptionKeys=JSON.parse(env.NUVRION_ENCRYPTION_KEYS??'{}');}catch{issues.push('NUVRION_ENCRYPTION_KEYS must be valid JSON');}
  const activeKeyId=String(env.NUVRION_ACTIVE_ENCRYPTION_KEY_ID??'');
  if(!activeKeyId||String(encryptionKeys[activeKeyId]??'').length<32)issues.push('the active encryption key must exist in NUVRION_ENCRYPTION_KEYS and contain at least 32 characters');
  if(String(env.NUVRION_MASTER_KEY??'').length<32)issues.push('NUVRION_MASTER_KEY must contain at least 32 characters for agent-secret encryption');
  if(String(env.NUVRION_BACKUP_INTEGRITY_KEY??'').length<32)issues.push('NUVRION_BACKUP_INTEGRITY_KEY must contain at least 32 characters');
  if(String(env.NUVRION_BOOTSTRAP_PASSWORD??'').length<12)issues.push('NUVRION_BOOTSTRAP_PASSWORD must contain at least 12 characters');
  if(!integer(env.NUVRION_DB_POOL_SIZE??10,1,100))issues.push('NUVRION_DB_POOL_SIZE must be between 1 and 100');
  if(!integer(env.NUVRION_AGENT_MAINTENANCE_MS??30000,5000,3600000))issues.push('NUVRION_AGENT_MAINTENANCE_MS must be between 5000 and 3600000');
  if(!integer(env.NUVRION_AGENT_OFFLINE_MS??120000,15000,86400000))issues.push('NUVRION_AGENT_OFFLINE_MS must be between 15000 and 86400000');
  try{const privateKey=createPrivateKey(env.NUVRION_AGENT_SIGNING_PRIVATE_KEY??''),derived=createPublicKey(privateKey).export({type:'spki',format:'pem'}).toString().trim(),supplied=createPublicKey(env.NUVRION_AGENT_SIGNING_PUBLIC_KEY??'').export({type:'spki',format:'pem'}).toString().trim();if(derived!==supplied)issues.push('agent signing public key does not match the private key');}catch{issues.push('valid Ed25519 agent signing private and public keys are required');}
  if(issues.length)throw new RuntimeConfigurationError(issues);return {profile:'production',valid:true,database:'configured',broker:'configured',encryption:'configured',agentSigning:'configured'};
}
