# Marketing Analytics (GA4) for ERPNext

Technical Documentation and User Manual

App: `erpnext_marketing_analytics` · Version 0.0.1 · Author: Yanky · MIT licence · Written from the repository source (main branch), October 2026

## About this document

This document has two parts.

- **Part 1: Technical documentation** is for developers and administrators. It covers architecture, data model, configuration, the sync engine, the live snapshot widgets, the API, security, known issues and a troubleshooting runbook.
- **Part 2: User manual** is for the marketing people who read the dashboard, and for the administrator who does the one-time setup.

Every technical statement was checked against the source code, not only the README. Where the README and the code disagree, the code wins and the difference is listed under Known issues.

# Part 1: Technical documentation

## 1. Overview

The app brings **Google Analytics 4 (GA4)** reporting into ERPNext. It does two separate jobs.

1. **Stored daily reporting.** A scheduled sync copies daily summary metrics and three daily breakdowns (landing page, source and medium, campaign) from the GA4 Data API into ERPNext DocTypes. The *Marketing Analytics Dashboard* page reads these stored records.
2. **Live snapshot.** A grid of cards on the same page (overview, realtime users, channels, countries, cities, events, pages, a country report and weekly retention) that is fetched live from GA4 and cached for ten minutes. It mirrors GA4's own *Reports snapshot*.

The two are kept apart on purpose. Active users are **not additive** across days, because the same person visits on many days. Summing daily active users overcounts, so any figure that must be a true unique count (28-day, 7-day and 1-day active users, new users, retention) comes live from GA4, not from the stored tables.

The integration is read-only: it only ever reads from GA4.

**Environment.** Frappe/ERPNext v15, Python 3.10 or newer, and the `google-analytics-data` package (`>=0.18.15,<1.0.0`).

## 2. Architecture

| Layer | File | Responsibility |
| --- | --- | --- |
| GA4 client and sync | `ga4.py` | Builds the client, runs reports, upserts records, writes the Sync Log |
| Scheduler task | `tasks.py` | `daily_sync()`, re-syncs the lookback window each day |
| Whitelisted API | `api.py` | `sync_now()` and `get_dashboard_data()` |
| Live widgets | `snapshot.py` | `get_widget()`, one cached GA4 query per card |
| Storage | `marketing_analytics/doctype/*` | GA4 Settings, GA4 Daily Analytics, GA4 Breakdown, GA4 Sync Log |
| UI | `marketing_analytics/page/marketing_analytics_dashboard/`, `public/js/marketing_snapshot.js`, `public/css/` | Dashboard page and snapshot grid |
| Setup | `setup.py` (inside the package), `hooks.py` | Creates the role, registers scheduler and JS |

**Data flow**

```
                       GA4 Data API (analyticsdata.googleapis.com)
                          ^                              ^
   Scheduler (daily_long) |                              | per card, cached 10 min
   or Sync Now            |                              |
      tasks.daily_sync / api.sync_now           snapshot.get_widget(widget)
              |                                          |
        ga4.sync_range()                          frappe.cache()
              |                                          |
   GA4 Daily Analytics / GA4 Breakdown            Snapshot card grid
   GA4 Sync Log                                           ^
              |                                          |
      api.get_dashboard_data()  -->  Marketing Analytics Dashboard page
```

Both paths share one credentials routine, `ga4._client_and_property()`.

## 3. Repository layout

```
erpnext_marketing_analytics/
  README.md  pyproject.toml  setup.py  license.txt
  .github/workflows/ci.yml  linter.yml
  erpnext_marketing_analytics/
    hooks.py            required_apps, app_include_js, install hooks, scheduler
    ga4.py              client, reports, upserts, sync_range()
    api.py              sync_now(), get_dashboard_data()
    snapshot.py         get_widget() and the widget queries
    tasks.py            daily_sync()
    setup.py            creates the "Marketing Analytics Manager" role
    modules.txt         "Marketing Analytics"
    public/js/marketing_snapshot.js    snapshot grid (loaded on every Desk page)
    public/css/marketing_analytics_dashboard.css
    tests/test_keys.py  one test, for metric order
    marketing_analytics/
      doctype/ga4_settings  ga4_daily_analytics  ga4_breakdown  ga4_sync_log
      page/marketing_analytics_dashboard/
```

The Python package is `erpnext_marketing_analytics`, but the module folder is `marketing_analytics`. DocType and Page paths therefore sit under `erpnext_marketing_analytics/marketing_analytics/`. This nesting matters, see the runbook entry on orphaned DocTypes.

## 4. Data model

All four DocTypes have **track changes** enabled. The controllers are empty (`pass`); all logic lives in `ga4.py`.

### 4.1 GA4 Settings (single)

| Field | Type | Notes |
| --- | --- | --- |
| `enabled` | Check, default 0 | Master switch. The sync and the scheduler refuse to run when off |
| `property_id` | Data, required | The numeric GA4 property ID. The `G-...` measurement ID is rejected |
| `lookback_days` | Int, required, default 7 | Days re-synced by the scheduled job and by Sync Now |

The service-account credentials are **not** stored here. They are referenced by file path in the site config (section 5).

### 4.2 GA4 Daily Analytics

One record per date. The record name is the ISO date (for example `2026-10-12`) because naming is `field:record_key`.

| Field | Type | Notes |
| --- | --- | --- |
| `record_key` | Data, unique, required | The ISO date |
| `date` | Date, required | Title field, sorted newest first |
| `active_users`, `total_users`, `sessions`, `page_views`, `event_count`, `conversions` | Float, default 0 | See the metric mapping in 6.4 |

### 4.3 GA4 Breakdown

One record per date, breakdown type and value. The record name is a 64-character SHA-256 hash (see 6.5).

| Field | Type | Notes |
| --- | --- | --- |
| `record_key` | Data, unique, required | The hash |
| `date` | Date, required |  |
| `dimension_type` | Select, required | Landing Page, Traffic Source or Campaign |
| `dimension_value` | Small Text, required | The raw GA4 value, or `(not set)` |
| `landing_page` | Small Text | Filled when the type is Landing Page |
| `source_medium` | Data | Filled when the type is Traffic Source. Limited to 140 characters |
| `campaign` | Data | Filled when the type is Campaign. Limited to 140 characters |
| the six metric fields | Float | Same as Daily Analytics |

### 4.4 GA4 Sync Log

One record per sync run, named by a random hash.

| Field | Type | Notes |
| --- | --- | --- |
| `status` | Select, required | Running, Success or Failed |
| `triggered_by` | Select, required | Manual or Scheduler |
| `start_date`, `end_date` | Date, required | The range that was requested |
| `started_at`, `ended_at` | Datetime | `ended_at` is empty while a run is in progress |
| `rows_processed` | Int | Summary rows plus breakdown rows |
| `message` | Small Text | Up to 1000 characters |
| `error_details` | Long Text, read-only | Traceback, up to 10,000 characters, on failure |

### 4.5 Permissions

- **System Manager:** read, write, create, delete, export, report on all four DocTypes.
- **Marketing Analytics Manager:** the same except delete. This role is created by the install hooks (`before_install` and `after_install`) with desk access.
- **Dashboard page:** System Manager and Marketing Analytics Manager.

All API methods check read permission on **GA4 Settings** (the Administrator user always passes).

## 5. Configuration and credentials

1. **Enable the GA4 Data API** in the Google Cloud project that owns the service account.
2. **Create a service account** and download its JSON key. Store the file on the server where only the bench user can read it. Never commit it or put it in a public folder.
3. **Grant the service account's email Viewer access** on the exact GA4 property, in GA4 Admin under *Property access management*.
4. **Point the site at the key file:**

   ```bash
   bench --site <site> set-config ga4_credentials_file /absolute/secure/path/ga4-service-account.json
   ```
5. In Desk, open **GA4 Settings**: tick *Enabled*, enter the numeric *GA4 Property ID*, and set *Lookback Days* (7 is recommended, so late-arriving data can settle).
6. Enable the scheduler: `bench --site <site> enable-scheduler`.

`ga4._client_and_property()` validates all of this on every call and fails with a clear message: integration disabled, property ID not numeric, `ga4_credentials_file` missing from site config, or the file not found. It builds the client with the read-only scope `https://www.googleapis.com/auth/analytics.readonly`.

The server must be able to reach Google over HTTPS. Reports go to `analyticsdata.googleapis.com:443` over gRPC.

## 6. Sync engine

### 6.1 Triggers

| Trigger | Entry point | Window |
| --- | --- | --- |
| Scheduler, daily | `tasks.daily_sync()` on the `daily_long` event | Yesterday back through *Lookback Days* |
| GA4 Settings, **Sync Now** | `api.sync_now()` | The same default window, or explicit start and end dates |
| Dashboard page, **Sync Now** | `api.sync_now()` | The default window |

The window always ends **yesterday**, because GA4 data for the current day is incomplete. The scheduled job does nothing when *Enabled* is off, and on any error it logs *GA4 scheduled sync failed* and re-raises.

`api.sync_now(start_date, end_date)` runs the sync inside the web request. It rejects a start date after the end date, and rejects ranges longer than 365 days (its message says 366).

### 6.2 Algorithm: `ga4.sync_range(start, end, trigger)`

1. Insert a **GA4 Sync Log** with status *Running* and commit, so the attempt is visible immediately.
2. Build the client and validate settings (section 5).
3. Run the **summary report** (dimension `date`) and upsert one GA4 Daily Analytics record per day.
4. Run three **breakdown reports** (dimensions `date` plus one more) and upsert GA4 Breakdown records.
5. On success: set the log to *Success*, store `rows_processed`, `ended_at` and a message, commit, and return `{status, log, rows_processed, start_date, end_date}`.
6. On any exception: **roll back** the whole run's data changes, mark the log *Failed* with the message and traceback, commit the log, write an Error Log entry titled *GA4 sync failed*, and re-raise.

Because nothing is committed between the log creation and the final success, a run is all-or-nothing: a failure leaves the stored data exactly as it was before.

### 6.3 Reports requested

Every report asks for the six metrics in 6.4 and is read page by page (page size 100,000 rows, using an offset loop until all rows are fetched).

| Report | Dimensions | Stored in |
| --- | --- | --- |
| Summary | `date` | GA4 Daily Analytics |
| Landing pages | `date`, `landingPagePlusQueryString` | GA4 Breakdown, type Landing Page |
| Traffic sources | `date`, `sessionSourceMedium` | GA4 Breakdown, type Traffic Source |
| Campaigns | `date`, `sessionCampaignName` | GA4 Breakdown, type Campaign |

### 6.4 Metric mapping

| GA4 API metric | Stored field | Dashboard label |
| --- | --- | --- |
| `activeUsers` | `active_users` | Active Users |
| `totalUsers` | `total_users` | Total Users |
| `sessions` | `sessions` | Sessions |
| `screenPageViews` | `page_views` | Page Views |
| `eventCount` | `event_count` | Events |
| `keyEvents` | `conversions` | Conversions / Key Events |

`keyEvents` is GA4's successor to the older "conversions" metric. Only events you mark as key events in GA4 Admin are counted. The field is still called `conversions` for historical reasons.

### 6.5 Idempotency

Re-running a sync never creates duplicates, which is what makes the daily re-sync of recent days safe.

- **Daily Analytics** is keyed by the ISO date.
- **Breakdown** is keyed by `sha256("<date>|<type>|<value>")`, so the same date, type and value always map to the same record.
- `_upsert()` looks up the record by `record_key`. If found it updates the values with `frappe.db.set_value(..., update_modified=False)`. If not found it inserts a new record with `ignore_permissions=True`.

Because updates use `set_value`, they skip validation and document hooks and leave the *Modified* timestamp unchanged. A record's *Modified* time is therefore when it was created, not when it was last refreshed. Use the Sync Log to see when data was last refreshed.

### 6.6 Failure behaviour

- A failed run rolls back, so partial days never appear.
- The Sync Log always records the outcome, including the traceback.
- The Sync Log's *Failed* record is created in a separate transaction after the rollback, so it survives.
- The sync makes **no retry** on transient network errors. A single DNS or connection failure fails the whole run (see Known issues).

## 7. The live snapshot

### 7.1 How it works

The snapshot is a grid of cards. The `erpnext_marketing_analytics.Snapshot` class (in `public/js/marketing_snapshot.js`) draws the grid and fires **one `frappe.call` per card** to `snapshot.get_widget(widget, days, force)`. Each call returns either `{data}` or `{error}`, so one failing report never blanks the page. While loading a card shows a placeholder, and on error it shows the message with a **Retry** link. The *Active users in last 30 minutes* card refreshes itself every 60 seconds, and its timer stops once the grid is removed from the page.

The page drives the grid through two methods: `set_days(n)` to change the period and `refresh(force)` to reload every card.

### 7.2 Cards and the GA4 requests behind them

| Widget key | Card | GA4 request | Notes |
| --- | --- | --- | --- |
| `headline` | Overview | `activeUsers`, `newUsers`, `userEngagementDuration`, `engagedSessions`, as totals and by `date` | Four clickable tabs. Engagement per user is duration divided by active users. Sessions per user is engaged sessions divided by active users |
| `realtime` | Active users in last 30 minutes | Realtime report: total, by `country` (top 5), by `minutesAgo` (30 bars) | Cached for only 30 seconds |
| `new_users_channel` | New users by first user channel | `firstUserPrimaryChannelGroup` with `newUsers`, top 7 | Falls back to `firstUserDefaultChannelGroup` if the API rejects the name |
| `sessions_channel` | Sessions by session channel | `sessionPrimaryChannelGroup` with `sessions`, top 7 | Same fallback to `sessionDefaultChannelGroup` |
| `activity` | User activity over time | `active28DayUsers`, `active7DayUsers`, `active1DayUsers` by `date` | The API offers 28-day, not 30-day, rolling users |
| `events` | Event count by event name | `eventName` with `eventCount`, top 7 | Shown in compact form (3.4K) |
| `countries` | Active users by country | `country` with `activeUsers`, top 8 |  |
| `cities` | Active users by city | `city` with `activeUsers`, top 7 |  |
| `pages` | Views by page title | `unifiedScreenName` with `screenPageViews`, top 7 |  |
| `country_details` | Demographic details: Country | Nine metrics by country (top 50) plus a total, and active users per day for the top 10 countries | Four requests, the heaviest card (7.3) |
| `cohort` | Retention by weekly cohort | Cohort report: six weekly cohorts by `firstSessionDate` (Sunday to Saturday), `cohortActiveUsers` and `cohortTotalUsers` | Weeks that have not happened yet are blank. The *All users* row is weighted by cohort size |

A full refresh costs **17 GA4 requests**: headline 2, realtime 3, country report 4, and one each for the other eight cards.

### 7.3 The country report card

Columns: Active users, New users, Engaged sessions, Engagement rate, Engaged sessions per active user, Average engagement time per active user, Event count, Key events, User key event rate and Total revenue. The additive columns (active users, new users, engaged sessions, event count, key events) also show each country's percentage of the total. The chart plots *Total* plus the countries you tick. Only the **top 10** countries have a checkbox, and the first five start ticked. The table has a search box, a rows-per-page selector (10, 25, 50) and Prev and Next buttons. Revenue is shown as a plain number with no currency symbol.

### 7.4 Window, caching and resilience

- **Window.** The last *N* days **including today**: `(N-1)daysAgo` through `today`. The stored section of the page ends yesterday (see section 9).
- **Cache.** Key `ma_snapshot:<widget>:<days>`, kept for 600 seconds (30 for realtime). It is shared by all users. `force=1` bypasses it, which is what **Refresh** and **Sync Now** do. Errors are never cached.
- **Retries.** `ServiceUnavailable` and `DeadlineExceeded` are retried with exponential back-off from 1 to 8 seconds, up to 40 seconds in total. Each request has a 30 second timeout (20 for realtime).
- **Error reporting.** A network failure returns a fixed message about reaching the Google Analytics API. Any other error is written to the Error Log as *GA4 snapshot: \<widget>* and its first 300 characters are returned to the card.

### 7.5 What the snapshot cannot reproduce from GA4's own screen

The API does not expose GA4's *Insights* and Google Ads upsell cards, the *Peer median* benchmark band, or the world map. The country list is provided instead. Numbers will not match the GA4 interface exactly: 28-day rather than 30-day users, a different cohort basis, and GA4's own thresholding all contribute.

## 8. API reference

| Method | Arguments | Returns | Access |
| --- | --- | --- | --- |
| `erpnext_marketing_analytics.api.sync_now` | `start_date`, `end_date` (both optional) | `{status, log, rows_processed, start_date, end_date}` | Read permission on GA4 Settings |
| `erpnext_marketing_analytics.api.get_dashboard_data` | `days` (1 to 365, default 30) | `{start_date, end_date, days, totals, trend, breakdown, last_sync}` | Same |
| `erpnext_marketing_analytics.snapshot.get_widget` | `widget`, `days` (1 to 365, default 28), `force` | `{data}` or `{error}` | Same. An unknown widget name throws |

**`get_dashboard_data` in detail.** The window ends yesterday and starts *days* earlier. `totals` are sums of the stored daily records. `trend` has one entry per day. `breakdown` holds, for each of the three types, the records aggregated across the window by value (summing sessions, active users, page views, events and conversions) and cut to the **top 10 by sessions**. `last_sync` is `ended_at` of the latest *Success* log.

Internal functions: `ga4.sync_range`, `ga4._client_and_property`, `ga4._run_report`, `ga4._metric_values`, `ga4._upsert`, `ga4._upsert_summary`, `ga4._upsert_breakdown` and `tasks.daily_sync`.

**Running a sync from the bench console**

```python
frappe.set_user("Administrator")
frappe.get_attr("erpnext_marketing_analytics.api.sync_now")()
```

## 9. The dashboard page

**Route:** `/app/marketing-analytics-dashboard`, titled *Marketing Analytics*. **Roles:** System Manager, Marketing Analytics Manager.

**Toolbar**

- **Period:** 7 Days, 30 Days (default) or 90 Days.
- **Sync Now:** runs `api.sync_now`, then reloads the whole page with the snapshot cache bypassed.
- **Refresh:** reloads the whole page with the cache bypassed. It does not contact GA4 for the stored data.
- Changing **Period** reloads the stored section and sets the snapshot to the same number of days, using cached cards where they exist.

**Page order, top to bottom**

1. A **Last successful sync** line (or *No successful sync recorded yet*).
2. The **stored section:** six KPI cards (Active User-Days, Total User-Days, Sessions, Page Views, Events, Conversions / Key Events) with a footnote, a **Traffic Trend** line chart of sessions, active users and page views, and three tables (Top Landing Pages, Top Traffic Sources, Top Campaigns) showing sessions and key events. The tables use a fixed layout so long values wrap instead of scrolling.
3. The **snapshot grid** from section 7.

The KPI cards and tables read GA4 Daily Analytics and GA4 Breakdown through `get_dashboard_data`. User counts on those cards are **sums of daily counts** (user-days), not unique users over the whole period. The footnote says so, and the snapshot's Overview card is the place for true unique counts.

The **GA4 Settings** form has its own *Sync Now* button, shown once the settings are saved and enabled. It asks for confirmation, runs the sync, and opens the GA4 Sync Log list.

## 10. Scheduler and performance

- **Schedule.** `tasks.daily_sync` is registered on `daily_long`, so it runs once a day on the long queue, which allows much longer jobs than the default queue. The scheduler must be enabled and a worker running.
- **Cost of a run.** Four reports per run, each read in pages of 100,000 rows. Each returned row costs one lookup plus one update or insert. A seven-day window is usually a few thousand rows, but a 365-day backfill with many landing-page variants can reach hundreds of thousands of rows inside one transaction.
- **Manual sync** runs inside the web request. Large ranges can exceed the web timeout.
- **Snapshot.** 17 GA4 requests per full refresh, softened by the 10-minute shared cache. GA4's Data API has per-property quotas, so avoid scripts that call `force` repeatedly.

## 11. Security and privacy

- **Credentials.** The service-account key stays on disk and is referenced by path in `site_config.json`, so no secret is stored in a DocType. Make the file readable only by the bench user (for example mode 600) and keep it out of Git. The scope is read-only.
- **Access control.** All three whitelisted methods check read permission on GA4 Settings. Read permission is enough to run a sync, because `sync_now` does not require write (see Known issues).
- **Cache.** The snapshot cache is shared across users, which is fine because access is restricted to the same roles.
- **Personal data.** GA4 returns aggregated numbers, so no individual user data is stored. One caveat: landing-page values keep their **query strings**, and these can contain click identifiers or, with poorly designed links, personal data such as emails. They are stored as received.

## 12. Known issues and limitations

Each item was verified in the code. Fixes are suggestions, not applied changes.

| # | Issue | Impact | Suggested fix |
| --- | --- | --- | --- |
| 1 | `ga4._run_report` has no retry and no timeout | One transient network or DNS failure fails the whole run, which then rolls back. The snapshot already retries, the sync does not | Pass `retry=Retry(...)` and `timeout=` to `run_report`, as `snapshot.py` does |
| 2 | gRPC uses its own DNS resolver | On some servers (WSL, VPNs, custom resolvers) gRPC cannot resolve Google while the operating system can, giving *Timeout while contacting DNS servers* | Set `GRPC_DNS_RESOLVER=native` in the environment of the web and worker processes |
| 3 | Landing pages are requested as `landingPagePlusQueryString` and stored unchanged | Click IDs such as `fbclid` and `gclid` make one row per click, which bloats the table and fills the top-pages list with noise | Strip tracking parameters and aggregate before upserting, or request the path-only `landingPage` |
| 4 | `campaign` and `source_medium` are Data fields (140 characters) | A longer value fails the insert with a character-length error. The update path skips validation, so only new rows hit it | Make them Small Text, or truncate in `_upsert` |
| 5 | `_upsert` updates through `frappe.db.set_value` | No validation or hooks, and *Modified* never changes after creation | Use the Sync Log to judge freshness, or set `update_modified=True` |
| 6 | `sync_now` runs in the web request for up to 365 days, and its message says 366 | Possible web timeout on large ranges | Enqueue it on the long queue and report progress through the Sync Log |
| 7 | `sync_now` needs only read permission on GA4 Settings | A read-only user can trigger GA4 calls | Require write permission or a dedicated role |
| 8 | Date windows differ. Stored cards end yesterday in the site timezone, the snapshot ends today, the cohort uses the server's `date.today()`, and GA4 uses the property's timezone | Numbers on the two halves of the page will not match, and boundaries can shift around midnight | Align timezones, and state the window on the page |
| 9 | `lookback_days` is not validated | `0` silently becomes 7, and a negative value produces an inverted range and a GA4 error | Add a validate method that requires 1 or more |
| 10 | A full snapshot refresh costs 17 requests, the cache is shared, and `force` is open to every permitted user | Easy to burn GA4 quota | Restrict `force` or rate-limit it |
| 11 | `app_include_js` loads the 17 KB snapshot script on every Desk page and injects its stylesheet each time | Small, constant overhead for all desk users | Load it only on the dashboard page with `frappe.require` |
| 12 | Packaging is declared twice (`setup.py` and flit `pyproject.toml`), and the README refers to a `requirements.txt` that does not exist | Confusing installs | Keep one, and fix the README |
| 13 | The CI workflow runs on pushes to `develop`, but the default branch is `main`, and the only test checks metric order | Pushes to `main` are not tested | Trigger CI on `main` and add tests for `_upsert` and `sync_range` |

## 13. Installation and deployment

**Prerequisites**

- A bench running Frappe/ERPNext v15 with the scheduler enabled and at least one worker running.
- A Google Cloud project with the **Google Analytics Data API** enabled, and a service account with a JSON key.
- Outbound HTTPS from the server to Google.

**Steps**

1. Back up first, because migrate can delete DocTypes it cannot load (see the runbook): `bench --site <site> backup`.
2. Install the app:

   ```bash
   cd ~/frappe-bench
   bench get-app https://github.com/Yaiphalemba/erpnext_marketing_analytics.git
   bench --site <site> install-app erpnext_marketing_analytics
   bench --site <site> migrate
   bench --site <site> clear-cache
   bench restart
   ```

   The install hooks create the *Marketing Analytics Manager* role. The `google-analytics-data` dependency is declared in `pyproject.toml`. If you install from a copied folder, run `bench setup requirements` first.
3. Configure credentials and GA4 Settings (section 5).
4. Enable the scheduler: `bench --site <site> enable-scheduler`, and confirm with `bench doctor`.
5. Run **Sync Now** once and check that a GA4 Sync Log record shows *Success*.

**Upgrading.** Pull the new code, run `bench --site <site> migrate`, run `bench build --app erpnext_marketing_analytics` if anything under `public/` changed, then `bench restart`.

**Backfilling history.** *Sync Now* uses *Lookback Days* as its window, up to 365. To load older data, raise *Lookback Days* temporarily (for example to 90), press **Sync Now**, then set it back to 7.

## 14. Operations and troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Migrate prints *Orphaned DocType(s) found: GA4 ...* and deletes them | Frappe could not load those DocTypes: their folder or JSON is missing from the code that is checked out (wrong branch, uncommitted files), the module path does not match, or a controller class name or import is wrong | Deleting a DocType drops its table, so stored GA4 data is lost. Verify `marketing_analytics/doctype/ga4_*/` exists and `modules.txt` says *Marketing Analytics*. The class names must be `GA4Settings`, `GA4DailyAnalytics`, `GA4Breakdown` and `GA4SyncLog`. Restore the files and run migrate again to recreate the empty tables, then restore from the backup or re-run **Sync Now**. Settings must be re-entered |
| *GA4 integration is disabled* | *Enabled* is unticked | Tick it in GA4 Settings |
| *GA4 Property ID must be numeric* | A `G-...` measurement ID was entered | Use the numeric property ID from GA4 Admin, Property details |
| *Missing ga4\_credentials\_file in site\_config.json*, or *credentials file does not exist* | Site config not set, or a wrong path | `bench --site <site> set-config ga4_credentials_file /absolute/path.json`, and check the file is readable by the bench user |
| Google returns a permission error (403) | The service account is not a Viewer on that property, the Data API is not enabled in the project, or the property ID is wrong | Add the service-account email in GA4 *Property access management*, enable the API, and recheck the ID |
| Sync fails with *Timeout while contacting DNS servers* (503) | The server cannot resolve `analyticsdata.googleapis.com` through gRPC | Check `getent hosts analyticsdata.googleapis.com`. If the OS resolves it but gRPC does not, set `GRPC_DNS_RESOLVER=native` for the web and worker processes. On WSL, restart WSL |
| A snapshot card shows *property must be in the form `properties/1234`* | A bare property ID reached the Data API | `snapshot.py` must add the `properties/` prefix, as its wrapper does. `ga4._client_and_property` returns the bare ID |
| Sync fails with a character-length error on `Landing Page` | An old copy where `landing_page` was a Data field | It is Small Text now. If the error names *Campaign* or *Source / Medium*, see known issue 4 |
| Browser console shows **417 EXPECTATION FAILED** | Frappe uses 417 for validation errors | Read the response message, and check the Error Log |
| *Unknown column `end_time`* on the dashboard | An old version sorted the Sync Log by a field that does not exist | The field is `ended_at`. Update the code |
| Dashboard is empty | No sync has run, the Period is too short, or only today has data | Run **Sync Now**, check GA4 Sync Log, and remember the stored section ends yesterday |
| Stored cards work but snapshot cards show errors | The two use separate code paths | Open Error Log and look for entries titled *GA4 snapshot: \<widget>* |
| Numbers differ from GA4's screen | Thresholding, 28-day versus 30-day users, summed user-days, a different date window | See sections 7.5 and 9, and known issue 8 |
| The scheduled sync did not run | Scheduler disabled, no worker, or the job failed | `bench doctor`, then look for a Sync Log with trigger *Scheduler* and an Error Log entry *GA4 scheduled sync failed* |
| A Sync Log is stuck on *Running* | The process was killed (timeout or restart) after the log was created | Safe to ignore. Run **Sync Now** again |

**Console snippets** (`bench --site <site> console`)

```python
# Last five sync attempts
frappe.get_all("GA4 Sync Log",
    fields=["status", "triggered_by", "start_date", "end_date", "rows_processed", "message", "ended_at"],
    order_by="started_at desc", limit=5)

# Is the configuration valid? Raises a readable error if not
from erpnext_marketing_analytics.ga4 import _client_and_property
client, property_id = _client_and_property()
property_id

# Table sizes
frappe.db.count("GA4 Daily Analytics"), frappe.db.count("GA4 Breakdown")
```

## 15. Developer guide

**Add a stored metric.** Append the `Metric(...)` to `METRICS` in `ga4.py`, add its key to `_metric_values`, and add a Float field to **both** GA4 Daily Analytics and GA4 Breakdown. The position in `METRICS` must match the index in `_metric_values`, because values are read by position. The existing test guards this, so extend it too.

**Add a breakdown type.** Add the option to `dimension_type`, add a *(dimension, label)* pair to the loop in `sync_range`, map the value to its field in `_upsert_breakdown`, and add the type to the loop and to the `definitions` list in `get_dashboard_data` and the page JS.

**Add a snapshot card.** Write a function `_my_widget(client, prop, days)` in `snapshot.py` and register it in `WIDGETS`. In `marketing_snapshot.js`, add an entry to `CARDS` and a `render_<key>($body, data)` method. The caching, retries and error cards come for free.

**Clean landing-page query strings** (known issue 3). Aggregate by the cleaned value before upserting, because many rows collapse into one and the last row would otherwise win:

```python
from urllib.parse import urlsplit, parse_qsl, urlencode

TRACKING = {"fbclid", "gclid", "msclkid", "dclid", "gbraid", "wbraid", "_ga", "_gl", "mc_cid", "mc_eid"}

def clean_landing(url):
    if not url:
        return "(not set)"
    parts = urlsplit(url)
    qs = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
          if k.lower() not in TRACKING and not k.lower().startswith("utm_")]
    return (parts.path or "/") + ("?" + urlencode(qs) if qs else "")
```

Sessions, page views, events and key events can be summed when rows merge. User counts cannot, because the same person can appear in several of the merged rows.

**Tests.** Run `bench --site <site> run-tests --app erpnext_marketing_analytics`. The only test today, `tests/test_keys.py`, checks the metric order. Useful additions are tests for `_upsert` (insert, then update, no duplicate) and for `sync_range` with a mocked client, including the rollback on failure.

**Conventions.** Log failures with `frappe.log_error(frappe.get_traceback(), "<clear title>")`, keep every GA4 call behind `_client_and_property()`, and never commit between the Sync Log insert and the final success, which keeps runs all-or-nothing.

# Part 2: User manual

## 1. What this app does for you

Your website's **Google Analytics 4** numbers now appear inside ERPNext. One page shows how much traffic you got, where it came from, which pages and campaigns brought people in, and a live snapshot that looks like the home screen of Google Analytics. Daily numbers refresh by themselves every night, and you can refresh them on demand.

You do not need to open Google Analytics for the everyday questions. The connection is read-only, so nothing you do in ERPNext changes anything in Google.

## 2. Who can do what

| Task | Who |
| --- | --- |
| Open the dashboard, press **Sync Now**, read the sync history | System Manager, Marketing Analytics Manager |
| Change GA4 Settings | System Manager, Marketing Analytics Manager |
| Delete analytics records | System Manager only |

If you cannot see the dashboard, ask your administrator to give you the **Marketing Analytics Manager** role.

## 3. One-time setup (administrator)

Do this once. Some steps need whoever looks after your server, and they are marked.

1. **Create or select a Google Cloud project.** Open [Google Cloud Console](https://console.cloud.google.com/). Select an existing project or create one, for example `erpnext-marketing-analytics`.

2. **Enable the Google Analytics Data API.** Open [Google Analytics Data API](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com) and click **Enable**. This API retrieves GA4 reporting data.

3. **Create a service account.** Go to [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts), create a service account such as `erpnext-ga4-reader`, and generate a **JSON key** if your organization's security policy permits it.

4. **Grant access to your GA4 property.** Open [Google Analytics](https://analytics.google.com/) and navigate to:
   `Admin → Property access management → + → Add users`

5. **Add the service account's email address.** Grant it the **Viewer** role. This is separate from enabling the API in Google Cloud.

6. **Find your GA4 Property ID.** Navigate to `Admin → Property details` and copy the numeric Property ID. For example, `123456789`.

   > **Important:** Do not use the Measurement ID that starts with `G-`. The Data API requires the numeric Property ID.

7. **Configure the credentials file (server administrator).** Place the JSON file somewhere only the server's bench user can read it, and set the site's `ga4_credentials_file` setting to its full path. Never email the file or put it in a shared folder.

8. **Configure GA4 Settings in ERPNext.** Open **GA4 Settings**, enter the **GA4 Property ID**, and tick **Enabled**. Leave **Lookback Days** at `7` and click **Save**.

9. **Test the connection.** Click **Sync Now** and confirm. You will be taken to **GA4 Sync Log**. A record with the status **Success** means the connection works.

10. **Open the Marketing Analytics Dashboard.** Search for **Marketing Analytics Dashboard** using the ERPNext search bar.

**Loading older history.** Sync Now only covers the last *Lookback Days*. To bring in more, set Lookback Days to a bigger number (up to 365), press **Sync Now**, then set it back to 7. The nightly job does the daily top-up from then on.

## 4. Using the dashboard

Open it by typing **Marketing Analytics Dashboard** in the search bar.

- **Period** (top left) chooses 7, 30 or 90 days. Everything on the page follows it.
- **Sync Now** fetches the latest numbers from Google, which can take from a few seconds to a minute while the screen is frozen, and then reloads the page.
- **Refresh** reloads the page. For the live snapshot it forces fresh data from Google. It does not fetch new daily data.
- The line at the top, **Last successful sync**, tells you how fresh the daily numbers are.

The page has two sections. The **daily numbers** come first (KPI cards, trend and top tables). Below them is the **live snapshot**, which looks like the home screen of Google Analytics. The two cover slightly different date ranges: the daily numbers end **yesterday**, while the live snapshot includes **today**.

## 5. Reading the daily numbers

**The six cards**

| Card | Meaning |
| --- | --- |
| Active User-Days\* | Active users added up day by day |
| Total User-Days\* | Total users added up day by day |
| Sessions | Visits to the site |
| Page Views | Pages viewed |
| Events | Everything Google Analytics recorded, such as clicks, scrolls and page views |
| Conversions / Key Events | Events you marked as *key events* in Google Analytics, such as form submissions |

**Why there is an asterisk.** The two user cards are *user-days*: a visitor who comes on three different days counts three times. They are good for comparing one day with another, but they are **not** the number of different people in the period. For true unique people, use the **Overview** card in the live snapshot.

**Traffic Trend** plots sessions, active users and page views for each day. Hover over the line to see the values.

**The three tables** show the ten biggest items by sessions, with their key events.

- **Top Landing Pages** are the first pages visitors saw. The same page can appear several times with different tracking codes after the `?` in the address, such as `fbclid` from Facebook ads. That is expected for now.
- **Top Traffic Sources** are the source and medium, for example `google / organic` (free search) or `(direct) / (none)` (typed the address or no referrer).
- **Top Campaigns** are the campaign names from your tracked links.

`(not set)` means Google had no value to report for that item.

## 6. Reading the live snapshot

Each card loads on its own. If one shows an error, press its **Retry** link; the others are not affected.

| Card | What it tells you |
| --- | --- |
| **Overview** | Four tabs: *Active users*, *New users*, *Engagement / user* (average time people actively spent) and *Sessions / user* (engaged visits per person). Click a tab to change the chart |
| **Active users in last 30 minutes** | Who is on the site right now, a per-minute chart, and the top countries. It updates every minute |
| **New users by first user channel** | Which channel (Direct, Email, Organic Search, Referral, Organic Social, Paid and so on) first brought new people |
| **Sessions by session channel** | The same channels, counted by visits |
| **User activity over time** | Active users over 28 days, 7 days and 1 day |
| **Event count by event name** | The most frequent events, such as `page_view` and `scroll` |
| **Active users by country** and **by city** | Where your visitors are |
| **Views by page title** | Your most viewed pages |
| **Retention by weekly cohort** | Each row is the people who first visited in that week. *Week 0* is 100%. Later columns show what share came back. Blank cells are weeks that have not happened yet. *All users* is the overall average |

The live cards are saved for ten minutes so the page stays quick. Press **Refresh** to bypass that and get the latest.

## 7. The country report

The wide card near the bottom, **Demographic details: Country**, works like the same report in Google Analytics.

- The **chart** shows the total plus the countries you tick in the first column. Only the ten biggest countries have a tick box, and the top five start ticked.
- The **table** lists up to the 50 biggest countries. Under each number, a figure in brackets is that country's share of the total.
- Use the **search box** to find a country, **Rows per page** to show more, and **Prev** and **Next** to move through the list.
- **Total revenue** is a plain number with no currency sign, and it stays at zero unless you use e-commerce tracking.

## 8. Checking sync history

Search for **GA4 Sync Log**. Every sync, nightly or manual, leaves one record with its status, whether it was *Manual* or *Scheduler*, the dates covered, the rows processed and a message.

- **Success** means the data is up to date for those dates.
- **Failed** means nothing from that run was saved, so the data is unchanged. Open the record and read **Error Details**, then send it to your administrator.
- **Running** for a long time means the run was interrupted. Press **Sync Now** again.

## 9. Glossary

| Term | Plain meaning |
| --- | --- |
| Active users | People who had an engaged visit in the period |
| Total users | All people who visited, engaged or not |
| New users | People visiting for the first time |
| Session | One visit, from arrival until the person leaves or goes idle |
| Engaged session | A visit that lasted long enough, or included a key event, or had several page views |
| Page view | One page being loaded or viewed |
| Event | Any recorded action, such as a click, scroll or form submission |
| Key event | An event you chose to count as important. Formerly called a *conversion* |
| Engagement time | How long the site was actively in front of the person |
| Engagement rate | Share of sessions that were engaged |
| Channel group | A broad bucket for traffic, such as Direct, Email, Organic Search or Paid |
| Source / medium | Where visitors came from (the source) and how (the medium), for example `google / organic` |
| Landing page | The first page a visitor saw |
| Cohort | A group of people who first visited in the same week |
| `(not set)` | Google had no value for this item |

## 10. How fresh the data is, and its limits

- **Daily numbers refresh nightly.** Each night the last seven days are fetched again, because Google keeps adjusting recent days. A day's numbers can change slightly over the following days.
- **Today is not in the daily numbers.** It appears in the live snapshot only.
- **Numbers can differ from Google Analytics' own screens.** Google hides very small counts, the live snapshot uses 28-day rather than 30-day active users, and the user cards are summed user-days.
- **Some Google features are not here:** the *Insights* box, the Google Ads offer, the peer comparison band and the world map.
- **It is read-only.** Nothing here changes anything in Google Analytics.

## 11. When something looks wrong

| What you see | What to do |
| --- | --- |
| The dashboard is empty | Press **Sync Now**, then check **GA4 Sync Log** for a *Success* record |
| **Sync Now** shows an error message | Read it. Messages about the integration being disabled, a property ID that must be numeric, or a missing credentials file mean the setup needs fixing. Send the message to your administrator |
| A Sync Log says **Failed** | Open it and pass the Error Details to your administrator |
| One live card shows an error | Press its **Retry** link. If it keeps failing, tell your administrator |
| Numbers do not match Google Analytics | Compare using section 10. Small differences are normal |
| The same page appears many times in Top Landing Pages | Those are the same page with different tracking codes. A developer can tidy this up |
| **Sync Now** is slow | Wait. A long range can take a minute or more. For loading a year of history, ask your administrator |

## Quick reference

| I want to | Do this |
| --- | --- |
| See traffic over time | **Marketing Analytics Dashboard**, then **Traffic Trend**, with a **Period** |
| Know how many different people visited | The **Overview** card in the live snapshot |
| See who is on the site now | **Active users in last 30 minutes** |
| Get the latest numbers | **Sync Now**, then check the Last successful sync line |
| Compare countries | **Demographic details: Country** |
| Check whether a sync worked | Search **GA4 Sync Log** |
| Load older history (administrator) | Raise **Lookback Days** in GA4 Settings, press **Sync Now**, then set it back to 7 |