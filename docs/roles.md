# Roles and permissions

A **permission** is one thing the platform checks before it lets someone do something. A **role** is a named set of permissions. A user holds one or more roles and may do whatever any
of them allows. Besides the three built-in roles, an administrator can create **custom roles** for people who need something in between: someone who may tag machines but not
power them off, an operator who may not see connections, a reviewer who sees the audit history and nothing else.

## Permissions

| Permission | Allows |
|---|---|
| `resource.view` | See virtual machines, infrastructure, tags, performance and tasks |
| `resource.operate` | Power, snapshot, edit and open consoles of virtual machines, mount media, manage tasks (needs `resource.view`) |
| `resource.tag` | Add, change and remove Nuvrion tags on virtual machines (needs `resource.view`) |
| `connection.view` | See provider connections, their health and alerts |
| `connection.manage` | Add, edit, test, discover and delete connections; acknowledge alerts (needs `connection.view`) |
| `audit.view` | Read the audit history |
| `identity.manage` | Manage users and roles: approve accounts, assign roles, revoke sessions (needs `resource.view`) |
| `platform.manage` | Upgrade the platform, manage agents and their builds, read platform metrics |

`resource.tag` is new in 0.1.190: changing tags used to need `resource.operate`. Operators and administrators have it, so nothing changes for them; a custom role can now hold one without
the other.

## Built-in roles

| Role | Permissions |
|---|---|
| `platform_admin` | all of them |
| `operator` | `resource.view`, `resource.operate`, `resource.tag`, `connection.view` |
| `auditor` | `resource.view`, `connection.view`, `audit.view` |

Built-in roles are part of the platform: they **cannot be changed or deleted**, whoever asks. That is deliberate. However roles are edited, `platform_admin` always exists with every
permission, and the platform still refuses to remove or lock the last active Platform Administrator, so no sequence of changes can lock everyone out.

## Custom roles

- **Name**: 2 to 40 characters, lower case, letters, digits, `-` and `_`, starting with a letter (a space becomes `_`, so "Night Shift" is `night_shift`). The built-in names are reserved.
  The name cannot be changed afterwards; create a new role and move people over.
- **Description**: optional, up to 200 characters.
- **Permissions**: at least one, each from the table above, and every permission a chosen one needs (the console ticks those for you).
- At most **50** custom roles.
- A change to a role applies to everyone who holds it **on their next request**; nobody has to sign in again.
- A role that someone holds **cannot be deleted**: give those users another role first. Deleting a role nobody holds cannot be undone.
- **Nobody can hand out more than they have.** You may only give a role, or give a user a role, whose permissions you hold yourself. An administrator holds every permission, so
  this changes nothing for them; it stops someone who was given `identity.manage` alone from making themselves an administrator.
- Every creation, change and deletion is in the audit history (`identity.role_created`, `identity.role_updated`, `identity.role_deleted`), as is each user's role change.

## In the console

**Users** shows the roles under the users: each role with its description, its first permissions, how many users hold it, and **View** (built-in) or **Edit** and **Delete** (custom).
**+ New role** opens the dialog: a name, a description and the permissions grouped by what they cover, each with what it allows. Ticking a permission ticks what it needs; unticking one
unticks what needs it. A refused name or permission is explained in the dialog, which stays open. A built-in role opens read-only.

Each user's role selector lists every role. A user who holds several roles (possible through the API) shows "role + role (unchanged)" so that saving the row does not drop any.

The console follows what a role allows: the Connections page is not offered without `connection.view`, power actions stay disabled without `resource.operate`, the Tag button is hidden
without `resource.tag`, and pages that need data a person may not read do not ask for it.

## In the API

```
GET    /api/v1/permissions               the catalogue: { key, group, description, requires[] }
GET    /api/v1/roles                     every role: { name, displayName, description, system, permissions[], userCount, rowVersion }
POST   /api/v1/roles                     { "name": "night_shift", "description": "…", "permissions": ["resource.view", "resource.tag"] }
PATCH  /api/v1/roles/{name}              { "description": "…", "permissions": [...] }   needs If-Match: "<rowVersion>"
DELETE /api/v1/roles/{name}
PATCH  /api/v1/users/{id}                { "status": "active", "roles": ["night_shift"] }   (any existing role)
```

All need `identity.manage` and, for changes, a CSRF token. Errors are `NUV_ROLE_INVALID` (422: name, description or permissions not valid), `NUV_ROLE_RESERVED` and
`NUV_ROLE_PERMISSION_DEPENDENCY` (422), `NUV_ROLE_EXISTS`, `NUV_ROLE_IN_USE`, `NUV_ROLE_SYSTEM` and `NUV_ROLE_LIMIT` (409), `NUV_ROLE_ESCALATION` (403: you are asking for permissions you
do not have), `NUV_VERSION_CONFLICT` (412: the role changed since you read it) and `NUV_ROLE_NOT_FOUND` (404).

## How it is kept

Roles live in `identity.roles`, their permissions in `identity.role_permissions`, and a user's roles in `identity.user_roles` (migration 0034 adds a description and a version to a role and
the `resource.tag` permission to the built-in roles that had tagging). The permissions a signed-in person has are read from the database on every request, which is why a change applies at once.
Role changes are serialised (a role cannot be deleted while a user is being given it), the 50-role limit holds under simultaneous requests, and a user change with an unknown role is
rolled back whole.
