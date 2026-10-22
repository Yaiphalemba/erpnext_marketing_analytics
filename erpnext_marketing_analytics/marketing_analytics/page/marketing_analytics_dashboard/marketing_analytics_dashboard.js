frappe.pages["marketing-analytics-dashboard"].on_page_load = function (wrapper) {
    if (!document.getElementById("ga4-dashboard-css")) {
        const link = document.createElement("link"); link.id = "ga4-dashboard-css"; link.rel = "stylesheet"; link.href = "/assets/erpnext_marketing_analytics/css/marketing_analytics_dashboard.css"; document.head.appendChild(link);
    }
    const page = frappe.ui.make_app_page({parent: wrapper, title: __("Marketing Analytics"), single_column: true});

    let snapshot = null;  // created after the Period field exists

    function get_days() {
        const period = page.fields_dict.period ? page.fields_dict.period.get_value() : "30 Days";
        return parseInt((period || "30 Days").split(" ")[0], 10) || 30;
    }

    // One refresh path for everything on the page.
    // force=true bypasses the 10-minute GA4 cache (Sync Now / Refresh);
    // changing the period just reloads with cached data where available.
    function refresh_all(force) {
        load_data();
        if (snapshot) force ? snapshot.refresh(1) : snapshot.set_days(get_days());
    }

    // ---- toolbar: Sync Now + Refresh + Period, all driving the same state
    page.set_primary_action(__("Sync Now"), () => {
        frappe.call({
            method: "erpnext_marketing_analytics.api.sync_now",
            freeze: true,
            freeze_message: __("Synchronizing GA4 data..."),
            callback(r) { if (!r.exc) refresh_all(true); }
        });
    }, "refresh-cw");
    page.set_secondary_action(__("Refresh"), () => refresh_all(true), "refresh");
    page.add_field({
        fieldtype: "Select", label: __("Period"), fieldname: "period", options: "7 Days\n30 Days\n90 Days", default: "30 Days",
        change() { if (snapshot) refresh_all(false); }
    });

    // ---- layout: last-sync stamp, totals/trend/breakdowns, snapshot
    const $sync = $('<div class="text-muted small ga4-last-sync"></div>').css("margin", "12px 0 24px").appendTo(page.main);
    const $body = $('<div class="ga4-legacy"></div>').css("margin-top", "16px").appendTo(page.main);
    const $snap = $('<div class="ma-snapshot-wrap"></div>').appendTo(page.main);

    snapshot = new erpnext_marketing_analytics.Snapshot($snap[0], {days: get_days()});

    $body.html(`<div class="ga4-dashboard">
      <div class="ga4-cards"></div>
      <div class="row"><div class="col-md-12"><div class="ga4-panel"><h4>${__("Traffic Trend")}</h4><div class="ga4-trend-chart"></div></div></div></div>
      <div class="row ga4-breakdowns"></div>
    </div>`);

    function fmt(value) { return Number(value || 0).toLocaleString(undefined, {maximumFractionDigits: 0}); }
    function load_data() {
        const days = get_days();
        frappe.call({
            method: "erpnext_marketing_analytics.api.get_dashboard_data", args: {days},
            callback(r) {
                if (r.exc || !r.message) return;
                const d = r.message, t = d.totals;
                const cards = [
                    [__("Active User-Days*"), t.active_users], [__("Total User-Days*"), t.total_users],
                    [__("Sessions"), t.sessions], [__("Page Views"), t.page_views],
                    [__("Events"), t.event_count], [__("Conversions / Key Events"), t.conversions]
                ];
                $body.find(".ga4-cards").html(`<div class="row">${cards.map(c => `<div class="col-md-2 col-sm-4 col-xs-6"><div class="ga4-card"><div class="ga4-label">${frappe.utils.escape_html(c[0])}</div><div class="ga4-value">${fmt(c[1])}</div></div></div>`).join("")}</div>`);
                const trend = d.trend || [];
                if (!$body.find(".ga4-user-note").length) $body.find(".ga4-cards").after(`<div class="text-muted small ga4-user-note">* User counts on the KPI cards are summed daily counts, not deduplicated unique users across the entire selected period. Use daily trend values for day-by-day comparisons.</div>`);
                if (trend.length) {
                    const chart_data = {labels: trend.map(x => x.date), datasets: [
                        {name: __("Sessions"), values: trend.map(x => Number(x.sessions || 0))},
                        {name: __("Active Users"), values: trend.map(x => Number(x.active_users || 0))},
                        {name: __("Page Views"), values: trend.map(x => Number(x.page_views || 0))}
                    ]};
                    $body.find(".ga4-trend-chart").empty();
                    new frappe.Chart($body.find(".ga4-trend-chart")[0], {data: chart_data, type: "line", height: 260, axisOptions: {xAxisMode: "tick", yAxisMode: "tick"}, lineOptions: {regionFill: 1}});
                } else {
                    $body.find(".ga4-trend-chart").html(`<div class="text-muted">${__("No data for this period yet. Run Sync Now after configuring GA4 Settings.")}</div>`);
                }
                const definitions = [["Landing Page", __("Top Landing Pages")], ["Traffic Source", __("Top Traffic Sources")], ["Campaign", __("Top Campaigns")]];
                $body.find(".ga4-breakdowns").html(definitions.map(([key, title]) => {
                    const rows = (d.breakdown[key] || []).map(x => `<tr><td style="overflow-wrap:anywhere">${frappe.utils.escape_html(x.dimension_value || "(not set)")}</td><td class="text-right">${fmt(x.sessions)}</td><td class="text-right">${fmt(x.conversions)}</td></tr>`).join("");
                    return `<div class="col-md-4"><div class="ga4-panel"><h4>${title}</h4><div><table class="table table-bordered table-condensed" style="table-layout:fixed;width:100%;margin-bottom:0"><colgroup><col><col style="width:84px"><col style="width:84px"></colgroup><thead><tr><th>${__("Dimension")}</th><th class="text-right">${__("Sessions")}</th><th class="text-right">${__("Key Events")}</th></tr></thead><tbody>${rows || `<tr><td colspan="3" class="text-muted">${__("No data")}</td></tr>`}</tbody></table></div></div></div>`;
                }).join(""));
                // stamp sits at the very end of the page, under both sections
                $sync.text(d.last_sync ? __("Last successful sync: ") + String(d.last_sync).split(".")[0] : __("No successful sync recorded yet."));
            }
        });
    }
    load_data();
};