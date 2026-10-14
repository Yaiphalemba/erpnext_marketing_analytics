/* Marketing Analytics: GA4 snapshot grid.
 * Place at erpnext_marketing_analytics/public/js/marketing_snapshot.js
 * Mount from your page:  new erpnext_marketing_analytics.Snapshot(page.main, {days: 30});
 * The page drives it via snapshot.set_days(n) and snapshot.refresh().
 */
frappe.provide("erpnext_marketing_analytics");

(function () {
	const API = "erpnext_marketing_analytics.snapshot.get_widget";
	const BLUE = "#2490ef";
	const GREEN = "#5cb85c";
	const PINK = "#e24c8f";
	// stable colour per country in the demographic chart (index 0 is the "Total" line)
	const PALETTE = ["#9ec9f5", BLUE, GREEN, PINK, "#f5a623", "#7b61c9", "#2bb5b5", "#c0504d", "#8a8f98", "#b8a000", "#4c8bf5"];

	const esc = (s) => frappe.utils.escape_html(String(s ?? ""));
	const compact = (n) =>
		new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
	const whole = (n) => new Intl.NumberFormat("en-IN").format(Math.round(n || 0));
	const dec2 = (n) => Number(n || 0).toFixed(2);
	const pct2 = (n) => `${Number(n || 0).toFixed(2)}%`;
	const duration = (sec) => {
		sec = Math.round(sec || 0);
		return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
	};

	const CARDS = [
		{ key: "headline", title: "Overview", span: 5 },
		{ key: "realtime", title: "Active users in last 30 minutes", span: 3 },
		{ key: "new_users_channel", title: "New users by first user channel", span: 4 },
		{ key: "sessions_channel", title: "Sessions by session channel", span: 4 },
		{ key: "activity", title: "User activity over time", span: 4 },
		{ key: "events", title: "Event count by event name", span: 4 },
		{ key: "countries", title: "Active users by country", span: 4 },
		{ key: "cities", title: "Active users by city", span: 4 },
		{ key: "pages", title: "Views by page title", span: 4 },
		{ key: "country_details", title: "Demographic details: Country", span: 12 },
		{ key: "cohort", title: "Retention by weekly cohort", span: 12 },
	];

	// columns of the country table: [key, header, formatter, shows "% of total"]
	const CD_COLS = [
		{ k: "active_users", label: "Active users", f: whole, pct: true },
		{ k: "new_users", label: "New users", f: whole, pct: true },
		{ k: "engaged_sessions", label: "Engaged sessions", f: whole, pct: true },
		{ k: "engagement_rate", label: "Engagement rate", f: pct2 },
		{ k: "sessions_per_user", label: "Engaged sessions per active user", f: dec2 },
		{ k: "avg_engagement_sec", label: "Avg engagement time per active user", f: duration },
		{ k: "event_count", label: "Event count", f: whole, pct: true },
		{ k: "key_events", label: "Key events", f: whole, pct: true },
		{ k: "user_key_event_rate", label: "User key event rate", f: pct2 },
		{ k: "revenue", label: "Total revenue", f: dec2 },
	];

	erpnext_marketing_analytics.Snapshot = class Snapshot {
		constructor(parent, { days = 28 } = {}) {
			this.days = days;
			this.metric = "active_users";
			this.cache = {};
			this.$root = $(`<div class="ma-snap"></div>`).appendTo($(parent));
			this.build();
			this.load_all();
			this.poll = setInterval(() => {
				if (!document.body.contains(this.$root[0])) return clearInterval(this.poll);
				this.load("realtime");
			}, 60000);
		}

		build() {
			this.$root.html(`<div class="ma-grid">${CARDS.map(
				(c) => `<section class="ma-card ma-span-${c.span}" data-card="${c.key}">
					<h3>${esc(c.title)}</h3><div class="ma-body"></div></section>`
			).join("")}</div>`);
		}

		set_days(days) {
			this.days = days;
			this.load_all();
		}

		refresh(force = 1) {
			this.load_all(force);
		}

		load_all(force = 0) {
			CARDS.forEach((c) => this.load(c.key, force));
		}

		load(key, force = 0) {
			const $body = this.$root.find(`[data-card="${key}"] .ma-body`);
			if (!this.cache[key]) $body.html(`<div class="ma-skeleton"></div>`);
			frappe.call({
				method: API,
				args: { widget: key, days: this.days, force },
				silent: true,
				callback: (r) => {
					const res = r.message || {};
					if (res.error) return this.fail($body, key, res.error);
					this.cache[key] = res.data;
					this[`render_${key}`]($body, res.data);
				},
				error: () => this.fail($body, key, "The request failed. Check the error log."),
			});
		}

		fail($body, key, msg) {
			$body.html(`<div class="ma-error"><p>${esc(msg)}</p>
				<a href="#" class="ma-retry">Retry</a></div>`);
			$body.find(".ma-retry").on("click", (e) => {
				e.preventDefault();
				this.load(key, 1);
			});
		}

		// ------------------------------------------------------------ renderers

		render_headline($b, d) {
			const defs = [
				{ k: "active_users", label: "Active users", title: "Active users", value: compact(d.totals.active_users), fmt: whole },
				{ k: "new_users", label: "New users", title: "New users", value: compact(d.totals.new_users), fmt: whole },
				{ k: "avg_engagement_sec", label: "Engagement / user", title: "Average engagement time per active user", value: duration(d.totals.avg_engagement_sec), fmt: duration },
				{ k: "sessions_per_user", label: "Sessions / user", title: "Engaged sessions per active user", value: dec2(d.totals.sessions_per_user), fmt: dec2 },
			];
			$b.html(`
				<div class="ma-stats">${defs
					.map(
						(m) => `<button class="ma-stat ${m.k === this.metric ? "is-on" : ""}" data-metric="${m.k}" title="${esc(m.title)}">
							<span class="ma-stat-label">${esc(m.label)}</span>
							<span class="ma-stat-value">${m.value}</span></button>`
					)
					.join("")}</div>
				<div class="ma-chart"></div>`);

			const draw = () => {
				const def = defs.find((m) => m.k === this.metric);
				new frappe.Chart($b.find(".ma-chart")[0], {
					type: "line",
					height: 200,
					colors: [BLUE],
					data: { labels: d.series.dates, datasets: [{ name: def.title, values: d.series[this.metric] }] },
					lineOptions: { regionFill: 1, hideDots: 1 },
					axisOptions: { xIsSeries: 1 },
					tooltipOptions: { formatTooltipY: def.fmt },
				});
			};
			draw();
			$b.off("click").on("click", "[data-metric]", (e) => {
				this.metric = $(e.currentTarget).data("metric");
				$b.find(".ma-stat").removeClass("is-on");
				$(e.currentTarget).addClass("is-on");
				draw();
			});
		}

		render_realtime($b, d) {
			$b.html(`
				<div class="ma-big">${whole(d.total)}</div>
				<div class="ma-sub">Active users per minute</div>
				<div class="ma-chart ma-mini"></div>
				<div class="ma-sub ma-gap">Top countries</div>
				${d.countries.length ? this.bars(d.countries, whole) : `<p class="ma-empty">No one on the site right now.</p>`}`);
			new frappe.Chart($b.find(".ma-mini")[0], {
				type: "bar",
				height: 70,
				colors: [BLUE],
				data: { labels: d.per_minute.map((_, i) => `${29 - i}m`), datasets: [{ values: d.per_minute }] },
				axisOptions: { xIsSeries: 1, xAxisMode: "span", yAxisMode: "span" },
				barOptions: { spaceRatio: 0.3 },
				tooltipOptions: { formatTooltipX: (x) => `${x} ago` },
			});
		}

		render_bar_card($b, rows, fmt = whole) {
			$b.html(rows.length ? this.bars(rows, fmt) : `<p class="ma-empty">No data for this range.</p>`);
		}
		render_new_users_channel($b, rows) { this.render_bar_card($b, rows); }
		render_sessions_channel($b, rows) { this.render_bar_card($b, rows); }
		render_countries($b, rows) { this.render_bar_card($b, rows); }
		render_cities($b, rows) { this.render_bar_card($b, rows); }
		render_pages($b, rows) { this.render_bar_card($b, rows); }
		render_events($b, rows) { this.render_bar_card($b, rows, compact); }

		render_activity($b, d) {
			const last = (a) => a[a.length - 1] || 0;
			$b.html(`
				<div class="ma-legend">
					<span><i style="background:${BLUE}"></i>28 days <b>${compact(last(d.d28))}</b></span>
					<span><i style="background:${GREEN}"></i>7 days <b>${compact(last(d.d7))}</b></span>
					<span><i style="background:${PINK}"></i>1 day <b>${compact(last(d.d1))}</b></span>
				</div>
				<div class="ma-chart"></div>`);
			new frappe.Chart($b.find(".ma-chart")[0], {
				type: "line",
				height: 200,
				colors: [BLUE, GREEN, PINK],
				data: {
					labels: d.dates,
					datasets: [
						{ name: "28 days", values: d.d28 },
						{ name: "7 days", values: d.d7 },
						{ name: "1 day", values: d.d1 },
					],
				},
				lineOptions: { hideDots: 1 },
				axisOptions: { xIsSeries: 1 },
			});
		}

		render_country_details($b, d) {
			const countries = Object.keys(d.series.countries);
			const st = { page: 0, size: 10, q: "", checked: new Set(countries.slice(0, 5)) };
			const colour = (c) => PALETTE[1 + countries.indexOf(c)];

			$b.html(`
				<div class="ma-sub">Active users by country over time</div>
				<div class="ma-chart ma-cd-chart"></div>
				<div class="ma-cd-tools">
					<input type="search" class="form-control input-sm ma-search" placeholder="Search countries">
					<div class="ma-pager">
						<span>Rows per page</span>
						<select class="form-control input-sm ma-size">
							${[10, 25, 50].map((n) => `<option value="${n}">${n}</option>`).join("")}
						</select>
						<span class="ma-range-label"></span>
						<button class="btn btn-default btn-xs ma-prev">Prev</button>
						<button class="btn btn-default btn-xs ma-next">Next</button>
					</div>
				</div>
				<div class="ma-scroll ma-cd-table"></div>`);

			const draw_chart = () => {
				const picked = countries.filter((c) => st.checked.has(c));
				new frappe.Chart($b.find(".ma-cd-chart")[0], {
					type: "line",
					height: 220,
					colors: [PALETTE[0], ...picked.map(colour)],
					data: {
						labels: d.series.dates,
						datasets: [
							{ name: "Total", values: d.series.total },
							...picked.map((c) => ({ name: c, values: d.series.countries[c] })),
						],
					},
					lineOptions: { hideDots: 1 },
					axisOptions: { xIsSeries: 1 },
				});
			};

			const paint = () => {
				const q = st.q.trim().toLowerCase();
				const rows = d.rows.filter((r) => !q || r.label.toLowerCase().includes(q));
				const pages = Math.max(1, Math.ceil(rows.length / st.size));
				st.page = Math.min(st.page, pages - 1);
				const start = st.page * st.size;
				const slice = rows.slice(start, start + st.size);
				const cell = (c, r) =>
					`<td>${c.f(r[c.k])}${c.pct && r.pct ? `<small>(${pct2(r.pct[c.k])})</small>` : ""}</td>`;

				$b.find(".ma-cd-table").html(`<table class="ma-cd">
					<thead><tr><th class="ma-ck"></th><th class="ma-left">#</th><th class="ma-left">Country</th>
						${CD_COLS.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
					<tbody>
						<tr class="ma-all"><td></td><td></td><td class="ma-left">Total</td>
							${CD_COLS.map((c) => `<td>${c.f(d.total[c.k])}${c.pct ? `<small>100% of total</small>` : ""}</td>`).join("")}</tr>
						${slice
							.map(
								(r, i) => `<tr>
								<td class="ma-ck">${countries.includes(r.label)
									? `<input type="checkbox" data-c="${esc(r.label)}" ${st.checked.has(r.label) ? "checked" : ""}>`
									: ""}</td>
								<td class="ma-left">${start + i + 1}</td>
								<td class="ma-left">${esc(r.label)}</td>
								${CD_COLS.map((c) => cell(c, r)).join("")}</tr>`
							)
							.join("") || `<tr><td colspan="${CD_COLS.length + 3}" class="ma-empty">No matching countries.</td></tr>`}
					</tbody></table>`);

				$b.find(".ma-range-label").text(
					rows.length ? `${start + 1}-${start + slice.length} of ${rows.length}` : "0 of 0"
				);
				$b.find(".ma-prev").prop("disabled", st.page === 0);
				$b.find(".ma-next").prop("disabled", st.page >= pages - 1);
			};

			$b.off(".macd");
			$b.on("input.macd", ".ma-search", (e) => { st.q = e.target.value; st.page = 0; paint(); });
			$b.on("change.macd", ".ma-size", (e) => { st.size = parseInt(e.target.value, 10); st.page = 0; paint(); });
			$b.on("click.macd", ".ma-prev", () => { st.page = Math.max(0, st.page - 1); paint(); });
			$b.on("click.macd", ".ma-next", () => { st.page += 1; paint(); });
			$b.on("change.macd", ".ma-ck input", (e) => {
				const c = e.target.getAttribute("data-c");
				e.target.checked ? st.checked.add(c) : st.checked.delete(c);
				draw_chart();
			});

			draw_chart();
			paint();
		}

		render_cohort($b, d) {
			const cell = (v) => {
				if (v === null || v === undefined) return `<td class="ma-na"></td>`;
				const a = Math.sqrt(Math.min(v, 100) / 100);
				const fg = a > 0.55 ? "#fff" : "var(--text-color)";
				return `<td style="background:rgba(36,144,239,${a.toFixed(2)});color:${fg}">${v}%</td>`;
			};
			const head = [0, 1, 2, 3, 4, 5].map((w) => `<th>Week ${w}</th>`).join("");
			$b.html(`<div class="ma-scroll"><table class="ma-cohort">
				<thead><tr><th></th>${head}</tr></thead>
				<tbody>
					<tr class="ma-all"><th>All users</th>${d.overall.map(cell).join("")}</tr>
					${d.rows
						.map((r) => `<tr><th title="${whole(r.total)} users">${esc(r.label)}</th>${r.retention.map(cell).join("")}</tr>`)
						.join("")}
				</tbody></table></div>`);
		}

		// ------------------------------------------------------------ shared

		bars(rows, fmt) {
			const max = Math.max(...rows.map((r) => r.value), 1);
			return `<div class="ma-bars">${rows
				.map(
					(r) => `<div class="ma-row">
						<span class="ma-label" title="${esc(r.label)}">${esc(r.label)}</span>
						<span class="ma-track"><i style="width:${((r.value / max) * 100).toFixed(1)}%"></i></span>
						<span class="ma-val">${fmt(r.value)}</span></div>`
				)
				.join("")}</div>`;
		}
	};

	// ---------------------------------------------------------------- styles
	if (!document.getElementById("ma-snap-style")) {
		const css = `
		.ma-snap .ma-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px}
		.ma-snap .ma-card{background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--border-radius-md);padding:14px 16px;min-width:0}
		.ma-snap .ma-card h3{font-size:var(--text-md);font-weight:600;margin:0 0 10px;color:var(--text-color)}
		.ma-snap .ma-span-3{grid-column:span 3}.ma-snap .ma-span-4{grid-column:span 4}
		.ma-snap .ma-span-5{grid-column:span 5}.ma-snap .ma-span-6{grid-column:span 6}
		.ma-snap .ma-span-12{grid-column:span 12}
		@media (max-width:1200px){.ma-snap .ma-card{grid-column:span 6}.ma-snap .ma-span-12{grid-column:span 12}}
		@media (max-width:700px){.ma-snap .ma-card{grid-column:span 12}}
		.ma-snap .ma-skeleton{height:120px;border-radius:var(--border-radius);background:var(--control-bg)}
		.ma-snap .ma-error{color:var(--text-muted);font-size:var(--text-sm)}
		.ma-snap .ma-empty{color:var(--text-muted);font-size:var(--text-sm);margin:8px 0 0}
		.ma-snap .ma-stats{display:flex;gap:6px;margin-bottom:6px}
		.ma-snap .ma-stat{flex:1;text-align:left;background:none;border:0;border-bottom:2px solid transparent;padding:4px 6px 6px;cursor:pointer;min-width:0}
		.ma-snap .ma-stat.is-on{border-bottom-color:${BLUE}}
		.ma-snap .ma-stat-label{display:block;color:var(--text-muted);font-size:var(--text-xs);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.ma-snap .ma-stat-value{display:block;font-size:var(--text-2xl);font-weight:600;color:var(--text-color)}
		.ma-snap .ma-big{font-size:2.4rem;font-weight:600;line-height:1.1}
		.ma-snap .ma-sub{color:var(--text-muted);font-size:var(--text-sm)}
		.ma-snap .ma-gap{margin-top:12px;margin-bottom:4px}
		.ma-snap .ma-bars{display:flex;flex-direction:column;gap:7px}
		.ma-snap .ma-row{display:grid;grid-template-columns:minmax(0,38%) 1fr auto;gap:10px;align-items:center;font-size:var(--text-sm)}
		.ma-snap .ma-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.ma-snap .ma-track{height:8px;border-radius:4px;background:var(--control-bg);overflow:hidden}
		.ma-snap .ma-track i{display:block;height:100%;background:${BLUE};border-radius:4px}
		.ma-snap .ma-val{font-variant-numeric:tabular-nums;color:var(--text-muted)}
		.ma-snap .ma-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:var(--text-sm);color:var(--text-muted);margin-bottom:4px}
		.ma-snap .ma-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
		.ma-snap .ma-legend b{color:var(--text-color);margin-left:4px}
		.ma-snap .ma-scroll{overflow-x:auto}
		.ma-snap .ma-cohort{width:100%;border-collapse:separate;border-spacing:2px;font-size:var(--text-sm);text-align:center}
		.ma-snap .ma-cohort th{font-weight:500;color:var(--text-muted);text-align:left;white-space:nowrap;padding:4px 8px 4px 0}
		.ma-snap .ma-cohort thead th{text-align:center}
		.ma-snap .ma-cohort td{padding:6px 4px;border-radius:3px;min-width:52px;font-variant-numeric:tabular-nums}
		.ma-snap .ma-cohort td.ma-na{background:var(--control-bg);opacity:.5}
		.ma-snap .ma-all th{color:var(--text-color)}
		.ma-snap .ma-cd-tools{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:12px 0 8px}
		.ma-snap .ma-search{max-width:240px}
		.ma-snap .ma-pager{display:flex;gap:8px;align-items:center;color:var(--text-muted);font-size:var(--text-sm)}
		.ma-snap .ma-size{width:auto}
		.ma-snap .ma-cd{width:100%;border-collapse:collapse;font-size:var(--text-sm)}
		.ma-snap .ma-cd th{font-weight:500;color:var(--text-muted);text-align:right;padding:8px 10px;border-bottom:1px solid var(--border-color);vertical-align:bottom}
		.ma-snap .ma-cd td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--border-color);font-variant-numeric:tabular-nums;white-space:nowrap}
		.ma-snap .ma-cd .ma-left{text-align:left}
		.ma-snap .ma-cd td small{display:block;color:var(--text-muted);font-size:var(--text-xs)}
		.ma-snap .ma-cd .ma-all td{font-weight:600}
		.ma-snap .ma-ck{width:28px;text-align:center}
		`;
		$(`<style id="ma-snap-style">${css}</style>`).appendTo(document.head);
	}
})();