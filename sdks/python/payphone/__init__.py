"""
PayPhone Python SDK — thin client for the PayPhone Engine.

    pip install requests
    from payphone import PayPhone

    pp = PayPhone(
        base_url="http://127.0.0.1:8080",
        public_key="pk_growth_…",
        secret_key="sk_growth_…",
    )

    invoice = pp.invoices.create(
        amount_usd_cents=2500, asset="USDC",
        chain="simnet", network="simnet", wallet="PP…" + "0" * 38,
    )
    print(invoice["payment_url"])
"""

from __future__ import annotations

import hashlib
import hmac
import json as _json
import time
from typing import Any, Dict, Optional

import requests


class PayPhoneError(Exception):
    """Structured engine error: `type`, `message`, `status`."""

    def __init__(self, err_type: str, message: str, status: int):
        super().__init__(message)
        self.type = err_type
        self.message = message
        self.status = status


class PayPhone:
    """Thin, requests-based client implementing the engine's signing protocol."""

    def __init__(self, base_url: str, public_key: str, secret_key: str, timeout: float = 15.0):
        self.base_url = base_url.rstrip("/")
        self.public_key = public_key
        self.secret_key = secret_key
        self.timeout = timeout
        self.session = requests.Session()

    # ------------------------------------------------------------- signing --

    def _signed_headers(self, method: str, path: str, body: Optional[bytes]) -> Dict[str, str]:
        ts = str(int(time.time()))
        body_hash = hashlib.sha256(body or b"").hexdigest()
        canonical = f"{ts}.{method.upper()}.{path}.{body_hash}"
        signature = hmac.new(self.secret_key.encode(), canonical.encode(), hashlib.sha256).hexdigest()
        return {
            "X-PayPhone-Key": self.public_key,
            "X-PayPhone-Timestamp": ts,
            "X-PayPhone-Signature": signature,
        }

    def _request(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Any:
        body = _json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json"}
        headers.update(self._signed_headers(method, path, body))
        resp = self.session.request(method, self.base_url + path, data=body, headers=headers, timeout=self.timeout)
        data = resp.json()
        if resp.status_code >= 400 or "error" in data:
            err = data.get("error", {})
            raise PayPhoneError(err.get("type", "unknown"), err.get("message", f"HTTP {resp.status_code}"), resp.status_code)
        return data.get("data")

    # ------------------------------------------------------------ invoices --

    def invoices(self) -> "Invoices":
        return Invoices(self)

    # ------------------------------------------------------------ identity --

    def resolve_phone(self, phone: str) -> Dict[str, Any]:
        return self._request("POST", "/v1/identity/resolve", {"phone": phone})

    def register_phone(self, phone: str, wallet: str) -> Dict[str, Any]:
        return self._request("POST", "/v1/identity/register", {"phone": phone, "wallet": wallet})

    def create_escrow(self, phone: str, amount_usd_cents: int) -> Dict[str, Any]:
        return self._request("POST", "/v1/identity/escrow", {"phone": phone, "amount_usd_cents": amount_usd_cents})

    def claim_escrow(self, escrow_id: str, phone: str, code: str) -> Dict[str, Any]:
        return self._request("POST", "/v1/identity/claim", {"escrow_id": escrow_id, "phone": phone, "code": code})

    # ------------------------------------------------------- rates & fees --

    def rates(self, assets: str = "BTC,ETH,USDC") -> Dict[str, Any]:
        return self._request("GET", f"/v1/rates?assets={assets}")

    def fee_schedule(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/fees/schedule")

    def fee_quote(self, amount_usd_cents: int, tier: str = "growth") -> Dict[str, Any]:
        return self._request("GET", f"/v1/fees/quote?amount_usd_cents={amount_usd_cents}&tier={tier}")

    # ------------------------------------------------------------- webhooks --

    @staticmethod
    def verify_webhook(raw_body: bytes, headers: Dict[str, str], webhook_secret: str, tolerance_secs: int = 300) -> Dict[str, Any]:
        """Verify a webhook delivery. Returns {valid, event, reason}."""
        ts = str(headers.get("X-PayPhone-Timestamp") or headers.get("x-payphone-timestamp") or "")
        sig = str(headers.get("X-PayPhone-Signature") or headers.get("x-payphone-signature") or "")
        if not ts or not sig:
            return {"valid": False, "event": None, "reason": "missing headers"}
        if abs(int(time.time()) - int(ts)) > tolerance_secs:
            return {"valid": False, "event": None, "reason": "timestamp outside tolerance"}
        expected = hmac.new(webhook_secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
        valid = hmac.compare_digest(expected, sig.strip().lower())
        event = None
        if valid:
            try:
                event = _json.loads(raw_body)
            except Exception:
                event = None
        return {"valid": valid, "event": event, "reason": None if valid else "signature mismatch"}


class Invoices:
    def __init__(self, client: PayPhone):
        self._c = client

    def create(
        self,
        amount_usd_cents: int,
        wallet: str,
        asset: str = "USDC",
        chain: str = "simnet",
        network: str = "simnet",
        token_address: str = "",
        description: str = "",
        ttl_secs: Optional[int] = None,
        webhook_url: str = "",
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "amount_usd_cents": amount_usd_cents,
            "asset": asset,
            "chain": chain,
            "network": network,
            "wallet": wallet,
            "token_address": token_address,
            "description": description,
            "webhook_url": webhook_url,
        }
        if ttl_secs is not None:
            payload["ttl_secs"] = ttl_secs
        return self._c._request("POST", "/v1/invoices", payload)

    def get(self, invoice_id: str, token: str) -> Dict[str, Any]:
        return self._c._request("GET", f"/v1/invoices/{invoice_id}?token={token}")
