# Threshold alerts and notifications

Nuvrion watches the numbers it already collects and tells you when one goes where it should not: a datastore filling up, a host running hot, a machine pinned at 100% CPU. You write a **rule**;
when the numbers break it, an **alert** appears in the **notification bell** at the top of every page and on the **Alert rules** page; when the numbers recover, the alert clears by itself.
(Connection problems, which Nuvrion already raised, appear in the same bell.)

## Rules

A rule says: *this measurement of this kind of thing, above (or below) this limit, for at least this long, is a warning (or critical)*.

| Measures | Of | Unit |
|---|---|---|
| Virtual machine CPU use, memory use | each virtual machine | % |
| Host CPU use, memory use | each ESXi or vCenter host | % |
| Datastore space used | each datastore | % |
| Datastore free space | each datastore | GB |
| Datastore days until full | each datastore | days (see [capacity](capacity.md)) |
| Host CPU / memory days until fully used | each ESXi or vCenter host | days (see [capacity](capacity.md)) |
| Cluster CPU / memory days until fully used | each vCenter cluster | days (see [capacity](capacity.md)) |

- **Limit**: a number from 0 to 100 for a percentage (any number for free space in GB). **Above** means strictly above; **below** strictly below.
- **For at least (minutes)**: how long the condition must hold before the alert is raised, 0 to 1440. With 10, a spike that lasts three minutes raises nothing; the clock starts when it first holds, and
  starts over if it stops. (The clock lives in memory, so a restart of Nuvrion starts it again.)
- **Applies to**: all connections, or one. **Severity**: warning or critical. A rule can be turned off without deleting it.
- Names are unique whatever the case; at most 100 rules.
- **Check against current data** (in the rule dialog) shows what the rule would catch *right now*, strongest first, without saving anything or raising an alert: the quickest way to choose a limit.

Nuvrion compares the latest measurements with the rules **every minute**, and **Evaluate now** on the Alert rules page does it at once.

## Alerts

- **One open alert per rule and target** (this VM, this datastore): while the condition holds the alert is refreshed (latest value, last seen), not repeated. When it stops holding the alert is
  **resolved** and kept in the history, with the rule's name and the value it last had; if it comes back, that is a new alert.
- **Acknowledge** says that someone is looking at it. The alert stays open until the numbers recover, so it cannot be silenced by clicking.
- Alerts also end when their rule is turned off or deleted, when the rule no longer covers the target (its connection was changed), or when the target is gone.
- **Old data is not believed.** A target whose latest measurement is more than ten minutes old is left alone: nothing fires on it and nothing clears. When a connection is unreachable its own
  connection alert says so; a stale low reading must not make a real problem look solved. A measurement that is not reported is not zero.

## The notification bell

The bell shows how many things are new to you: alerts raised, alerts resolved, and (if you may see connections) connection problems and recoveries. **Mark all as read** clears it, for you only.
Someone who has never read their notifications sees the last day's as new. The panel lists the latest events with when they happened and links to the Alert rules page.

## Who may do what

| | Needs |
|---|---|
| See the rules, alerts, bell and history | `resource.view` |
| Acknowledge an alert | `resource.operate` |
| Create, change, turn off, delete and evaluate rules, and check a rule | `alert.manage` (new; administrators have it, and it can be given to a custom role, see [roles](roles.md)) |

Creating, changing and deleting rules and acknowledging alerts are in the audit history (`alert.rule_created`, `alert.rule_updated`, `alert.rule_deleted`, `alert.acknowledged`).

## In the API

```
GET    /api/v1/alert-metrics                 what a rule can measure: { key, kind, label, unit, max }
GET    /api/v1/alert-rules                   { ..., summary: "Virtual machine CPU use above 90% for 10 minutes", openAlertCount }
POST   /api/v1/alert-rules                   { name, metric, comparison, threshold, severity, durationMinutes?, connectionId?, description?, enabled? }    alert.manage
POST   /api/v1/alert-rules/preview           the same body: what it would match now, without saving                                                          alert.manage
PATCH  /api/v1/alert-rules/{id}              any of the fields; needs If-Match: "<rowVersion>"                                                               alert.manage
DELETE /api/v1/alert-rules/{id}              its open alerts are resolved and kept as history                                                                alert.manage
POST   /api/v1/alerts/evaluate               evaluate now                                                                                                    alert.manage
GET    /api/v1/alerts?status=open|active|acknowledged|resolved|all
POST   /api/v1/alerts/{id}/acknowledge                                                                                                                       resource.operate
GET    /api/v1/notifications                 the feed and unreadCount          POST /api/v1/notifications/read   marks it read for the caller
```

Errors: `NUV_ALERT_RULE_INVALID` (422), `NUV_ALERT_RULE_EXISTS`, `NUV_ALERT_RULE_LIMIT`, `NUV_ALERT_RESOLVED` (409), `NUV_VERSION_CONFLICT` (412), `NUV_ALERT_RULE_NOT_FOUND`, `NUV_ALERT_NOT_FOUND` (404).

## How it is kept

Rules, alerts and each person's last-read time are in `monitoring.alert_rules`, `monitoring.alerts` and `monitoring.notification_reads` (migration 0038; a partial unique index allows one open alert per rule
and target, so two evaluations at the same moment cannot raise the same alert twice). Evaluation reads the same data the rest of the console shows: the latest sample of each virtual machine, the hosts and
datastores of the [infrastructure](infrastructure.md), and the connections. `NUVRION_ALERT_INTERVAL_MS` (default 60000) sets how often it runs.

Alerts can also be **sent out of the console** to a chat channel or your own system: see [webhooks](webhooks.md). **Not yet**: e-mail, and alerts on the Overview page's counts; the bell and the Alert rules page are where alerts appear today.
