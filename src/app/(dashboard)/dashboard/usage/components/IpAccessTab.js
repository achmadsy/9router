"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";

export default function IpAccessTab({ apiKeyId = "" }) {
  const [rows, setRows] = useState([]);
  const [ips, setIps] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0 });
  const [filters, setFilters] = useState({ ip: "", status: "", startDate: "", endDate: "" });
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const changeFilter = (next) => {
    setFilters(next);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const load = useCallback(async (signal) => {
    try {
      const params = new URLSearchParams({ page: String(pagination.page), pageSize: String(pagination.pageSize) });
      if (apiKeyId) params.set("apiKeyId", apiKeyId);
      if (filters.ip) params.set("ip", filters.ip);
      if (filters.status) params.set("status", filters.status);
      if (filters.startDate) params.set("startDate", new Date(filters.startDate).toISOString());
      if (filters.endDate) params.set("endDate", new Date(filters.endDate).toISOString());
      const response = await fetch(`/api/usage/ip-access?${params}`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      setRows(result.rows || []);
      setIps(result.ips || []);
      setError("");
      setPagination((prev) => ({ ...prev, ...result.pagination }));
    } catch (err) {
      if (err.name !== "AbortError") setError("Could not load IP access records");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [apiKeyId, filters, pagination.page, pagination.pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        load(controller.signal);
      }
    });
    return () => controller.abort();
  }, [load]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-text-muted">Inference IP records retained for seven rolling days. Existing usage history remains unchanged. Requests without a valid key appear as No API key.</p>
      <Card padding="md">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-sm text-text-main">IP address
            <input value={filters.ip} onChange={(event) => changeFilter({ ...filters, ip: event.target.value.trim() })} placeholder="Filter IP" className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-text-main" />
          </label>
          <label className="text-sm text-text-main">HTTP status
            <input value={filters.status} onChange={(event) => changeFilter({ ...filters, status: event.target.value })} placeholder="e.g. 200" inputMode="numeric" className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-text-main" />
          </label>
          <label className="text-sm text-text-main">From
            <input type="datetime-local" value={filters.startDate} onChange={(event) => changeFilter({ ...filters, startDate: event.target.value })} className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-text-main" />
          </label>
          <label className="text-sm text-text-main">To
            <input type="datetime-local" value={filters.endDate} onChange={(event) => changeFilter({ ...filters, endDate: event.target.value })} className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-text-main" />
          </label>
          <div className="flex items-end"><Button variant="ghost" onClick={() => changeFilter({ ip: "", status: "", startDate: "", endDate: "" })}>Clear filters</Button></div>
        </div>
      </Card>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Card padding="md">
        <h2 className="mb-3 text-sm font-semibold text-text-main">IPs using {apiKeyId || "all API keys"}</h2>
        {ips.length === 0 ? <p className="text-sm text-text-muted">No IPs recorded yet.</p> : (
          <div className="flex flex-wrap gap-2">
            {ips.map((item) => (
              <button key={item.ip || "unknown"} type="button" onClick={() => changeFilter({ ...filters, ip: item.ip || "" })} className="rounded-lg border border-border px-3 py-2 text-left text-sm text-text-main hover:bg-black/5 dark:hover:bg-white/5">
                <span className="block font-mono">{item.ip || "Unknown"}</span>
                <span className="text-text-muted">{item.requests} requests · Last {new Date(item.lastSeen).toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </Card>
      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[750px] text-sm">
            <thead><tr className="border-b border-border text-left text-text-main"><th className="p-4">Time</th><th className="p-4">IP</th><th className="p-4">API key</th><th className="p-4">Endpoint</th><th className="p-4">Status</th><th className="p-4">Action</th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan="6" className="p-8 text-center text-text-muted">Loading...</td></tr> : rows.length === 0 ? <tr><td colSpan="6" className="p-8 text-center text-text-muted">No inference IP records found</td></tr> : rows.map((row) => (
                <tr key={row.id} className="border-b border-border text-text-main">
                  <td className="whitespace-nowrap p-4">{new Date(row.timestamp).toLocaleString()}</td>
                  <td className="p-4 font-mono">{row.clientIp || "Unknown"}</td>
                  <td className="p-4">{row.apiKeyName}</td>
                  <td className="p-4 font-mono">{row.endpoint}</td>
                  <td className="p-4">{row.status}</td>
                  <td className="p-4"><Button variant="outline" size="sm" onClick={() => setSelected(row)}>Detail</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && pagination.totalItems > 0 && <Pagination currentPage={pagination.page} pageSize={pagination.pageSize} totalItems={pagination.totalItems} onPageChange={(page) => setPagination((prev) => ({ ...prev, page }))} onPageSizeChange={(pageSize) => setPagination((prev) => ({ ...prev, pageSize, page: 1 }))} />}
      </Card>
      <Drawer isOpen={!!selected} onClose={() => setSelected(null)} title="Inference access" width="md">
        {selected && <dl className="grid grid-cols-1 gap-4 text-sm text-text-main sm:grid-cols-2">
          {[["Time", new Date(selected.timestamp).toLocaleString()], ["Client IP", selected.clientIp || "Unknown"], ["API key", selected.apiKeyName], ["Method", selected.method], ["Endpoint", selected.endpoint], ["HTTP status", selected.status]].map(([label, value]) => (
            <div key={label}><dt className="text-text-muted">{label}</dt><dd className="break-all font-mono">{value}</dd></div>
          ))}
        </dl>}
      </Drawer>
    </div>
  );
}
