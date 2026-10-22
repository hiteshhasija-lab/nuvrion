# Capacity: how full each datastore is and when it will be full

The **Capacity** page lists every datastore with how full it is, how fast it is filling and, when there is enough history to say so, **when it will be full**. The aim is a warning in time to
extend a datastore or move machines, not a surprise when virtual machines stop because a disk filled.

## What is recorded

About every half hour Nuvrion keeps one reading of each datastore it can currently see: its size and its free space (from what the provider reports at discovery; a datastore last seen more than
ten minutes ago is not recorded, because the number would be old). Readings are kept for **90 days**. A change of size is recorded at once, so a datastore that was extended shows its new size.
Nothing is recorded for datastores of a connection that cannot be reached, and nothing is invented: a gap in the history is a gap.

## The forecast

A forecast is a **straight line fitted (least squares) through the used space of the last 14 days**. It says:

| | |
|---|---|
| **Growth** | Bytes gained (or lost) per day, from the slope of the line. |
| **Full in** | Free space divided by the growth: *about 38 days*, with the date. Only for a datastore that is growing. |
| **Confidence** | *High*: at least 7 days of readings and the points hug the line (R² ≥ 0.9). *Medium*: at least 3 days and R² ≥ 0.7. Otherwise *low*. |
| **Status** | *Growing*, *stable* (under 1% of the size gained or lost in 30 days), *shrinking*, *full*, or *not enough history*. |

It is deliberately simple, and it refuses to guess:

- **Not enough history**: fewer than 6 readings, or less than a day of them. The page says how full the datastore is and that it cannot say more yet.
- **A change of size inside the window**: only the readings since the change are used, so extending a datastore does not look like a sudden drop in use.
- **Stable or shrinking** datastores have no date. A datastore **already full** is *full*.
- A line cannot know that a big migration is planned, that snapshots are about to be taken, or that a clean-up will run. It is a guide, not a promise.

## The page

- A table, soonest to be full first: size and use (with a bar), free space, growth per day, **Full in** (days and date, with the confidence), and a small trend of the last 14 days.
  A badge says *bad* for a datastore full within 14 days, *warn* within 30 days; the words are in the badge, not only the colour.
- **Details** opens a chart of the used share of the size (solid) with the forecast carried on to the day it reaches 100% (dashed), for the last 7, 30 or 90 days.
- The badge at the top counts the datastores that need attention ("1 full within 14 days").

## Be told in time: an alert rule

**Alert rules** has a measurement **Datastore days until full**. A rule *below 14 days* (warning) and one *below 5 days* (critical) turn the forecast into an alert in the bell (see [alerts](alerts.md)).

- Only a forecast that is trusted is measured: a *low*-confidence forecast, or a datastore with too little history, raises nothing and clears nothing (a measurement that is not reported is not zero).
- A datastore that is not filling reports "no end in sight" (3650 days), so its alert resolves by itself.
- A datastore that is full reports 0.

## Who may do what

Reading capacity needs `resource.view`. There is nothing to configure: the readings are taken by the platform. Creating the alert rule needs `alert.manage`.

## In the API

```
GET /api/v1/capacity/datastores              every active datastore: size, use, forecast { status, confidence, growthBytesPerDay, daysUntilFull, projectedFullAt, ... }, trend
GET /api/v1/capacity/datastores/{id}?days=   one datastore with its readings (days 1 to 90, default 30) for a chart
```

Errors: `NUV_CAPACITY_RANGE_INVALID` (422), `NUV_CAPACITY_DATASTORE_NOT_FOUND` (404).

## How it is kept

Readings are in `monitoring.capacity_samples` (migration 0040; one row per datastore and moment; 90 days). The platform takes readings every minute but keeps at most one per datastore per half hour
(`NUVRION_CAPACITY_INTERVAL_MS`, default 60000, how often it looks; `NUVRION_CAPACITY_SAMPLE_MS`, default 1800000, how close two kept readings may be). The forecast is computed when asked and when
alert rules are evaluated, from `modules/monitoring/src/capacity-rules.js`.

**Not yet**: capacity of hosts (CPU and memory trends), of whole clusters, "what if I add 20 machines", cost, and a forecast that knows about snapshots or planned work. A datastore needs about a day
of readings after Nuvrion starts to record it before it can be forecast; history from before this release does not exist and cannot be reconstructed.
