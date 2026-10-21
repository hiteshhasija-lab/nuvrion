# Scheduled operations

A **schedule** asks Nuvrion to start, stop or restart virtual machines at a time you choose: switch the test machines off at 19:00, start them at 07:30 on weekdays, restart a service host every
Sunday night, power something on once for a maintenance window. The **Schedules** page lists them, shows when each runs next and what happened last, and keeps the history of runs.

A run is not a shortcut around anything. Nuvrion asks for the operation **exactly as the person who made the schedule would by pressing the button**, through the same task engine, so it is
audited, shows in the task history, and obeys the same rules about machine state.

## What a schedule says

| | |
|---|---|
| **Operation** | Power on, Shut down guest, Power off, Suspend, Restart guest OS, or Restart. |
| **Which machines** | *Machines I choose* (at most 50), or *machines with a tag when it runs* (`env` for any value, `env=dev` for one; optionally only in one connection). |
| **How often** | Once (on a date), every day, or on chosen days of the week. |
| **Time and time zone** | A time of day such as 19:00 **in the time zone you give** (`Europe/London`, `Asia/Kolkata`, `UTC`). The page suggests your browser's zone. |
| **Name, description, on/off** | Names are unique whatever the case; at most 100 schedules. A schedule can be turned off without deleting it. |

- **Tags are looked at when the schedule runs**, not when it is made. A machine tagged later is included; one that lost the tag is not. This is how "everything in `env=dev`" stays true as machines come and go.
- **Check when it would run** (in the dialog) shows the next three run times and which machines the schedule would cover *right now*, without saving anything.
- **Run now** runs a schedule once, at once, as you. It does not change the schedule's next run.

## Time zones and daylight saving

Times are kept in the schedule's own time zone, so "07:30 in London" stays 07:30 across the clock change.

- When the clocks go **back** and a time happens twice, the schedule runs the **first** time.
- When the clocks go **forward** and a time does not exist (02:30 in the spring), it runs just **after** the gap.

## What a run does

For each machine the schedule covers, Nuvrion checks that the operation is possible in the machine's current state and then asks for it.

- A machine the operation cannot apply to (starting one that is already running, stopping one that is already off) is **skipped**, with the reason, not failed. A run that only skips is not an error.
- **One broken machine does not stop the others.** The run's outcome is *completed* (all requested), *partial* (some failed), *failed* (all failed), or *skipped* (nothing needed doing).
- A listed machine that no longer exists is skipped and noted.
- Each request carries a key made from the schedule, the planned time and the machine, so the same planned run can never ask for the same operation twice, even if Nuvrion restarts during it.
- The run is recorded with the machines it covered, what was done to each, and the task for each request.

### When Nuvrion was not running

Nuvrion checks for due schedules every 30 seconds. A run up to **15 minutes late** still happens. A run later than that (Nuvrion was stopped, upgraded or unreachable at the time) is **not** performed: it is
recorded as **missed**, because starting or stopping machines hours after the planned moment is more likely to do harm than good. The schedule then carries on with its next run. A *once* schedule that
was missed turns itself off.

### Whose permissions

The schedule runs **as the person who made it, with the permissions they have at the moment it runs**. If that person has been deactivated, or no longer may operate machines, the run does not happen and
is recorded as *could not run*, with the reason. Changing the role of the person who owns schedules therefore changes what their schedules can do.

## Who may do what

| | Needs |
|---|---|
| See schedules and the history | `resource.view` |
| Create, change, turn on/off, delete, preview and run a schedule | `schedule.manage` (new; operators and administrators have it; it implies `resource.view` and `resource.operate`, see [roles](roles.md)) |

Creating, changing, deleting and running are in the audit history (`schedule.created`, `schedule.updated`, `schedule.deleted`, `schedule.run`; the last also for runs made on schedule, by the user "scheduler").

## In the API

```
GET    /api/v1/schedules                      { items: [{ ..., summary, nextRunAt, lastRun }], operations }                                       resource.view
POST   /api/v1/schedules                      { name, operation, targetKind: vms|tag, vmIds | tag [+ connectionId], frequency, timeOfDay,
                                                weekdays?, runDate?, timeZone?, description?, enabled? }                                        schedule.manage
POST   /api/v1/schedules/preview              the same body: next runs and the machines it would cover now, nothing saved                          schedule.manage
PATCH  /api/v1/schedules/{id}                 any of the fields; needs If-Match: "<rowVersion>"; fields that no longer apply are dropped          schedule.manage
DELETE /api/v1/schedules/{id}                 the history is kept, under the schedule's name                                                      schedule.manage
POST   /api/v1/schedules/{id}/run             run now, as the caller; returns the run                                                              schedule.manage
GET    /api/v1/schedule-runs?scheduleId=&limit=
```

Errors: `NUV_SCHEDULE_INVALID` (422), `NUV_SCHEDULE_EXISTS` (409), `NUV_SCHEDULE_LIMIT` (409), `NUV_VERSION_CONFLICT` (412), `NUV_SCHEDULE_NOT_FOUND` (404).

## How it is kept

Schedules and their runs are in `operations.schedules` and `operations.schedule_runs` (migration 0039; at most 200 runs are kept per schedule). Due schedules are claimed with `FOR UPDATE SKIP LOCKED`, so
two Nuvrion processes cannot both run one. `NUVRION_SCHEDULE_INTERVAL_MS` (default 30000) sets how often the check runs.

**Not yet**: snapshots on a schedule (a recovery point before a risky change), a schedule for a group of machines other than by tag, a calendar of exceptions (holidays), and telling someone when a run fails
(see the alert delivery work in [alerts](alerts.md)). The Schedules page and the run history are where results appear today.
