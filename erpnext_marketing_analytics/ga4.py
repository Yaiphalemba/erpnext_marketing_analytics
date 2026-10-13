"""GA4 Data API client and idempotent persistence helpers."""
import hashlib
import json
import os
from datetime import date, datetime

import frappe
from frappe import _
from frappe.utils import now_datetime
from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import DateRange, Dimension, Metric, RunReportRequest
from google.oauth2 import service_account

METRICS = [
    Metric(name="activeUsers"),
    Metric(name="totalUsers"),
    Metric(name="sessions"),
    Metric(name="screenPageViews"),
    Metric(name="eventCount"),
    Metric(name="keyEvents"),
]


def _client_and_property():
    settings = frappe.get_single("GA4 Settings")
    if not settings.enabled:
        frappe.throw(_("GA4 integration is disabled."))
    property_id = (settings.property_id or "").strip()
    if not property_id.isdigit():
        frappe.throw(_("GA4 Property ID must be numeric. Do not enter the G- measurement ID."))

    credentials_file = frappe.conf.get("ga4_credentials_file")
    if not credentials_file:
        frappe.throw(_("Missing ga4_credentials_file in site_config.json."))
    if not os.path.isfile(credentials_file):
        frappe.throw(_("GA4 service-account credentials file does not exist at the configured path."))

    credentials = service_account.Credentials.from_service_account_file(
        credentials_file,
        scopes=["https://www.googleapis.com/auth/analytics.readonly"],
    )
    return BetaAnalyticsDataClient(credentials=credentials), property_id


def _run_report(client, property_id, start_date, end_date, dimensions):
    """Read every result page; GA Data API's page size is bounded."""
    output = []
    offset = 0
    limit = 100000
    while True:
        request = RunReportRequest(
            property=f"properties/{property_id}",
            date_ranges=[DateRange(start_date=str(start_date), end_date=str(end_date))],
            dimensions=[Dimension(name=name) for name in dimensions],
            metrics=METRICS,
            limit=limit,
            offset=offset,
        )
        response = client.run_report(request)
        output.extend(response.rows)
        count = len(response.rows)
        offset += count
        if count == 0 or offset >= response.row_count or count < limit:
            break
    return output


def _metric_values(row):
    vals = [float(m.value or 0) for m in row.metric_values]
    # GA4 API metric order follows METRICS above.
    return {
        "active_users": vals[0] if len(vals) > 0 else 0,
        "total_users": vals[1] if len(vals) > 1 else 0,
        "sessions": vals[2] if len(vals) > 2 else 0,
        "page_views": vals[3] if len(vals) > 3 else 0,
        "event_count": vals[4] if len(vals) > 4 else 0,
        "conversions": vals[5] if len(vals) > 5 else 0,
    }


def _parse_ga_date(value):
    return datetime.strptime(value, "%Y%m%d").date()


def _upsert(doctype, record_key, values):
    existing = frappe.db.get_value(doctype, {"record_key": record_key}, "name")
    if existing:
        frappe.db.set_value(doctype, existing, values, update_modified=False)
        return existing
    doc = frappe.get_doc({"doctype": doctype, "record_key": record_key, **values})
    doc.insert(ignore_permissions=True)
    return doc.name


def _upsert_summary(report_row):
    d = _parse_ga_date(report_row.dimension_values[0].value)
    values = _metric_values(report_row)
    values["date"] = d
    _upsert("GA4 Daily Analytics", d.isoformat(), values)


def _upsert_breakdown(report_row, dimension_type, dimension_names):
    # Dimensions are requested as date plus exactly one breakdown dimension.
    d = _parse_ga_date(report_row.dimension_values[0].value)
    dimension_value = report_row.dimension_values[1].value or "(not set)"
    values = _metric_values(report_row)
    values.update({"date": d, "dimension_type": dimension_type, "dimension_value": dimension_value})
    if dimension_type == "Traffic Source":
        values["source_medium"] = dimension_value
    elif dimension_type == "Campaign":
        values["campaign"] = dimension_value
    elif dimension_type == "Landing Page":
        values["landing_page"] = dimension_value
    raw_key = "|".join([d.isoformat(), dimension_type, dimension_value])
    key = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
    values["record_key"] = key
    _upsert("GA4 Breakdown", key, values)


def sync_range(start_date, end_date, trigger="Manual"):
    """Synchronize summaries and breakdowns for an inclusive date range."""
    log = frappe.get_doc({
        "doctype": "GA4 Sync Log", "triggered_by": trigger,
        "start_date": start_date, "end_date": end_date,
        "status": "Running", "started_at": now_datetime(),
        "rows_processed": 0,
    }).insert(ignore_permissions=True)
    frappe.db.commit()
    processed = 0
    try:
        client, property_id = _client_and_property()
        # Summary by date.
        for row in _run_report(client, property_id, start_date, end_date, ["date"]):
            _upsert_summary(row)
            processed += 1
        # Separate report calls keep each dimension's semantics clear.
        for dimension, kind in [
            ("landingPagePlusQueryString", "Landing Page"),
            ("sessionSourceMedium", "Traffic Source"),
            ("sessionCampaignName", "Campaign"),
        ]:
            for row in _run_report(client, property_id, start_date, end_date, ["date", dimension]):
                _upsert_breakdown(row, kind, ["date", dimension])
                processed += 1
        log.status = "Success"
        log.rows_processed = processed
        log.ended_at = now_datetime()
        log.message = f"Synchronized {start_date} through {end_date}."
        log.save(ignore_permissions=True)
        frappe.db.commit()
        return {"status": "Success", "log": log.name, "rows_processed": processed,
                "start_date": str(start_date), "end_date": str(end_date)}
    except Exception as exc:
        frappe.db.rollback()
        # Persist a failure log in a clean transaction.
        log = frappe.get_doc("GA4 Sync Log", log.name)
        log.status = "Failed"
        log.rows_processed = processed
        log.ended_at = now_datetime()
        log.error_details = frappe.get_traceback()[:10000]
        log.message = str(exc)[:1000]
        log.save(ignore_permissions=True)
        frappe.db.commit()
        frappe.log_error(frappe.get_traceback(), "GA4 sync failed")
        raise
