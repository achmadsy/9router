import ApiKeysPageClient from "./ApiKeysPageClient";

export const metadata = {
  title: "API Keys | 9Router",
  description: "Manage 9Router API keys with per-key model and combo access policies",
};

export default function ApiKeysPage() {
  return <ApiKeysPageClient />;
}
