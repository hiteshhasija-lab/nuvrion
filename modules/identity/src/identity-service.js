import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import {hashPassword,passwordMatches,needsPasswordRehash} from './password-hasher.js';
import {cleanUserIdentity,passwordAcceptable} from './user-input.js';
import {SYSTEM_ROLES,ROLE_LIMITS,RoleError,roleDisplayName,parseRoleRequest} from './roles.js';
import {generateSecret,otpauthUri,verifyTotp,generateBackupCodes,hashBackupCode} from './totp.js';
import {MFA_ERRORS,MFA_LIMITS,requiresMfa,stateFor,lockedFor,afterFailure,afterSuccess,evaluate,checkInput,validatePolicyRoles} from './mfa.js';
import {keyringFromEnvironment} from '../../platform/src/keyring-cipher.js';

export class IdentityService {
  #users = new Map(); #sessions = new Map(); #cipher; #clock; #mfaPolicy = []; #roles = new Map(Object.entries(SYSTEM_ROLES).map(([name,role])=>[name,{id:randomUUID(),name,displayName:roleDisplayName(name),description:role.description,system:true,permissions:[...role.permissions],rowVersion:1}])); #idleTimeoutMs; #absoluteTimeoutMs;
  constructor({ bootstrapPassword = process.env.NUVRION_BOOTSTRAP_PASSWORD ?? 'ChangeMe-Nuvrion-01!', idleTimeoutMs=30*60_000, absoluteTimeoutMs=8*60*60_000, cipher = null, clock = Date.now } = {}) {
    this.#idleTimeoutMs=idleTimeoutMs;this.#absoluteTimeoutMs=absoluteTimeoutMs;this.#cipher=cipher??keyringFromEnvironment(process.env,{production:false});this.#clock=clock;
    this.createUser({ username:'admin', displayName:'Platform Administrator', password:bootstrapPassword, roles:['platform_admin'] });
  }
  createUser({ username, displayName, password, roles=['operator'], status='active' }) {
    const identity = cleanUserIdentity({ username, displayName });
    if(!['active','pending','locked','disabled'].includes(status)||!Array.isArray(roles)||roles.some(role=>!this.#roles.has(role)))throw new Error('USER_INVALID');
    if (!passwordAcceptable(password)) throw new Error('PASSWORD_TOO_SHORT');
    if (this.findUser(identity.normalized)) throw new Error('USERNAME_EXISTS');
    const recoveryCode=randomBytes(18).toString('base64url');
    const user={ id:randomUUID(), username:identity.username, normalizedUsername:identity.normalized, displayName:identity.displayName, status, roles:[...new Set(roles)], rowVersion:1, passwordHash:hashPassword(password), recoveryCodeHash:createHash('sha256').update(recoveryCode).digest(), createdAt:new Date().toISOString() };
    this.#users.set(user.id,user); return {user:this.publicUser(user),recoveryCode};
  }
  findUser(username) { return [...this.#users.values()].find(u=>u.normalizedUsername===username.trim().toLowerCase()); }
  authenticate(username,password) {
    const user=this.findUser(username); if(!user || user.status!=='active' || !passwordMatches(password,user.passwordHash)) return null;if(needsPasswordRehash(user.passwordHash))user.passwordHash=hashPassword(password);
    const token=randomBytes(32).toString('base64url'); const csrf=randomBytes(24).toString('base64url');
    const session={ idHash:createHash('sha256').update(token).digest('hex'), userId:user.id, csrf, createdAt:Date.now(), lastSeenAt:Date.now(), idleExpiresAt:Date.now()+this.#idleTimeoutMs, absoluteExpiresAt:Date.now()+this.#absoluteTimeoutMs, mfaVerifiedAt:null, mfaFailures:0 };
    this.#sessions.set(session.idHash,session); return { token, csrf, user:this.publicUser(user), mfa:{state:this.#mfaState(user,session)}, expiresAt:new Date(session.idleExpiresAt).toISOString(),policy:{idleTimeoutMs:this.#idleTimeoutMs,absoluteTimeoutMs:this.#absoluteTimeoutMs} };
  }
  session(token) {
    if(!token) return null; const hash=createHash('sha256').update(token).digest('hex'); const session=this.#sessions.get(hash); if(!session) return null;
    const now=Date.now(); if(now>session.idleExpiresAt||now>session.absoluteExpiresAt){this.#sessions.delete(hash);return null;}
    session.lastSeenAt=now;session.idleExpiresAt=Math.min(now+this.#idleTimeoutMs,session.absoluteExpiresAt); const user=this.#users.get(session.userId); return user?{session,user:this.publicUser(user),mfa:{state:this.#mfaState(user,session)}}:null;
  }
  logout(token){if(!token)return;this.#sessions.delete(createHash('sha256').update(token).digest('hex'));}
  listUsers(){return [...this.#users.values()].map(user=>this.publicUser(user)).sort((a,b)=>a.username.localeCompare(b.username));}
  updateUser(userId,{status,roles},expectedVersion){const user=this.#users.get(userId);if(!user)return null;if(user.rowVersion!==expectedVersion)throw new Error('VERSION_CONFLICT');if(!['active','locked','disabled'].includes(status)||!Array.isArray(roles)||!roles.length||roles.some(role=>!this.#roles.has(role)))throw new Error('USER_INVALID');const removesActiveAdmin=user.status==='active'&&user.roles.includes('platform_admin')&&(status!=='active'||!roles.includes('platform_admin'));if(removesActiveAdmin&&[...this.#users.values()].filter(item=>item.id!==userId&&item.status==='active'&&item.roles.includes('platform_admin')).length===0)throw new Error('LAST_ADMIN');user.status=status;user.roles=[...new Set(roles)];user.rowVersion+=1;if(status!=='active')this.revokeSessions(userId);return this.publicUser(user);}
  revokeSessions(userId){let count=0;for(const [key,session] of this.#sessions)if(session.userId===userId){this.#sessions.delete(key);count+=1}return {revoked:count};}
  listSessions(userId,currentToken){const currentHash=currentToken?createHash('sha256').update(currentToken).digest('hex'):null,now=Date.now();return [...this.#sessions.values()].filter(session=>session.userId===userId&&session.idleExpiresAt>now&&session.absoluteExpiresAt>now).map(session=>({id:session.idHash,createdAt:new Date(session.createdAt).toISOString(),lastSeenAt:new Date(session.lastSeenAt??session.createdAt).toISOString(),idleExpiresAt:new Date(session.idleExpiresAt).toISOString(),absoluteExpiresAt:new Date(session.absoluteExpiresAt).toISOString(),current:session.idHash===currentHash})).sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt));}
  revokeSession(userId,sessionId){const session=this.#sessions.get(sessionId);if(!session||session.userId!==userId)return {revoked:0};this.#sessions.delete(sessionId);return {revoked:1};}
  rotateRecoveryCode(userId){const user=this.#users.get(userId);if(!user)throw new Error('USER_NOT_FOUND');const recoveryCode=randomBytes(18).toString('base64url');user.recoveryCodeHash=createHash('sha256').update(recoveryCode).digest();return {recoveryCode};}
  resetPassword(username,recoveryCode,newPassword){const user=this.findUser(username),normalizedRecoveryCode=typeof recoveryCode==='string'?recoveryCode.trim():'';if(!user||!normalizedRecoveryCode||!user.recoveryCodeHash)return null;const supplied=createHash('sha256').update(normalizedRecoveryCode).digest();if(!timingSafeEqual(supplied,user.recoveryCodeHash))return null;if(!passwordAcceptable(newPassword))throw new Error('PASSWORD_TOO_SHORT');user.passwordHash=hashPassword(newPassword);for(const [key,session] of this.#sessions)if(session.userId===user.id)this.#sessions.delete(key);return this.rotateRecoveryCode(user.id);}
  publicUser(user){const permissions=[...new Set(user.roles.flatMap(r=>this.#roles.get(r)?.permissions??[]))];return {id:user.id,username:user.username,displayName:user.displayName,status:user.status,roles:[...user.roles],permissions,mfaEnrolled:Boolean(user.mfa?.enabled),rowVersion:user.rowVersion};}

  #publicRole(role){return {id:role.id,name:role.name,displayName:role.displayName,description:role.description,system:role.system,permissions:[...role.permissions],userCount:[...this.#users.values()].filter(user=>user.roles.includes(role.name)).length,rowVersion:role.rowVersion};}
  listRoles(){return [...this.#roles.values()].map(role=>this.#publicRole(role)).sort((a,b)=>Number(b.system)-Number(a.system)||a.name.localeCompare(b.name));}
  createRole(request){const {name,description,permissions}=parseRoleRequest(request);if(this.#roles.has(name))throw new RoleError(`A role named "${name}" already exists.`,'NUV_ROLE_EXISTS');if([...this.#roles.values()].filter(role=>!role.system).length>=ROLE_LIMITS.customRoles)throw new RoleError(`At most ${ROLE_LIMITS.customRoles} custom roles may exist.`,'NUV_ROLE_LIMIT');const role={id:randomUUID(),name,displayName:roleDisplayName(name),description,system:false,permissions,rowVersion:1};this.#roles.set(name,role);return this.#publicRole(role);}
  updateRole(name,request,expectedVersion){const role=this.#roles.get(name);if(!role)return null;if(role.system)throw new RoleError('Built-in roles cannot be changed.','NUV_ROLE_SYSTEM');if(role.rowVersion!==expectedVersion)throw new Error('VERSION_CONFLICT');const {description,permissions}=parseRoleRequest(request,{name:false});role.description=description;role.permissions=permissions;role.rowVersion+=1;return this.#publicRole(role);}
  deleteRole(name){const role=this.#roles.get(name);if(!role)return null;if(role.system)throw new RoleError('Built-in roles cannot be deleted.','NUV_ROLE_SYSTEM');const holders=[...this.#users.values()].filter(user=>user.roles.includes(name)).length;if(holders)throw new RoleError(`${holders} user${holders===1?' holds':'s hold'} this role. Give them another role first.`,'NUV_ROLE_IN_USE');this.#roles.delete(name);return {deleted:1};}

  // ---- two-factor sign-in (rules in mfa.js and totp.js; docs/mfa.md) ----
  #mfaState(user,session){return stateFor({enrolled:Boolean(user.mfa?.enabled),verified:Boolean(session.mfaVerifiedAt),required:requiresMfa(user.roles,this.#mfaPolicy)});}
  #secretOf(user,field='secret'){const cipherText=user.mfa?.[field];return cipherText?this.#cipher.decrypt(cipherText,{context:`nuvrion:totp:${user.id}`}):null;}
  #session(userId,sessionId){const session=this.#sessions.get(sessionId);return session&&session.userId===userId?session:null;}
  mfaStatus(userId){const user=this.#users.get(userId);if(!user)throw new Error('USER_NOT_FOUND');return {enrolled:Boolean(user.mfa?.enabled),enrolledAt:user.mfa?.enrolledAt??null,backupCodesRemaining:user.mfa?.enabled?user.mfa.backupHashes.length:0,requiredByPolicy:requiresMfa(user.roles,this.#mfaPolicy)};}
  #guard(user,now=this.#clock()){const wait=lockedFor(user.mfa??{},now);if(wait)throw MFA_ERRORS.throttled(wait);}
  #fail(user,session){const now=this.#clock();Object.assign(user.mfa,afterFailure(user.mfa,now));if(session){session.mfaFailures+=1;if(session.mfaFailures>=MFA_LIMITS.sessionFailures){this.#sessions.delete(session.idHash);throw MFA_ERRORS.sessionRevoked();}}throw MFA_ERRORS.invalid();}
  mfaStartEnrollment(userId,{account}={}){const user=this.#users.get(userId);if(!user)throw new Error('USER_NOT_FOUND');if(user.mfa?.enabled)throw MFA_ERRORS.alreadyEnrolled();const secret=generateSecret();user.mfa={...(user.mfa??{}),enabled:false,pending:this.#cipher.encrypt(secret,{context:`nuvrion:totp:${userId}`}),failedCount:user.mfa?.failedCount??0,failedSince:user.mfa?.failedSince??null,lockedUntil:user.mfa?.lockedUntil??null,backupHashes:[],lastStep:0};return {secret,uri:otpauthUri({secret,account:account??user.username})};}
  mfaConfirmEnrollment(userId,sessionId,code){const user=this.#users.get(userId);if(!user)throw new Error('USER_NOT_FOUND');if(user.mfa?.enabled)throw MFA_ERRORS.alreadyEnrolled();if(!user.mfa?.pending)throw MFA_ERRORS.notStarted();checkInput({code});this.#guard(user);const now=this.#clock(),secret=this.#secretOf(user,'pending'),result=verifyTotp(secret,code,{timeMs:now});if(!result.ok)this.#fail(user,null);const backupCodes=generateBackupCodes();user.mfa={enabled:true,secret:user.mfa.pending,pending:null,lastStep:result.step,backupHashes:backupCodes.map(item=>hashBackupCode(item.replace('-',''))),enrolledAt:new Date(now).toISOString(),...afterSuccess()};const session=this.#session(userId,sessionId);if(session)session.mfaVerifiedAt=now;for(const [key,other] of this.#sessions)if(other.userId===userId&&other!==session)other.mfaVerifiedAt=null;return {backupCodes};}
  mfaVerify(userId,sessionId,input){const user=this.#users.get(userId),session=this.#session(userId,sessionId);if(!user||!session)throw new Error('USER_NOT_FOUND');if(!user.mfa?.enabled)throw MFA_ERRORS.notEnrolled();checkInput(input);this.#guard(user);const now=this.#clock(),result=evaluate({secret:this.#secretOf(user),lastStep:user.mfa.lastStep,backupHashes:user.mfa.backupHashes},input,now);if(!result.ok)this.#fail(user,session);if(result.method==='totp')user.mfa.lastStep=result.step;else user.mfa.backupHashes=user.mfa.backupHashes.filter(hash=>hash!==result.consumed);Object.assign(user.mfa,afterSuccess());session.mfaVerifiedAt=now;session.mfaFailures=0;return {method:result.method,backupCodesRemaining:user.mfa.backupHashes.length};}
  #proveFactor(userId,code){const user=this.#users.get(userId);if(!user)throw new Error('USER_NOT_FOUND');if(!user.mfa?.enabled)throw MFA_ERRORS.notEnrolled();checkInput({code});this.#guard(user);const result=evaluate({secret:this.#secretOf(user),lastStep:user.mfa.lastStep,backupHashes:[]},{code},this.#clock());if(!result.ok)this.#fail(user,null);user.mfa.lastStep=result.step;Object.assign(user.mfa,afterSuccess());return user;}
  mfaRegenerateBackupCodes(userId,code){const user=this.#proveFactor(userId,code),backupCodes=generateBackupCodes();user.mfa.backupHashes=backupCodes.map(item=>hashBackupCode(item.replace('-','')));return {backupCodes};}
  mfaDisable(userId,code){const user=this.#proveFactor(userId,code);if(requiresMfa(user.roles,this.#mfaPolicy))throw MFA_ERRORS.requiredByPolicy();user.mfa=null;return {disabled:true};}
  mfaReset(userId){const user=this.#users.get(userId);if(!user)return null;const had=Boolean(user.mfa);user.mfa=null;this.revokeSessions(userId);return {reset:had};}
  getMfaPolicy(){return {requiredRoles:[...this.#mfaPolicy]};}
  setMfaPolicy(roles){this.#mfaPolicy=validatePolicyRoles(roles,[...this.#roles.keys()].sort());return this.getMfaPolicy();}
  authorize(principal,permission){return Boolean(principal?.user.permissions.includes(permission));}
}

export function parseCookies(header=''){return Object.fromEntries(header.split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),decodeURIComponent(v.slice(i+1))]}));}
