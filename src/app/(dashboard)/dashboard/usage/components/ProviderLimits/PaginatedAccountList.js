"use client";

import { useState } from "react";
import Pagination from "@/shared/components/Pagination";

const PAGE_SIZE = 10;

export default function PaginatedAccountList({ connections, children }) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(connections.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = connections.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="mt-1">
      <div className="space-y-px">{visible.map(children)}</div>
      <Pagination
        currentPage={currentPage}
        pageSize={PAGE_SIZE}
        totalItems={connections.length}
        onPageChange={setPage}
        showBoundaryButtons
        className="gap-2 px-0 py-2"
      />
    </div>
  );
}
