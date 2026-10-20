import RunDetailClient from "./RunDetailClient";

export const metadata = {
  title: "Probe Run | 9Router",
  description: "Live probe progress, per-check evidence, and saved results",
};

export default async function ProbeRunPage({ params }) {
  const { id } = await params;
  return <RunDetailClient runId={id} />;
}
