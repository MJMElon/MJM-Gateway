"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EllipsisVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ModuleIcon } from "@/components/module-icon";
import { cn } from "@/components/ui";
import type { CardSize, HomeModule } from "@/lib/types";

// 卡片在格线中所占宽度：大 = 2 格、小 = 1 格、列表 = 整行
export const sizeSpan: Record<CardSize, string> = {
  large: "col-span-2",
  small: "col-span-1",
  list: "col-span-full",
};

export function ModuleCardView({
  module,
  size,
  onOpen,
  menu,
  dragging,
}: {
  module: HomeModule;
  size: CardSize;
  onOpen?: () => void;
  menu?: ReactNode;
  dragging?: boolean;
}) {
  const t = useTranslations("home");
  const base =
    "group relative h-full w-full select-none rounded-xl border border-slate-200 bg-white text-left transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900";
  const newBadge = module.is_new && (
    <span className="rounded bg-rose-500 px-1 text-[10px] font-bold leading-4 text-white">{t("new")}</span>
  );

  if (size === "list") {
    return (
      <div className={cn(base, "flex items-center gap-3 px-3 py-2.5", dragging && "shadow-lg ring-2 ring-brand-500")}>
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">
            <ModuleIcon name={module.icon} className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <span className="truncate">{module.name}</span>
              {newBadge}
            </span>
            {module.description && <span className="block truncate text-xs text-slate-500">{module.description}</span>}
          </span>
        </button>
        {menu}
      </div>
    );
  }

  const large = size === "large";
  return (
    <div className={cn(base, large ? "p-4" : "p-3", dragging && "shadow-lg ring-2 ring-brand-500")}>
      <button
        type="button"
        onClick={onOpen}
        className={cn("flex h-full w-full text-left", large ? "items-start gap-3" : "flex-col items-center gap-2 text-center")}
      >
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100",
            large ? "size-11" : "size-10",
          )}
        >
          <ModuleIcon name={module.icon} className={large ? "size-6" : "size-5"} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("flex items-center gap-1.5 font-medium", large ? "text-sm" : "justify-center text-xs")}>
            <span className={large ? "truncate" : "line-clamp-2"}>{module.name}</span>
            {newBadge}
          </span>
          {large && module.description && (
            <span className="mt-0.5 block truncate text-xs text-slate-500">{module.description}</span>
          )}
        </span>
      </button>
      {menu && <div className="absolute top-1.5 right-1.5">{menu}</div>}
    </div>
  );
}

export function SortableModuleCard({
  id,
  module,
  size,
  onOpen,
  menu,
  disabled,
}: {
  id: string;
  module: HomeModule;
  size: CardSize;
  onOpen?: () => void;
  menu?: ReactNode;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(sizeSpan[size], "touch-drag", isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <ModuleCardView module={module} size={size} onOpen={onOpen} menu={menu} />
    </div>
  );
}

export function CardMenuButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded-md p-1 text-slate-400 opacity-100 hover:bg-slate-100 hover:text-slate-700 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-slate-800"
    >
      <EllipsisVertical className="size-4" />
    </button>
  );
}
