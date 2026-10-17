// Roles on the Users page (docs/roles.md): the table of roles and the dialog that shows, creates and changes one. Pure functions, kept apart from app.js so they can be tested
// in node; app.js passes in `esc` and puts the HTML in the page. The server (modules/identity/src/roles.js) is the judge of what a valid role is; what is checked here only saves
// a round trip and keeps the checkboxes consistent (ticking a permission ticks what it needs; unticking one unticks what needs it).

export const MAX_PERMISSIONS_SHOWN = 3;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The checked permissions after the person ticks or unticks `key`, so that no role is ever left with a permission whose requirements are missing.
export function permissionsAfterToggle(selected, key, on, catalogue) {
  const next = new Set(selected);
  if (on) {
    const add = name => { if (next.has(name)) return; next.add(name); for (const needed of catalogue.find(item => item.key === name)?.requires ?? []) add(needed); };
    add(key);
  } else {
    const remove = name => { if (!next.delete(name)) return; for (const item of catalogue) if (item.requires.includes(name)) remove(item.key); };
    remove(key);
  }
  return catalogue.map(item => item.key).filter(name => next.has(name));
}

export const roleLabel = role => role.displayName ?? role.name.replaceAll('_', ' ');

export function roleTableHtml(roles, { esc }) {
  if (!roles.length) return '<tr><td colspan="4"><div class="empty compact"><strong>No roles</strong></div></td></tr>';
  return roles.map(role => {
    const shown = role.permissions.slice(0, MAX_PERMISSIONS_SHOWN), more = role.permissions.length - shown.length;
    const chips = `<span class="role-perms" title="${esc(role.permissions.join(', '))}">${shown.map(key => `<span class="role-chip">${esc(key)}</span>`).join('')}${more > 0 ? `<span class="role-chip is-more">+${more}</span>` : ''}</span>`;
    const actions = role.system
      ? `<button type="button" data-role-open="${esc(role.name)}">View<span class="sr-only"> role ${esc(roleLabel(role))}</span></button>`
      : `<button type="button" data-role-open="${esc(role.name)}">Edit<span class="sr-only"> role ${esc(roleLabel(role))}</span></button><button type="button" data-role-delete="${esc(role.name)}"${role.userCount ? ` disabled title="${esc(`Held by ${plural(role.userCount, 'user')}: give them another role first.`)}"` : ''}>Delete<span class="sr-only"> role ${esc(roleLabel(role))}</span></button>`;
    return `<tr data-role-row="${esc(role.name)}"><td><strong>${esc(roleLabel(role))}</strong>${role.system ? ' <span class="badge">Built-in</span>' : ''}<small class="block">${esc(role.description || 'No description')}</small></td><td>${chips}</td><td>${role.userCount}</td><td class="row-actions right">${actions}</td></tr>`;
  }).join('');
}

// role: null for a new role. A built-in role is shown but not editable.
export function roleDialogHtml(role, catalogue, { esc, error = '' }) {
  const creating = !role, readOnly = Boolean(role?.system), held = new Set(role?.permissions ?? ['resource.view']);
  const groups = [...new Set(catalogue.map(item => item.group))];
  const title = creating ? 'New role' : roleLabel(role);
  const fields = `<section class="tag-fields">${creating ? '<label>Name<input id="role-name" maxlength="40" autocomplete="off" required placeholder="night shift"></label>' : ''}<label>Description<input id="role-description" maxlength="200" autocomplete="off" value="${esc(role?.description ?? '')}"${readOnly ? ' readonly' : ''} placeholder="What this role is for (optional)"></label></section>`;
  const permissions = groups.map(group => `<fieldset class="role-group"><legend>${esc(group)}</legend>${catalogue.filter(item => item.group === group).map(item => `<label class="role-permission"><input type="checkbox" name="permission" value="${esc(item.key)}"${held.has(item.key) ? ' checked' : ''}${readOnly ? ' disabled' : ''}><span><strong>${esc(item.key)}</strong><small>${esc(item.description)}${item.requires.length ? ` Needs ${esc(item.requires.join(', '))}.` : ''}</small></span></label>`).join('')}</fieldset>`).join('');
  const help = creating ? '<p class="tag-help">A name may use letters, digits, - and _ (a space becomes _). You can only give a role permissions you have yourself.</p>' : readOnly ? '<p class="tag-help">Built-in roles are part of the platform and cannot be changed or deleted.</p>' : `<p class="tag-help">A change applies to everyone who holds this role on their next request. ${plural(role.userCount, 'user')} hold${role.userCount === 1 ? 's' : ''} it.</p>`;
  return `<header><div><p class="eyebrow">ROLE</p><h2 id="role-title">${esc(title)}</h2></div><button id="role-close" type="button">Close</button></header>${help}${fields}${permissions}<p id="role-error" class="tag-error" role="alert"${error ? '' : ' hidden'}>${esc(error)}</p>${readOnly ? '' : `<button id="role-save" type="submit" class="primary">${creating ? 'Create role' : 'Save changes'}</button>`}`;
}

export const roleRequestBody = ({ name, description, permissions }, creating) => ({ ...(creating ? { name } : {}), description, permissions });

// The options of a user's role selector: every role, and, for someone who holds several, an entry that keeps them as they are (the selector holds one role).
export function userRoleOptionsHtml(roles, userRoles, { esc }) {
  const known = roles.length ? roles : ['operator', 'auditor', 'platform_admin'].map(name => ({ name, displayName: name.replaceAll('_', ' ') }));
  const options = known.map(role => `<option value="${esc(role.name)}"${userRoles.length === 1 && userRoles[0] === role.name ? ' selected' : ''}>${esc(roleLabel(role))}</option>`).join('');
  if (userRoles.length === 1 && known.some(role => role.name === userRoles[0])) return options;
  const label = userRoles.length ? userRoles.map(name => known.find(role => role.name === name)?.displayName ?? name).join(' + ') : 'No role';
  return `<option value="__keep" selected>${esc(label)} (unchanged)</option>${options}`;
}
