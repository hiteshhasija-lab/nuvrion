import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {hashPassword,passwordMatches,needsPasswordRehash} from './password-hasher.js';

const DEFAULT_PERMISSIONS = {
  platform_admin: ['resource.view','resource.operate','connection.view','connection.manage','identity.manage','audit.view','platform.manage'],
  operator: ['resource.view','resource.operate','connection.view'],
  auditor: ['resource.view','connection.view','audit.view']
};

export class IdentityService {
  #users = new Map(); #sessions = new Map();
  constructor({ bootstrapPassword = process.env.NUVRION_BOOTSTRAP_PASSWORD ?? 'ChangeMe-Nuvrion-01!' } = {}) {
    this.createUser({ username:'admin', displayName:'Platform Administrator', password:bootstrapPassword, roles:['platform_admin'] });
  }
  createUser({ username, displayName, password, roles=['operator'] }) {
    const normalized = username.trim().toLowerCase();
    if (this.findUser(normalized)) throw new Error('USERNAME_EXISTS');
    if (password.length < 12) throw new Error('PASSWORD_TOO_SHORT');
    const user={ id:randomUUID(), username:username.trim(), normalizedUsername:normalized, displayName:displayName.trim(), status:'active', roles:[...new Set(roles)], passwordHash:hashPassword(password), createdAt:new Date().toISOString() };
    this.#users.set(user.id,user); return this.publicUser(user);
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
  publicUser(user){const permissions=[...new Set(user.roles.flatMap(r=>DEFAULT_PERMISSIONS[r]??[]))];return {id:user.id,username:user.username,displayName:user.displayName,status:user.status,roles:[...user.roles],permissions};}
  authorize(principal,permission){return Boolean(principal?.user.permissions.includes(permission));}
}

export function parseCookies(header=''){return Object.fromEntries(header.split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),decodeURIComponent(v.slice(i+1))]}));}
