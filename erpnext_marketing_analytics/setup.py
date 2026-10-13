import frappe


def _ensure_role():
    if not frappe.db.exists("Role", "Marketing Analytics Manager"):
        frappe.get_doc({
            "doctype": "Role",
            "role_name": "Marketing Analytics Manager",
            "desk_access": 1,
        }).insert(ignore_permissions=True)


def before_install():
    _ensure_role()


def after_install():
    """Ensure the app role exists."""
    _ensure_role()
