"""Example: receive and verify PayPhone webhooks with Flask."""
import os
from flask import Flask, request

from payphone import PayPhone

app = Flask(__name__)
WEBHOOK_SECRET = os.environ["PAYPHONE_WEBHOOK_SECRET"]


@app.post("/payphone/webhook")
def hook():
    result = PayPhone.verify_webhook(request.get_data(), dict(request.headers), WEBHOOK_SECRET)
    if not result["valid"]:
        return "", 400

    event = result["event"]
    if event["type"] == "invoice.paid":
        fulfill_order(event["data"]["invoice_id"])
    elif event["type"] == "invoice.underpaid":
        notify_ops(event["data"])
    return "", 200


def fulfill_order(invoice_id: str) -> None:
    print("fulfilling order for", invoice_id)


def notify_ops(data: dict) -> None:
    print("underpaid:", data)


if __name__ == "__main__":
    app.run(port=3001)
