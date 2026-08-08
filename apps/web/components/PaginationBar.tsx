"use client";

interface PaginationBarProps {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  className?: string;
  /** Optional total item count for status text */
  totalItems?: number;
}

export function pageCount(totalItems: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, totalItems) / pageSize));
}

export function slicePage<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (Math.max(1, page) - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export default function PaginationBar({
  page,
  totalPages,
  onChange,
  className,
  totalItems,
}: PaginationBarProps) {
  if (totalPages <= 1) return null;

  return (
    <nav
      className={`pager${className ? ` ${className}` : ""}`}
      aria-label="Phân trang"
    >
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Trước
      </button>
      <span className="pager-status">
        {page} / {totalPages}
        {typeof totalItems === "number" ? ` · ${totalItems}` : ""}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        Sau
      </button>
    </nav>
  );
}
