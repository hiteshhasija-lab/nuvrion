# The reference-scale test: 10,000 virtual machines

The product plan asks for the inventory, dashboard and task scenarios to be run at 10,000 VMs. `tools/run-reference-scale.js` does that on a laptop or a build machine, against a throwaway database, and
writes an evidence file. This page says what it does, how to run it, what it found the first time (21 November 2026), and what it cannot tell you.

## What it does

1. Creates a **throwaway database** on a PostgreSQL on **this machine** and applies every migration. It refuses a database on any other host, needs
   `NUVRION_QUALIFICATION_ACK=synthetic-only`, and drops the database when it finishes.
2. Starts the **real API in the production profile** against that database, as a child process. The one change is that RabbitMQ is replaced by the in-process broker, because no AMQP server is needed on a
   workstation. Background discovery, capacity sampling, alert evaluation and retention are switched off so that only the test drives them.
3. Creates five connections through the API (vCenter 40%, AWS 25%, Azure 20%, a second vSphere fleet 10%, Workstation 5%) on the **mock adapter**: nothing is sent to any provider, and the credentials are fakes.
4. Brings the synthetic estate in through the **real discovery path** (`DiscoveryScheduler.discover`: inventory synchronisation, metric recording, infrastructure objects), so the write path is measured too.
   VMs have realistic names, power states (70% running), sizes, placement on hosts, datastores and networks, and metrics.
5. Tags 3,000 VMs through the API, creates two alert rules, then runs the scenarios below as an administrator signed in over HTTP, and reports p50, p95, p99, maximum, throughput, error rate, response size, and the
   server's CPU time and peak memory.
6. Drives **Chrome** (the same headless driver the browser tests use) to sign in, open the inventory and watch the page.

```bash
NUVRION_QUALIFICATION_ACK=synthetic-only NUVRION_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres node tools/run-reference-scale.js scale-evidence.json
```

The database user must be allowed to create databases (the same server the database tests use). Optional: `NUVRION_SCALE_VMS` (default 10000), `NUVRION_SCALE_TASKS` (1000),
`NUVRION_SCALE_BROWSER=0` to skip Chrome. The full run takes under three minutes. The exit code is 0 when the run completed, whether or not a scenario missed the gate: read the `verdict` section of the evidence.

## The gate

The product already defines API gates in `modules/platform/src/release-qualification.js`: **p95 latency of 500 ms or less**, an error rate of 1% or less, and for tasks a p95 completion of 5 s or less at 10 per second or more. The
test applies those. The TADS document that the plan names for the 10,000-VM targets is not in this repository, so these gates are the only written targets the test could be held to.

## Result of the first run (21 November 2026, commit e84bed6)

Machine: Apple M5, 10 cores, 16 GB, macOS, Node v24.19.0. The load generator, the API and PostgreSQL all ran on it. The database held 10,000 VMs, 160 infrastructure objects and
18,828 metric samples (38.4 MB). The whole inventory list is **14.74 MB** of JSON.

### Requests (milliseconds; the gate is p95 ≤ 500)

| What | Concurrent users | p50 | p95 | max | Response (MB) | Gate |
|---|---|---|---|---|---|---|
| Whole inventory list | 1 | 149.7 | 162.9 | 166.3 | 14.87 | within |
| Whole inventory list | 5 | 524.7 | 652.5 | 726.1 | 14.87 | **over** |
| Search (five different terms) | 5 | 15.4 | 32.1 | 39.2 | 0.37 | within |
| List of one connection (2,500 VMs) | 5 | 122.1 | 206.2 | 208 | 3.30 | within |
| Filter by tag (about 1,500 VMs) | 5 | 357.8 | 457.8 | 463.8 | 2.11 | within |
| One VM's detail | 20 | 2.8 | 7.4 | 42.7 | 0.00 | within |
| Live performance numbers | 5 | 417.7 | 561 | 625.2 | 2.50 | **over** |
| Infrastructure tree (160 objects) | 5 | 4.5 | 5.8 | 6.5 | 0.08 | within |
| Tags | 10 | 1.6 | 4.7 | 6.9 | 0.00 | within |
| Capacity: datastores | 5 | 2.2 | 3.6 | 4.2 | 0.02 | within |
| Capacity: hosts and clusters | 5 | 4.9 | 16 | 17.1 | 0.09 | within |
| Audit page (100 events) | 10 | 4.1 | 7.6 | 9.2 | 0.05 | within |
| Console refresh (21 requests at once) | 1 | 235 | 254.4 | 260.6 | 17.58 | within |
| Console refresh | 5 | 934.4 | 1404.2 | 1479.7 | 17.58 | **over** |
| Console refresh | 20 | 3788.3 | 4312.7 | 4502.6 | 17.58 | **over** |
| Alert evaluation over 10,000 VMs | 1 | 152.9 | 211.9 | 211.9 | 0.00 | within |
| Task list after 1,000 tasks | 5 | 9.6 | 16.4 | 19.9 | 0.21 | within |

Sustained use: **10 people each refreshing the console every 5 seconds for 60 s** (120 refreshes, 0 errors): p50 247.1 ms, p95 307.9 ms, maximum 496.2 ms; 35.16 MB/s sent;
30.56 s of server CPU in the minute; 246.7 MB of memory.

### Tasks, through the API to completion

1,000 power-on operations submitted by 20 concurrent callers: all accepted (p95 14 ms), all completed, none failed. Completion time p50 189 ms, p95 3,818 ms,
maximum 4,295 ms; 208.16 tasks per second over 4.8 s. This uses the in-process broker and the mock provider, so it measures the task store, the outbox and the worker, not a real
RabbitMQ or a real provider.

### Discovery (write path)

| Connection | VMs | First discovery | Per VM |
|---|---|---|---|
| scale-vcenter | 4,000 | 1.79 s | 0.449 ms |
| scale-aws | 2,500 | 1.02 s | 0.41 ms |
| scale-azure | 2,000 | 0.79 s | 0.396 ms |
| scale-esxi-fleet | 1,000 | 0.39 s | 0.388 ms |
| scale-workstation | 500 | 0.20 s | 0.391 ms |

A repeat of the 4,000-VM connection with nothing changed took 1.64 s, and with 10% of the power states changed 1.60 s. All five connections back to back: 3.91 s.

### The browser

| Measure | Result |
|---|---|
| Overview ready after sign-in | 0.2 s |
| Inventory list drawn (10,000 rows) | 4.2 s |
| Page elements | 270,853 |
| JavaScript memory | 17 MB |
| Download of the list | 14.9 MB in about 430 ms |
| Longest freeze in a 20 s watch | **5.1 s** |
| Freezes over 100 ms / over 500 ms | 6 / 4 |

The page does not crash, but it is unresponsive for seconds at a time while it receives and rebuilds the list. The first draw is part of the longest freeze; the console repeats the rebuild at each refresh.

## What it means

- **Nothing failed.** No errors, no lost task (every one accepted completed), memory stayed small (168.5 MB at the end), and every request that is about one VM, a summary or a page of records answered in milliseconds.
- **One thing does not scale: the whole inventory.** `GET /api/v1/resources` has no paging and returns every VM (about 15 MB at 10,000), the console loads it with 20 other requests at every refresh, and filtering, sorting and
  drawing happen in the browser. One person is comfortable (a refresh answered in about 250 ms). Five people refreshing at once are not (p95 1.4 s), and twenty are far past the gate (p95 4.3 s). The same list also makes the
  page freeze for seconds.
- **The live performance numbers** (`/api/v1/performance/latest`, 2.5 MB) are the second request that grows with the estate and also missed the gate with five concurrent callers.
- **Where to look first:** paging and server-side filtering for the inventory, a much longer or change-based refresh, drawing only the visible rows, and limiting the performance numbers to the VMs on screen.

## What the test cannot tell you

- It runs on one machine, so there is no network, and the load generator takes part of the CPU. Production numbers will differ; compare runs on the same machine, not across machines.
- RabbitMQ is replaced, providers are mocked, and the discovery stub returns a ready-made list: the time a real vCenter takes to answer is not measured.
- The estate is synthetic and uniform in shape; real names, tags and notes will make the list larger.
- It does not measure the audit trail at scale (the table holds a few thousand events), 90 days of capacity readings, or seven days of metrics from 10,000 VMs (the sample table holds about 19,000 rows).
- Only one run exists. Run it again before drawing a trend.

The evidence file of this run is kept beside the status document (not in the public repository).
