import frappe
from frappe.utils import add_days, getdate, today

from erpnext_marketing_analytics.ga4 import sync_range


def daily_sync():
    """Daily scheduler entry point; re-sync recent days to catch GA4 late arrivals."""
    try:
        settings = frappe.get_single("GA4 Settings")
        if not settings.enabled:
            return
        end = add_days(getdate(today()), -1)
        start = add_days(end, -(int(settings.lookback_days or 7) - 1))
        sync_range(start, end, trigger="Scheduler")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "GA4 scheduled sync failed")
        raise
