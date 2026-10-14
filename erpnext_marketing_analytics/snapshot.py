"""Live GA4 "Reports snapshot" data for the Marketing Analytics page.

Why live + cached instead of summing GA4 Daily Analytics:
active users are NOT additive across days (the same person visits on many days),
so 28-day / 7-day / 1-day active users must come from GA4 itself.

Each card loads through its own call, so one failing report never blanks the page.

Drop this next to api.py and ga4.py:
    erpnext_marketing_analytics/snapshot.py
"""
from datetime import date, datetime, timedelta

import frappe
from google.analytics.data_v1beta.types import (
	Cohort,
	CohortSpec,
	CohortsRange,
	DateRange,
	Dimension,
	Metric,
	OrderBy,
	RunRealtimeReportRequest,
	RunReportRequest,
)
from google.api_core.exceptions import DeadlineExceeded, InvalidArgument, ServiceUnavailable
from google.api_core.retry import Retry

CACHE_TTL = 600  # seconds
REALTIME_TTL = 30

RETRY = Retry(
	predicate=lambda e: isinstance(e, (ServiceUnavailable, DeadlineExceeded)),
	initial=1.0,
	maximum=8.0,
	multiplier=2.0,
	timeout=40.0,
)


# Reuse the credentials logic that already works for the sync.
# If _client_and_property lives in another module, change this import path.
from erpnext_marketing_analytics.ga4 import _client_and_property as _base_client_and_property


def _client_and_property():
	"""GA4 Data API wants "properties/<id>"; the sync helper returns the bare id."""
	client, property_id = _base_client_and_property()
	return client, f"properties/{property_id}"


# ---------------------------------------------------------------- helpers


def _report(client, prop, dims, mets, days, order=None, limit=10000):
	req = RunReportRequest(
		property=prop,
		date_ranges=[DateRange(start_date=f"{days - 1}daysAgo", end_date="today")],
		dimensions=[Dimension(name=d) for d in dims],
		metrics=[Metric(name=m) for m in mets],
		order_bys=order or [],
		limit=limit,
	)
	return client.run_report(req, retry=RETRY, timeout=30)


def _rows(resp):
	return [
		([d.value for d in r.dimension_values], [float(m.value or 0) for m in r.metric_values])
		for r in resp.rows
	]


def _short_date(yyyymmdd):
	return datetime.strptime(yyyymmdd, "%Y%m%d").strftime("%b %d").replace(" 0", " ")


def _by_date():
	return [OrderBy(dimension=OrderBy.DimensionOrderBy(dimension_name="date"))]


# ---------------------------------------------------------------- widgets


def _headline(client, prop, days):
	mets = ["activeUsers", "newUsers", "userEngagementDuration", "engagedSessions"]
	tot = _rows(_report(client, prop, [], mets, days))
	active, new, engaged_time, engaged_sessions = tot[0][1] if tot else (0, 0, 0, 0)

	series = {k: [] for k in ("dates", "active_users", "new_users", "avg_engagement_sec", "sessions_per_user")}
	resp = _report(client, prop, ["date"], mets, days, order=_by_date(), limit=days + 1)
	for (d,), (au, nu, ed, es) in _rows(resp):
		series["dates"].append(_short_date(d))
		series["active_users"].append(au)
		series["new_users"].append(nu)
		series["avg_engagement_sec"].append(round(ed / au, 1) if au else 0)
		series["sessions_per_user"].append(round(es / au, 2) if au else 0)

	return {
		"totals": {
			"active_users": active,
			"new_users": new,
			"avg_engagement_sec": round(engaged_time / active, 1) if active else 0,
			"sessions_per_user": round(engaged_sessions / active, 2) if active else 0,
		},
		"series": series,
	}


def _breakdown(client, prop, dim, metric, days, limit=7):
	resp = _report(
		client, prop, [dim], [metric], days,
		order=[OrderBy(metric=OrderBy.MetricOrderBy(metric_name=metric), desc=True)],
		limit=limit,
	)
	return [{"label": d[0] or "(not set)", "value": m[0]} for d, m in _rows(resp)]


def _channel(dim, fallback, metric):
	"""`...PrimaryChannelGroup` needs a recent API; fall back to the Default grouping."""

	def run(client, prop, days):
		try:
			return _breakdown(client, prop, dim, metric, days)
		except InvalidArgument:
			return _breakdown(client, prop, fallback, metric, days)

	return run


def _activity(client, prop, days):
	# The API only exposes 28-day (not 30-day) rolling active users.
	resp = _report(
		client, prop, ["date"], ["active28DayUsers", "active7DayUsers", "active1DayUsers"],
		days, order=_by_date(), limit=days + 1,
	)
	out = {"dates": [], "d28": [], "d7": [], "d1": []}
	for (d,), (a28, a7, a1) in _rows(resp):
		out["dates"].append(_short_date(d))
		out["d28"].append(a28)
		out["d7"].append(a7)
		out["d1"].append(a1)
	return out


def _cohort(client, prop, days):
	"""Weekly retention by first-session week (Sunday to Saturday), 6 weeks."""
	today = date.today()
	this_sun = today - timedelta(days=(today.weekday() + 1) % 7)
	starts = [this_sun - timedelta(weeks=i) for i in range(5, -1, -1)]

	def label(s):
		e = s + timedelta(days=6)
		f = lambda d: d.strftime("%b %d").replace(" 0", " ")  # noqa: E731
		return f"{f(s)} - {f(e)}"

	cohorts = [
		Cohort(
			name=s.isoformat(),
			dimension="firstSessionDate",
			date_range=DateRange(
				start_date=s.isoformat(), end_date=min(s + timedelta(days=6), today).isoformat()
			),
		)
		for s in starts
	]
	req = RunReportRequest(
		property=prop,
		dimensions=[Dimension(name="cohort"), Dimension(name="cohortNthWeek")],
		metrics=[Metric(name="cohortActiveUsers"), Metric(name="cohortTotalUsers")],
		cohort_spec=CohortSpec(
			cohorts=cohorts,
			cohorts_range=CohortsRange(
				granularity=CohortsRange.Granularity.WEEKLY, start_offset=0, end_offset=5
			),
		),
	)
	resp = client.run_report(req, retry=RETRY, timeout=30)

	active, total = {}, {}
	for (cohort, nth), (au, tu) in _rows(resp):
		active[(cohort, int(nth))] = au
		total[cohort] = tu

	rows, sum_active, sum_total = [], [0.0] * 6, [0.0] * 6
	for s in starts:
		key, tot = s.isoformat(), total.get(s.isoformat(), 0)
		retention = []
		for w in range(6):
			if s + timedelta(weeks=w) > today or not tot:
				retention.append(None)  # week hasn't happened yet
				continue
			a = active.get((key, w), 0)
			retention.append(round(a / tot * 100, 1))
			sum_active[w] += a
			sum_total[w] += tot
		rows.append({"label": label(s), "total": tot, "retention": retention})

	overall = [round(sum_active[w] / sum_total[w] * 100, 1) if sum_total[w] else None for w in range(6)]
	return {"overall": overall, "rows": rows}


def _realtime(client, prop, days):
	def rt(dims, mets):
		req = RunRealtimeReportRequest(
			property=prop,
			dimensions=[Dimension(name=d) for d in dims],
			metrics=[Metric(name=m) for m in mets],
		)
		return _rows(client.run_realtime_report(req, retry=RETRY, timeout=20))

	total = rt([], ["activeUsers"])
	countries = rt(["country"], ["activeUsers"])
	minutes = {int(d[0]): m[0] for d, m in rt(["minutesAgo"], ["activeUsers"])}

	return {
		"total": total[0][1][0] if total else 0,
		"per_minute": [minutes.get(i, 0) for i in range(29, -1, -1)],  # oldest first
		"countries": sorted(
			({"label": d[0] or "(not set)", "value": m[0]} for d, m in countries),
			key=lambda r: -r["value"],
		)[:5],
	}


_CD_METRICS = [
	"activeUsers", "newUsers", "engagedSessions", "engagementRate", "userEngagementDuration",
	"eventCount", "keyEvents", "userKeyEventRate", "totalRevenue",
]
_CD_ADDITIVE = ("active_users", "new_users", "engaged_sessions", "event_count", "key_events")


def _cd_shape(v):
	au, nu, es, er, dur, ec, ke, ukr, rev = v
	return {
		"active_users": au,
		"new_users": nu,
		"engaged_sessions": es,
		"engagement_rate": round(er * 100, 2),
		"sessions_per_user": round(es / au, 2) if au else 0,
		"avg_engagement_sec": round(dur / au, 1) if au else 0,
		"event_count": ec,
		"key_events": ke,
		"user_key_event_rate": round(ukr * 100, 2),
		"revenue": rev,
	}


def _country_details(client, prop, days):
	"""Table of countries (top 50) plus per-day active users for the top 10."""
	tot = _rows(_report(client, prop, [], _CD_METRICS, days))
	total = _cd_shape(tot[0][1] if tot else [0] * 9)

	resp = _report(
		client, prop, ["country"], _CD_METRICS, days,
		order=[OrderBy(metric=OrderBy.MetricOrderBy(metric_name="activeUsers"), desc=True)],
		limit=50,
	)
	rows = []
	for (country,), vals in _rows(resp):
		r = _cd_shape(vals)
		r["label"] = country or "(not set)"
		r["pct"] = {k: round(r[k] / total[k] * 100, 2) if total[k] else 0 for k in _CD_ADDITIVE}
		rows.append(r)

	top = [r["label"] for r in rows[:10]]
	dates, total_series = [], []
	for (d,), (au,) in _rows(
		_report(client, prop, ["date"], ["activeUsers"], days, order=_by_date(), limit=days + 1)
	):
		dates.append(d)
		total_series.append(au)

	lookup = {}
	for (d, c), (au,) in _rows(
		_report(client, prop, ["date", "country"], ["activeUsers"], days, limit=100000)
	):
		lookup[(d, c or "(not set)")] = au

	return {
		"total": total,
		"rows": rows,
		"series": {
			"dates": [_short_date(d) for d in dates],
			"total": total_series,
			"countries": {c: [lookup.get((d, c), 0) for d in dates] for c in top},
		},
	}


WIDGETS = {
	"headline": _headline,
	"realtime": _realtime,
	"new_users_channel": _channel("firstUserPrimaryChannelGroup", "firstUserDefaultChannelGroup", "newUsers"),
	"sessions_channel": _channel("sessionPrimaryChannelGroup", "sessionDefaultChannelGroup", "sessions"),
	"countries": lambda c, p, d: _breakdown(c, p, "country", "activeUsers", d, limit=8),
	"cities": lambda c, p, d: _breakdown(c, p, "city", "activeUsers", d, limit=7),
	"events": lambda c, p, d: _breakdown(c, p, "eventName", "eventCount", d, limit=7),
	"country_details": _country_details,
	"activity": _activity,
	"cohort": _cohort,
	"pages": lambda c, p, d: _breakdown(c, p, "unifiedScreenName", "screenPageViews", d, limit=7),
}


# ---------------------------------------------------------------- endpoint


@frappe.whitelist()
def get_widget(widget, days=28, force=0):
	frappe.has_permission("GA4 Settings", "read", throw=True)
	if widget not in WIDGETS:
		frappe.throw(f"Unknown widget: {widget}")

	days = max(1, min(int(days), 365))
	key = f"ma_snapshot:{widget}:{days}"
	cache = frappe.cache()

	if not int(force):
		hit = cache.get_value(key)
		if hit is not None:
			return {"data": hit}

	try:
		client, prop = _client_and_property()
		data = WIDGETS[widget](client, prop, days)
	except (ServiceUnavailable, DeadlineExceeded):
		return {"error": "Couldn't reach the Google Analytics API. Check the server's network and DNS, then retry."}
	except Exception as e:
		frappe.log_error(title=f"GA4 snapshot: {widget}")
		return {"error": str(e)[:300]}

	cache.set_value(key, data, expires_in_sec=REALTIME_TTL if widget == "realtime" else CACHE_TTL)
	return {"data": data}