import { PayPhoneApp } from "@/components/payphone/app";

/**
 * PayPhone — single-route application root.
 * All views are hash-routed from here (see components/payphone/app.tsx):
 * landing, merchant dashboard, hosted checkout and developer docs.
 */
export default function Page() {
  return <PayPhoneApp />;
}
