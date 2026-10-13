frappe.ui.form.on("GA4 Settings", {
    refresh(frm) {
        if (!frm.is_new() && frm.doc.enabled) {
            frm.add_custom_button(__("Sync Now"), () => {
                frappe.confirm(__("Synchronize the configured recent date range from GA4?"), () => {
                    frappe.call({
                        method: "erpnext_marketing_analytics.api.sync_now",
                        freeze: true,
                        freeze_message: __("Synchronizing Google Analytics data..."),
                        callback(r) {
                            if (!r.exc) {
                                frappe.show_alert({message: __("GA4 sync completed."), indicator: "green"});
                                frappe.set_route("List", "GA4 Sync Log");
                            }
                        }
                    });
                });
            });
        }
    }
});
