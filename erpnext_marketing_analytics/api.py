import frappe
from frappe import _
from frappe.utils import add_days, getdate, today

from erpnext_marketing_analytics.ga4 import sync_range


def _check_access():
    if not (frappe.has_permission("GA4 Settings", "read") or frappe.session.user == "Administrator"):
        frappe.throw(_("You do not have permission to access Marketing Analytics."), frappe.PermissionError)


@frappe.whitelist()
def sync_now(start_date=None, end_date=None):
    """Manually synchronize a date range. Defaults to the configured lookback window."""
    _check_access()
    settings = frappe.get_single("GA4 Settings")
    if not settings.enabled:
        frappe.throw(_("GA4 integration is disabled in GA4 Settings."))

    end = getdate(end_date) if end_date else add_days(getdate(today()), -1)
    start = getdate(start_date) if start_date else add_days(end, -(int(settings.lookback_days or 7) - 1))
    if start > end:
        frappe.throw(_("Start Date cannot be after End Date."))
    if (end - start).days > 365:
        frappe.throw(_("Please sync a maximum of 366 days at a time."))
    return sync_range(start, end, trigger="Manual")


@frappe.whitelist()
def get_dashboard_data(days=30):
    """Return compact aggregate metrics and trend/breakdown data for the Desk page."""
    _check_access()
    days = max(1, min(int(days or 30), 365))
    end = add_days(getdate(today()), -1)
    start = add_days(end, -(days - 1))

    rows = frappe.get_all(
        "GA4 Daily Analytics",
        filters={"date": ["between", [start, end]]},
        fields=["date", "active_users", "total_users", "sessions", "page_views", "event_count", "conversions"],
        order_by="date asc",
    )
    totals = {key: sum(float(r.get(key) or 0) for r in rows) for key in
              ("active_users", "total_users", "sessions", "page_views", "event_count", "conversions")}

    breakdown = {}
    for kind in ("Landing Page", "Traffic Source", "Campaign"):
        data = frappe.get_all(
            "GA4 Breakdown",
            filters={"date": ["between", [start, end]], "dimension_type": kind},
            fields=["dimension_value", "sessions", "active_users", "page_views", "event_count", "conversions"],
        )
        grouped = {}
        for row in data:
            key = row.dimension_value or "(not set)"
            target = grouped.setdefault(key, {"dimension_value": key, "sessions": 0, "active_users": 0,
                                              "page_views": 0, "event_count": 0, "conversions": 0})
            for metric in ("sessions", "active_users", "page_views", "event_count", "conversions"):
                target[metric] += float(row.get(metric) or 0)
        breakdown[kind] = sorted(grouped.values(), key=lambda x: x["sessions"], reverse=True)[:10]

    return {
        "start_date": str(start), "end_date": str(end), "days": days,
        "totals": totals,
        "trend": [{"date": str(r.date), "active_users": r.active_users, "sessions": r.sessions,
                   "page_views": r.page_views, "conversions": r.conversions} for r in rows],
        "breakdown": breakdown,
        "last_sync": frappe.db.get_value("GA4 Sync Log", {"status": "Success"}, ["ended_at"], order_by="end_time desc"),
    }
