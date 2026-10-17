# Tags

Tags label virtual machines so they can be found, grouped and acted on together: `env: prod`, `team: core`, `owner: ann`. Nuvrion keeps its **own** tags and shows the tags
a **provider** reports beside them.

## What a tag is

| | |
|---|---|
| Key | lower case, 1 to 64 characters: letters, digits and `. _ : / -`, starting with a letter or digit. A key typed as `Env` is stored as `env`, so `Env` and `env` cannot both exist |
| Value | optional, up to 128 characters, any letters (so `Zürich` and `東京` are fine); no control characters and no invisible formatting characters |
| Reserved | keys starting `nuvrion:`, `aws:`, `azure:`, `vmware:` or `microsoft:` cannot be set |
| Limits | 50 tags on a resource; one request changes at most 200 resources, sets at most 20 tags and removes at most 20 |
| Source | `nuvrion` (set here, changeable) or `provider` (reported by Azure or AWS, read-only) |

A tag Nuvrion writes can never hide or replace a provider tag: they are different lists, shown together and marked apart (provider tags have a dashed outline).
VMware ESXi, vCenter and Workstation report no tags today, so those VMs carry only Nuvrion's.

## In the console

- **The list** shows the first three tags under each VM's name, `+n` for the rest (hover for the names).
- **Filter by tag** (next to the platform filter) lists each key with the number of VMs that have it, and each value when a key has a few. The choice shows as a chip
  ("Tag: env = prod ✕"), alongside any power or health filter from the Overview, and can be removed.
- **Tag…** (next to the filters) opens the dialog for the VMs you have ticked, or for the VM that is open; its name says how many ("Tag 3…"). In a VM's detail, **Edit tags**
  next to its tags does the same for that VM alone.
- **The dialog** lists the tags Nuvrion holds on the chosen VMs and how many of them carry each ("on all 3", "on 2 of 3"), with Remove for each, and a form to add or change a tag
  (it suggests the keys already in use). Each action is its own request and the dialog shows the result. A key that is not valid is explained in the dialog, which stays open.
- Who may change tags: anyone allowed to operate resources (operators and administrators). Auditors see tags but are not offered the button, and the server refuses them anyway.

## In the API

```
GET  /api/v1/resources                       each resource has "tags": [{ key, value, source }]   (Nuvrion's first, then the provider's)
GET  /api/v1/resources?tag=env               only resources with the key; repeat ?tag= to require several
GET  /api/v1/resources?tag=env%3Dprod        only resources where env is exactly "prod"   (keys compare in lower case, values exactly)
GET  /api/v1/tags                            every key in use with its values and counts
POST /api/v1/tag-operations                  { "resourceIds": [...], "set": [{ "key": "env", "value": "prod" }], "remove": ["old"] }
```

A tag operation is **all or nothing**: if any resource does not exist, or any tag is invalid, or any resource would end up with more than 50 tags, nothing changes. Setting what is
already there is not a change. The answer lists each resource's tags afterwards and how many actually changed (`changedCount`). Errors: `422 NUV_TAG_REQUEST_INVALID` (the
message says which tag and why), `422 NUV_TAG_LIMIT_EXCEEDED`, `404 NUV_RESOURCE_NOT_FOUND` (nothing was changed).

Every resource whose tags actually change gets a `resource.tags_updated` audit event with who did it and what was added (`added`), changed (`changed`, with `from` and the new
`value`) and removed (`removed`). A request that changed nothing is not audited.

## How it is stored

`inventory.resource_tags` (migration 0032): one row per resource and key, deleted with its resource. The table itself refuses a key that is not lower case and plain, and a value
longer than 128 characters. Concurrent requests are serialised so that two together cannot take a resource past 50 tags. In local (file-backed) mode the tags are in
`NUVRION_TAGS_FILE` (default `.nuvrion/tags.json`).

## Not done

Tag-based **actions** (scheduling, policies and alerts by tag), tags that **follow a VM across providers**, writing tags **back** to Azure or AWS, and reading **vCenter** tags
(the vCenter adapter has not been validated against a live vCenter). Tags are not copied when a VM is cloned or migrated, because neither exists yet.
