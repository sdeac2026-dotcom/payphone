"""Example: create an invoice with the PayPhone Python SDK."""
import os
from payphone import PayPhone

pp = PayPhone(
    base_url=os.environ.get("PAYPHONE_URL", "http://127.0.0.1:8080"),
    public_key=os.environ["PAYPHONE_PK"],
    secret_key=os.environ["PAYPHONE_SK"],
)

invoice = pp.invoices().create(
    amount_usd_cents=2500,
    wallet=os.environ.get("PP_WALLET", "PP" + "0" * 40),
    asset="USDC",
    chain="simnet",
    network="simnet",
    description="Pro plan — monthly",
)

print("invoice id :", invoice["invoice"]["id"])
print("checkout   :", invoice["payment_url"])
print("fee split  :", invoice["fee"]["split"])
