from setuptools import setup, find_packages

setup(
    name="erpnext_marketing_analytics",
    version="0.0.1",
    description="Google Analytics 4 integration for ERPNext",
    author="Rapifuzz",
    packages=find_packages(),
    include_package_data=True,
    zip_safe=False,
    install_requires=["google-analytics-data>=0.18.15,<1.0.0"],
)
