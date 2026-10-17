// Roles and permissions (docs/roles.md): the permissions the platform checks, the three built-in roles, and what a custom role may look like.
//
// A role is a named set of permissions; a user holds one or more roles and may do whatever any of them allows. The built-in roles (platform_admin, operator, auditor) are part
// of the platform: they cannot be changed or deleted, so an administrator can never remove their own way back in. Everything a role request has to satisfy is judged here, by the
// functions both stores (the local one and PostgreSQL) and the API call, so they cannot disagree about what is valid.

// A permission that is no use without another one: a role with it must have the other too, so no role can be created that the console shows half-working.
export const IMPLIES = Object.freeze({
  'resource.operate': ['resource.view'], 'resource.tag': ['resource.view'], 'connection.manage': ['connection.view'], 'identity.manage': ['resource.view']
});

const CATALOGUE = [
  { key: 'resource.view', group: 'Virtual machines', description: 'See virtual machines, infrastructure, tags, performance and tasks.' },
  { key: 'resource.operate', group: 'Virtual machines', description: 'Power, snapshot, edit and open consoles of virtual machines, mount media, and manage tasks.' },
  { key: 'resource.tag', group: 'Virtual machines', description: 'Add, change and remove Nuvrion tags on virtual machines.' },
  { key: 'connection.view', group: 'Connections', description: 'See provider connections, their health and alerts.' },
  { key: 'connection.manage', group: 'Connections', description: 'Add, edit, test, discover and delete provider connections; acknowledge alerts.' },
  { key: 'audit.view', group: 'Platform', description: 'Read the audit history.' },
  { key: 'identity.manage', group: 'Platform', description: 'Manage users and roles: approve accounts, assign roles, revoke sessions.' },
  { key: 'platform.manage', group: 'Platform', description: 'Upgrade the platform, manage agents and their builds, and read platform metrics.' }
];
export const PERMISSIONS = Object.freeze(CATALOGUE.map(permission => Object.freeze({ ...permission, requires: Object.freeze([...(IMPLIES[permission.key] ?? [])]) })));
export const PERMISSION_KEYS = Object.freeze(PERMISSIONS.map(permission => permission.key));

export const SYSTEM_ROLES = Object.freeze({
  platform_admin: Object.freeze({ description: 'Everything, including users, roles and the platform itself.', permissions: Object.freeze([...PERMISSION_KEYS]) }),
  operator: Object.freeze({ description: 'Operate virtual machines and see connections; no administration.', permissions: Object.freeze(['resource.view', 'resource.operate', 'resource.tag', 'connection.view']) }),
  auditor: Object.freeze({ description: 'Read-only, including the audit history.', permissions: Object.freeze(['resource.view', 'connection.view', 'audit.view']) })
});
export const SYSTEM_ROLE_NAMES = Object.freeze(Object.keys(SYSTEM_ROLES));

export const ROLE_LIMITS = Object.freeze({ nameMin: 2, nameMax: 40, descriptionMax: 200, customRoles: 50 });
const NAME = /^[a-z][a-z0-9_-]*$/;

export class RoleError extends Error {
  constructor(message, code = 'NUV_ROLE_INVALID') { super(message); this.code = code; }
}

export const roleDisplayName = name => name.replaceAll('_', ' ').replaceAll('-', ' ');

export function normaliseRoleName(raw) {
  const name = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (name.length < ROLE_LIMITS.nameMin || name.length > ROLE_LIMITS.nameMax) throw new RoleError(`A role name needs ${ROLE_LIMITS.nameMin} to ${ROLE_LIMITS.nameMax} characters.`);
  if (!NAME.test(name)) throw new RoleError('A role name may use letters, digits, - and _ (a space becomes _), and must start with a letter.');
  if (SYSTEM_ROLE_NAMES.includes(name)) throw new RoleError(`"${name}" is a built-in role and cannot be used for a custom one.`, 'NUV_ROLE_RESERVED');
  return name;
}

export function normaliseDescription(raw) {
  const text = String(raw ?? '').trim();
  if (text.length > ROLE_LIMITS.descriptionMax) throw new RoleError(`A description may have at most ${ROLE_LIMITS.descriptionMax} characters.`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) throw new RoleError('A description may not contain control or invisible formatting characters.');
  return text;
}

// The permissions of a role request, validated: only known keys, no repeats counted twice, at least one, and everything each one needs.
export function normalisePermissions(raw) {
  if (!Array.isArray(raw)) throw new RoleError('permissions must be a list.');
  if (raw.some(key => typeof key !== 'string')) throw new RoleError('Each permission must be a key such as resource.view.');
  const unknown = raw.find(key => !PERMISSION_KEYS.includes(key));
  if (unknown !== undefined) throw new RoleError(`Unknown permission: ${unknown.slice(0, 60)}.`);
  const keys = PERMISSION_KEYS.filter(key => raw.includes(key));
  if (!keys.length) throw new RoleError('A role needs at least one permission.');
  for (const key of keys) {
    const missing = (IMPLIES[key] ?? []).filter(needed => !keys.includes(needed));
    if (missing.length) throw new RoleError(`${key} needs ${missing.join(' and ')} as well.`, 'NUV_ROLE_PERMISSION_DEPENDENCY');
  }
  return keys;
}

// body: { name, description?, permissions } for a new role, or { description?, permissions } for a change (name: false).
export function parseRoleRequest(body, { name: withName = true } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RoleError('The request must be a JSON object.');
  const allowed = withName ? ['name', 'description', 'permissions'] : ['description', 'permissions'], unknown = Object.keys(body).find(key => !allowed.includes(key));
  if (unknown) throw new RoleError(`Unknown field: ${unknown.slice(0, 40)}.`);
  return { ...(withName ? { name: normaliseRoleName(body.name) } : {}), description: normaliseDescription(body.description), permissions: normalisePermissions(body.permissions) };
}

// The permissions in `wanted` that `held` does not include: nobody may give a role, or give a user a role, with more than they have themselves.
export const permissionsBeyond = (held, wanted) => wanted.filter(key => !held.includes(key));
