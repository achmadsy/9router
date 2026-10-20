import RunsListClient from "./RunsListClient";

export const metadata = {
  title: "Probe Runs | 9Router",
  description: "Saved probe runs, live progress, and reports",
};

export default function ProbeRunsPage() {
  return <RunsListClient />;
}
