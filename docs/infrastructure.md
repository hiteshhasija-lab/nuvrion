# Infrastructure

Besides virtual machines, a VMware connection reports the things the machines run on: **datacenters, clusters, hosts, datastores and networks**. Nuvrion keeps them as objects of
their own, shows them as a tree, and says on each virtual machine which host, datastores and networks it uses.

## What is reported

| Kind | From ESXi | From vCenter | What is kept |
|---|---|---|---|
| Datacenter | the host's datacenter | each datacenter | name |
| Cluster | – | each cluster | host count, DRS on/off, HA on/off |
| Host | the host itself | each host, under its cluster | power and connection state, product, version, build, processor, cores, CPU and memory capacity and use, uptime |
| Datastore | each datastore | each datastore | type, capacity, free space, accessible, URL |
| Network | each network | each network | type (standard, distributed, opaque), accessible |

Only the attributes in the table are kept; anything else a provider sends is dropped. The mock provider reports a small estate (one datacenter, one cluster, two hosts, two datastores,
two networks) so the pages can be tried without a lab. AWS, Azure and Workstation report none of this, and the page says which connections are silent.

A virtual machine's **placement** (its host, datastores and networks) comes with the machine itself, in the provider metadata, as identifiers. The page joins the two **within one
connection**: the same identifier on two connections is two different objects.

## In the console

- **Infrastructure** (left menu) shows the tree: each connection, then its datacenters, clusters and hosts, with the datastores and networks of a datacenter grouped under it. Every
  entry shows how many virtual machines are on it.
- Choosing an entry shows its details on the right: a host's processor, version, uptime and CPU and memory use as bars; a datastore's space used; the virtual machines on it (each opens
  in the inventory); and, for a host, the datastores and networks its machines use.
- A **virtual machine's detail** (General Information) has **Host**, **Datastores** and **Networks** rows; each name opens that object on the Infrastructure page. The inventory
  search also finds a machine by the name of its host, datastore or network.
- Nothing is shown as current when it is not. If a connection cannot be reached, its entries say "unreachable · last known" and the details say it is what was last seen. An object the
  provider stops reporting stays, marked **missing** with when it was last seen; if it comes back it is active again under the same identity.

## In the API

```
GET /api/v1/infrastructure                       every object: { id, connectionId, providerType, kind, nativeId, name, parentNativeId, attributes,
                                                  lifecycleState, observedAt, firstSeenAt, lastSeenAt, missingSince }
GET /api/v1/infrastructure?connectionId=…        one connection
GET /api/v1/infrastructure?kind=host             one kind (datacenter, cluster, host, datastore, network)
GET /api/v1/infrastructure?lifecycleState=missing   active, missing or deleted (deleted objects are left out unless asked for)
```

Anyone who may view resources may read it. There is no write call: the objects are what providers report.
Virtual machine lists and counts never include these objects; they are a separate table (`inventory.infrastructure_objects`, migration 0033) and a separate endpoint.

## How it is kept

- Each discovery pass of a connection, after the virtual machines, asks the provider for its infrastructure and **synchronizes** it: new objects are created, known ones updated, objects
  not reported any more become *missing*. Identity is `(connection, kind, native identifier)`, so an object keeps its Nuvrion identifier across renames.
- **A provider's reply is not trusted.** The kind must be one of the five; text is stripped of control and invisible characters and cut to a limit (a string far over the limit is dropped, not
  trimmed into something plausible); numbers must be real non-negative integers; at most 5,000 objects per report and none twice. A report that breaks these is refused as a whole and
  the previous state stays.
- **It never costs a virtual machine discovery.** If the infrastructure call or its synchronization fails, the machines are still discovered and the failure is written to the server log
  (`discovery.failed`, naming the connection with "(infrastructure)") and the previous infrastructure stays.
- **vCenter is all or nothing**: a partial listing (one of the five lists failing) is not applied, because it would mark everything in the failed list as missing.
- **ESXi** is read through the same SOAP session as the machines, with paging limits (200 objects a page, 20,000 in all).
- Deleting a connection retires its objects (state *deleted*); they no longer appear anywhere.
