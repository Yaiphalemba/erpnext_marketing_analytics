# ERPNext Marketing Analytics — GA4 (Frappe/ERPNext v15)

Standalone custom app for daily GA4 reporting. It stores daily summary metrics plus daily landing-page, session-source/medium, and campaign breakdowns. Includes a manual sync endpoint and a Desk dashboard page.

## Requirements
- Frappe / ERPNext v15
- Python package `google-analytics-data`
- GA4 Data API enabled in the Google Cloud project used by the service account
- The service account email granted **Viewer** access on the target GA4 property

## Install
From your bench directory:

```bash
bench get-app /path/to/erpnext_marketing_analytics
bench --site your-site install-app erpnext_marketing_analytics
```

If installing from a copied source directory, put it under `apps/erpnext_marketing_analytics` and run `bench setup requirements` first.

The app's `requirements.txt` declares the GA client library. Then run:

```bash
bench --site your-site migrate
bench --site your-site clear-cache
bench restart
```

Ensure scheduler is enabled:

```bash
bench --site your-site enable-scheduler
bench doctor
```

## Configure credentials securely
1. Place the Google service-account JSON file on the server, readable only by the bench user. Do not upload it to a public folder or commit it to Git.
2. Add the following keys to the site's `sites/your-site/site_config.json` (or use `bench set-config`):

```bash
bench --site your-site set-config ga4_credentials_file /absolute/secure/path/ga4-service-account.json
```

3. In Desk, open **GA4 Settings** and set:
   - Enabled = checked
   - GA4 Property ID = the numeric property ID, not the `G-...` measurement ID
   - Lookback Days = `7` (recommended; allows recent data to settle)
4. Ensure the service-account email inside the JSON has Viewer access on that exact GA4 property's **Property access management** page.

## Run and verify
- Open **GA4 Settings** and click **Sync Now** (or run in bench console: `frappe.call` is not available there; use `frappe.get_attr('erpnext_marketing_analytics.api.sync_now')()` after setting the current user to Administrator).
- Open **Marketing Analytics Dashboard** from the Desk search.
- View sync history in **GA4 Sync Log**.
- Scheduler runs daily using Frappe's `daily_long` scheduler event.

## Data model
- **GA4 Daily Analytics**: one record per date; metrics are active users, total users, sessions, page views, events, and conversions/key events.
- **GA4 Breakdown**: records by date and type: Landing Page, Traffic Source, Campaign. Record key is deterministic to prevent duplicates.
- **GA4 Sync Log**: start/end, status, date range, rows processed, and error details.
- **GA4 Settings**: property ID, enabled switch, and lookback window.

## Metric notes
- GA4 API `activeUsers`, `totalUsers`, `sessions`, `screenPageViews`, and `eventCount` are stored directly.
- The `conversions` field is populated from GA4's `keyEvents` metric. In current GA4 reporting, key events are the successor to the former conversions terminology. Mark the events you want counted as key events in GA4 Admin.
- GA4 reporting can apply thresholding, sampling, (not set) values, and data freshness delays. The integration stores what the API returns; it does not reconstruct missing GA4 data. Dashboard user KPI cards sum daily user counts (user-days) and are not deduplicated unique-user totals across the whole period; daily trend values remain useful for day-by-day comparison.
- The job re-syncs the most recent N days (default 7) to accommodate late-arriving data. Increase Lookback Days if needed.

## Security / operational notes
- Whitelisted endpoints check Desk permissions for GA4 Settings.
- Service account JSON is referenced by an absolute filesystem path in site config; the secret itself is not stored in a DocType.
- Sync errors are recorded in GA4 Sync Log. The job does not silently report success on failure.
- For production, back up the site before install and test on UAT first.
