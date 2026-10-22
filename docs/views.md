# Saved views and CSV export of the inventory

## Saved views

The inventory list can be filtered (a search, a platform, a power or health state, a tag) and sorted by a column. A **saved view** remembers all of that under a name, so the list one person
looks at every morning is two clicks away: **Views** (next to the filters) → the view.

- **Save current view…** keeps the search text, the platform, the power and health the Overview drilled into, the tag and the sort column and direction as they are now. The dialog says in words what will be remembered.
- Choosing a view sets all of them. The button then reads **Views: Name**, and **Views: Name (changed)** as soon as the list is filtered or sorted differently, so it is never unclear whether what is on screen is what was saved.
- **Update “Name” to the current filters** saves the change over the view (it is available only while the list differs from it); **Rename…** and **Delete** act on the view in use.
- Views are **personal**. They are kept on the server, so they follow the person to any browser or computer, and nobody else (not even an administrator) sees them. A person keeps at most **20**; names are unique for a person
  whatever the case, but two people may each have a view called "Prod".
- What a view holds is only the filters and the sort: no machines, no selection, and not the column widths (those are remembered by the browser). A view saved with a tag that no longer exists simply shows no machines until the tag is removed from the view.
- Anyone who may view resources may keep views, including the auditor role: a view changes nothing in Nuvrion but the person's own list.

## CSV export

**Export CSV** (next to Views) downloads the list **as it is on screen**: the same machines, filtered and sorted the same way, one row each. With nothing on screen the button is off.

| Column | |
|---|---|
| Name, Platform, Connection | the machine, VMware ESXi / vSphere / Workstation / AWS / Azure, and the connection that reports it |
| Power, Health | as the list shows them (power includes states such as *rebooting* and *unreachable*) |
| Guest OS, Hostname, IP address | as reported; a hostname that is not reported is empty; the first private address, else the first public one |
| CPU use (MHz), CPU use (%), Memory used (GB), Memory use (%), Storage used (GB) | the latest measurements; a measurement that is not reported is **empty, not 0** |
| Host, Datastores, Networks | where it runs, when the provider said (several are joined with “; ”) |
| Tags | `key=value` (or just `key`), joined with “; ” |
| Last seen | when discovery last saw it |

The file is UTF-8 with a byte-order mark (so Excel reads accented names correctly), comma-separated, with quoting as RFC 4180 says and CRLF line ends. It is named `nuvrion-inventory-YYYYMMDD-HHMM.csv`.

**Spreadsheet formulas.** A name or tag that starts with `=`, `+`, `-` or `@` (or a tab or carriage return) would be run as a formula by a spreadsheet, and a hostile guest name could try to use that. Such
a cell is written with a leading apostrophe, so it is shown as text. A real number, such as −5, is left alone.

**Audit.** An export takes inventory out of the platform, so each one is recorded **before** the file is made: `inventory.exported` with who, how many rows and columns, and the filters in words
(for example `running, VMware ESXi, tag env=prod`). If the record cannot be made, there is no file. The audit history holds no machine names, only the size and the filters.

## Who may do what

Saved views and exports need `resource.view` (the permission to see the inventory at all). No new permission.

## In the API

```
GET    /api/v1/saved-views                   the caller's views  { items: [{ id, name, view, rowVersion, ... }], limit: 20 }
POST   /api/v1/saved-views                   { name, view: { search, platform, power, health, tag, sortKey, sortDirection } }
PATCH  /api/v1/saved-views/{id}              { name?, view? }, needs If-Match: "<rowVersion>"
DELETE /api/v1/saved-views/{id}
POST   /api/v1/inventory-exports             { count, columns?, view? }  records that an export was made (no data is returned)
```

`sortKey` is one of `name, status, guestOs, hostname, power, ip, cpu, memory, storage`. Errors: `NUV_VIEW_INVALID` (422), `NUV_VIEW_EXISTS`, `NUV_VIEW_LIMIT` (409), `NUV_VERSION_CONFLICT` (412), `NUV_VIEW_NOT_FOUND` (404; also for another person's view).

## How it is kept

Views are in `inventory.saved_views` (migration 0043; they go with the person if the account is deleted). The CSV is built in the browser from the list already loaded, by `apps/web/views.js`, which has tests for the
quoting and the formula protection.

**Not yet**: sharing a view with other people or making one the default, views of other lists (tasks, audit), choosing the columns of an export, and export of other pages.
