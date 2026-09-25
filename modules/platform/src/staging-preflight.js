import {validateRuntimeConfiguration,RuntimeConfigurationError} from './runtime-configuration.js';

const placeholders=/(change[-_ ]?me|replace[-_ ]?with|example|placeholder|<[^>]+>)/i;
const digest=/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/i;
const requiredImages=['NUVRION_IMAGE','NUVRION_POSTGRES_IMAGE','NUVRION_RABBITMQ_IMAGE'];
const secretNames=['NUVRION_DATABASE_URL','NUVRION_BROKER_URL','NUVRION_BOOTSTRAP_PASSWORD','NUVRION_MASTER_KEY','NUVRION_ENCRYPTION_KEYS','NUVRION_BACKUP_INTEGRITY_KEY','NUVRION_AGENT_SIGNING_PRIVATE_KEY'];

export class StagingPreflightError extends Error{constructor(issues){super('Staging preflight failed.');this.code='NUV_STAGING_PREFLIGHT_FAILED';this.issues=issues;}}
export function validateStagingPreflight(env){const issues=[];try{validateRuntimeConfiguration({...env,NUVRION_RUNTIME_PROFILE:'production'});}catch(error){if(error instanceof RuntimeConfigurationError)issues.push(...error.issues);else issues.push(error.message);}
  for(const name of requiredImages)if(!digest.test(String(env[name]??'')))issues.push(`${name} must use an immutable sha256 image digest`);
  for(const name of secretNames)if(!env[name]||placeholders.test(String(env[name])))issues.push(`${name} must be supplied by the staging secret manager and cannot contain placeholder text`);
  if(env.NUVRION_ENVIRONMENT!=='staging')issues.push('NUVRION_ENVIRONMENT must be staging');
  if(env.NUVRION_TRUST_PROXY!=='true')issues.push('NUVRION_TRUST_PROXY must be true behind the staging TLS proxy');
  if(String(env.NUVRION_BOOTSTRAP_PASSWORD??'')===String(env.POSTGRES_PASSWORD??''))issues.push('bootstrap and PostgreSQL passwords must be distinct');
  if(String(env.NUVRION_MASTER_KEY??'')===String(env.NUVRION_BACKUP_INTEGRITY_KEY??''))issues.push('agent-secret and backup-integrity keys must be distinct');
  if(issues.length)throw new StagingPreflightError([...new Set(issues)]);return {valid:true,environment:'staging',images:'immutable',secrets:'configured',runtime:'production'};
}
export {requiredImages,secretNames};
