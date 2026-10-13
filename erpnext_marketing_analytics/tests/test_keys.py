import unittest
from erpnext_marketing_analytics.ga4 import _metric_values

class TestMetricMapping(unittest.TestCase):
    def test_metric_mapping_uses_api_order(self):
        class V:
            def __init__(self, value): self.value = str(value)
        class R:
            metric_values = [V(1), V(2), V(3), V(4), V(5), V(6)]
        result = _metric_values(R())
        self.assertEqual(result["active_users"], 1)
        self.assertEqual(result["sessions"], 3)
        self.assertEqual(result["page_views"], 4)
        self.assertEqual(result["conversions"], 6)
