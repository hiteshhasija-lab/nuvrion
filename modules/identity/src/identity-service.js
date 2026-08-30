import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import {hashPassword,passwordMatches,needsPasswordRehash} from './password-hasher.js';

const DEFAULT_PERMISSIONS = {
  platform_admin: ['resource.view','resource.operate','connection.view','connection.manage','identity.manage','audit.view','platform.manage'],
  operator: ['resource.view','resource.operate','connection.view'],
  auditor: ['resource.view','connection.view','audit.view']
};

export class IdentityService {
  #users = new Map(); #sessions = new Map(); #minimumPasswordLength;
  constructor({ bootstrapPassword = process.env.NUVRION_BOOTSTRAP_PASSWORD ?? 'ChangeMe-Nuvrion-01!', allowWeakPasswords=false } = {}) {
    this.#minimumPasswordLength=allowWeakPasswords?1:12;
    this.createUser({ username:'admin', displayName:'Platform Administrator', password:bootstrapPassword, roles:['platform_admin'] });
  }
  createUser({ username, displayName, password, roles=['operator'], status='active' }) {
    const normalized = username.trim().toLowerCase();
    if (this.findUser(normalized)) throw new Error('USERNAME_EXISTS');
    if (typeof password!=='string'||password.length < this.#minimumPasswordLength) throw new Error('PASSWORD_TOO_SHORT');
    const recoveryCode=randomBytes(18).toString('base64url');
    if(!['active','pending','locked','disabled'].includes(status)||roles.some(role=>!DEFAULT_PERMISSIONS[role]))throw new Error('USER_INVALID');
    const user={ id:randomUUID(), username:username.trim(), normalizedUsername:normalized, displayName:displayName.trim(), status, roles:[...new Set(roles)], rowVersion:1, passwordHash:hashPassword(password), recoveryCodeHash:createHash('sha256').update(recoveryCode).digest(), createdAt:new Date().toISOString() };
    this.#users.set(user.id,user); return {user:this.publicUser(user),recoveryCode};
  }
  findUser(username) { return [...this.#users.values()].find(u=>u.normalizedUsername===username.trim().toLowerCase()); }
  authenticate(username,password) {
    const user=this.findUser(username); if(!user || user.status!=='active' || !passwordMatches(password,user.passwordHash)) return null;if(needsPasswordRehash(user.passwordHash))user.passwordHash=hashPassword(password);
    const token=randomBytes(32).toString('base64url'); const csrf=randomBytes(24).toString('base64url');
    const session={ idHash:createHash('sha256').update(token).digest('hex'), userId:user.id, csrf, createdAt:Date.now(), idleExpiresAt:Date.now()+30*60_000, absoluteExpiresAt:Date.now()+8*60*60_000 };
    this.#sessions.set(session.idHash,session); return { token, csrf, user:this.publicUser(user), expiresAt:new Date(session.idleExpiresAt).toISOString() };
  }
  session(token) {
    if(!token) return null; const hash=createHash('sha256').update(token).digest('hex'); const session=this.#sessions.get(hash); if(!session) return null;
    const now=Date.now(); if(now>session.idleExpiresAt||now>session.absoluteExpiresAt){this.#sessions.delete(hash);return null;}
    session.idleExpiresAt=Math.min(now+30*60_000,session.absoluteExpiresAt); const user=this.#users.get(session.userId); return user?{session,user:this.publicUser(user)}:null;
  }
  logout(token){if(!token)return;this.#sessions.delete(createHash('sha256').update(token).digest('hex'));}
  listUsers(){return [...this.#users.values()].map(user=>this.publicUser(user)).sort((a,b)=>a.username.localeCompare(b.username));}
  updateUser(userId,{status,roles},expectedVersion){const user=this.#users.get(userId);if(!user)return null;if(user.rowVersion!==expectedVersion)throw new Error('VERSION_CONFLICT');if(!['active','locked','disabled'].includes(status)||!Array.isArray(roles)||!roles.length||roles.some(role=>!DEFAULT_PERMISSIONS[role]))throw new Error('USER_INVALID');const removesActiveAdmin=user.status==='active'&&user.roles.includes('platform_admin')&&(status!=='active'||!roles.includes('platform_admin'));if(removesActiveAdmin&&[...this.#users.values()].filter(item=>item.id!==userId&&item.status==='active'&&item.roles.includes('platform_admin')).length===0)throw new Error('LAST_ADMIN');user.status=status;user.roles=[...new Set(roles)];user.rowVersion+=1;if(status!=='active')this.revokeSessions(userId);return this.publicUser(user);}
  revokeSessions(userId){let count=0;for(const [key,session] of this.#sessions)if(session.userId===userId){this.#sessions.delete(key);count+=1}return {revoked:count};}
  rotateRecoveryCode(userId){const user=this.#users.get(userId);if(!user)throw new Error('USER_NOT_FOUND');const recoveryCode=randomBytes(18).toString('base64url');user.recoveryCodeHash=createHash('sha256').update(recoveryCode).digest();return {recoveryCode};}
  resetPassword(username,recoveryCode,newPassword){const user=this.findUser(username);if(!user||typeof recoveryCode!=='string'||!user.recoveryCodeHash)return null;const supplied=createHash('sha256').update(recoveryCode).digest();if(!timingSafeEqual(supplied,user.recoveryCodeHash))return null;if(typeof newPassword!=='string'||newPassword.length<this.#minimumPasswordLength)throw new Error('PASSWORD_TOO_SHORT');user.passwordHash=hashPassword(newPassword);for(const [key,session] of this.#sessions)if(session.userId===user.id)this.#sessions.delete(key);return this.rotateRecoveryCode(user.id);}
  publicUser(user){const permissions=[...new Set(user.roles.flatMap(r=>DEFAULT_PERMISSIONS[r]??[]))];return {id:user.id,username:user.username,displayName:user.displayName,status:user.status,roles:[...user.roles],permissions,rowVersion:user.rowVersion};}
  authorize(principal,permission){return Boolean(principal?.user.permissions.includes(permission));}
}

export function parseCookies(header=''){return Object.fromEntries(header.split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),decodeURIComponent(v.slice(i+1))]}));}
