"use client";

import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  Check, ChevronDown, ChevronRight, Clock, FolderPlus, Info, Library, Megaphone, Pencil, Plus, Search,
  Trash2, TriangleAlert, X, ArrowUp, ArrowDown,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import type { CardSize, Folder, HomeData, HomeModule } from "@/lib/types";
import { ModuleIcon } from "@/components/module-icon";
import { Button, cn, EmptyState, Input, Modal, Select } from "@/components/ui";
import { FOLDER_COLOR_KEYS, folderColor } from "./colors";
import { CardMenuButton, ModuleCardView, SortableModuleCard, sizeSpan } from "./module-card";
import { openModule } from "./open-module";

const ROOT = "root";
const CONTAINER = "container:";
const LIB = "lib:";
type Containers = Record<string, string[]>;

function buildContainers(data: HomeData, fallbackAll: boolean): Containers {
  const containers: Containers = { [ROOT]: [] };
  data.folders.forEach((f) => (containers[f.id] = []));
  if (fallbackAll) {
    containers[ROOT] = data.modules.map((m) => m.id);
    return containers;
  }
  [...data.layout]
    .sort((a, b) => a.sort_order - b.sort_order)
    .forEach((l) => {
      const key = l.folder_id && containers[l.folder_id] ? l.folder_id : ROOT;
      containers[key].push(l.module_id);
    });
  return containers;
}

// 优先命中卡片，其次文件夹/未分类区块；键盘操作时退回最近中心点
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const cards = hits.filter((h) => !String(h.id).startsWith(CONTAINER));
  if (cards.length) return cards;
  if (hits.length) return hits;
  return closestCenter(args);
};

export function HomeBoard({ data, readOnly = false }: { data: HomeData; readOnly?: boolean }) {
  const t = useTranslations("home");
  const supabase = useMemo(() => createClient(), []);
  const moduleMap = useMemo(() => new Map(data.modules.map((m) => [m.id, m])), [data.modules]);
  const previewUninitialized = readOnly && !data.profile.layout_initialized;

  const [containers, setContainers] = useState<Containers>(() => buildContainers(data, previewUninitialized));
  const [sizes, setSizes] = useState<Record<string, CardSize>>(() =>
    Object.fromEntries(data.layout.map((l) => [l.module_id, l.card_size])),
  );
  const [folders, setFolders] = useState<Folder[]>(data.folders);
  const [recent, setRecent] = useState<string[]>(data.recent);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ folder?: Folder } | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<Folder | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dismissed = useDismissedAnnouncements();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // 手机：长按 250ms 开始拖拉，轻点仍然是打开
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onHome = useMemo(() => new Set(Object.values(containers).flat()), [containers]);
  const collapsed = useMemo(() => new Set(folders.filter((f) => f.collapsed).map((f) => f.id)), [folders]);

  const findContainer = useCallback(
    (id: string): string | null => {
      if (id.startsWith(CONTAINER)) return id.slice(CONTAINER.length);
      return Object.keys(containers).find((key) => containers[key].includes(id)) ?? null;
    },
    [containers],
  );

  // ---------------------------------------------------------------- 保存
  const persist = useCallback(
    async (next: Containers, nextSizes: Record<string, CardSize> = sizes) => {
      if (readOnly) return;
      const items = Object.entries(next).flatMap(([key, ids]) =>
        ids.map((id, i) => ({
          module_id: id,
          folder_id: key === ROOT ? null : key,
          sort_order: i + 1,
          card_size: nextSizes[id] ?? "large",
        })),
      );
      const { error } = await supabase.rpc("gw_save_layout", { p_items: items });
      if (error) setToast(t("saveFailed"));
    },
    [readOnly, sizes, supabase, t],
  );

  // ---------------------------------------------------------------- 打开模块
  const handleOpen = useCallback(
    async (module: HomeModule) => {
      if (readOnly) return;
      setRecent((r) => [module.id, ...r.filter((id) => id !== module.id)].slice(0, 5));
      const result = await openModule(module);
      if (!result.ok) setToast(t("openFailed"));
    },
    [readOnly, t],
  );

  // ---------------------------------------------------------------- 拖拉
  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function onDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const id = String(active.id);
    if (id.startsWith(LIB)) return;
    const from = findContainer(id);
    const to = findContainer(String(over.id));
    if (!from || !to || from === to || collapsed.has(to)) return;

    setContainers((prev) => {
      const target = prev[to];
      const overIndex = target.indexOf(String(over.id));
      const index = overIndex >= 0 ? overIndex : target.length;
      return {
        ...prev,
        [from]: prev[from].filter((x) => x !== id),
        [to]: [...target.slice(0, index), id, ...target.slice(index)],
      };
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    if (!over) return;
    const id = String(active.id);
    const overId = String(over.id);
    const to = findContainer(overId);
    if (!to) return;

    // 从模块库拖进首页
    if (id.startsWith(LIB)) {
      const moduleId = id.slice(LIB.length);
      if (onHome.has(moduleId)) return;
      const target = containers[to];
      const overIndex = target.indexOf(overId);
      const index = overIndex >= 0 ? overIndex : target.length;
      const next = { ...containers, [to]: [...target.slice(0, index), moduleId, ...target.slice(index)] };
      setContainers(next);
      persist(next);
      supabase.rpc("gw_mark_seen", { p_modules: [moduleId] });
      return;
    }

    const from = findContainer(id);
    if (!from) return;
    let next = containers;
    if (from !== to) {
      // 拖到收起的文件夹标题上：放到该文件夹最后
      next = { ...containers, [from]: containers[from].filter((x) => x !== id), [to]: [...containers[to], id] };
    } else {
      const oldIndex = containers[to].indexOf(id);
      const newIndex = containers[to].indexOf(overId);
      if (newIndex >= 0 && oldIndex !== newIndex) {
        next = { ...containers, [to]: arrayMove(containers[to], oldIndex, newIndex) };
      }
    }
    setContainers(next);
    persist(next);
  }

  // ---------------------------------------------------------------- 卡片操作
  function setCardSize(moduleId: string, size: CardSize) {
    const nextSizes = { ...sizes, [moduleId]: size };
    setSizes(nextSizes);
    persist(containers, nextSizes);
  }

  function moveToFolder(moduleId: string, folderId: string) {
    const from = findContainer(moduleId);
    if (!from || from === folderId) return;
    const next = {
      ...containers,
      [from]: containers[from].filter((x) => x !== moduleId),
      [folderId]: [...containers[folderId], moduleId],
    };
    setContainers(next);
    persist(next);
  }

  async function addToHome(moduleId: string, folderId: string = ROOT) {
    if (onHome.has(moduleId)) return;
    const next = { ...containers, [folderId]: [...containers[folderId], moduleId] };
    setContainers(next);
    await persist(next);
    supabase.rpc("gw_mark_seen", { p_modules: [moduleId] });
    setToast(t("added"));
  }

  async function removeFromHome(moduleId: string) {
    const from = findContainer(moduleId);
    if (!from) return;
    setContainers({ ...containers, [from]: containers[from].filter((x) => x !== moduleId) });
    setMenuFor(null);
    const { error } = await supabase.from("gw_user_layout").delete().eq("module_id", moduleId).eq("user_id", data.profile.id);
    if (error) setToast(t("saveFailed"));
  }

  // ---------------------------------------------------------------- 文件夹
  async function saveFolder(name: string, color: string, folder?: Folder) {
    if (folder) {
      setFolders((fs) => fs.map((f) => (f.id === folder.id ? { ...f, name, color } : f)));
      await supabase.from("gw_user_folders").update({ name, color }).eq("id", folder.id);
    } else {
      const sortOrder = Math.max(0, ...folders.map((f) => f.sort_order)) + 1;
      const { data: created, error } = await supabase
        .from("gw_user_folders")
        .insert({ user_id: data.profile.id, name, color, sort_order: sortOrder })
        .select("id, name, color, sort_order, collapsed")
        .single();
      if (error || !created) return setToast(t("saveFailed"));
      setFolders((fs) => [...fs, created as Folder]);
      setContainers((c) => ({ ...c, [created.id]: [] }));
    }
    setFolderDialog(null);
  }

  async function toggleFolder(folder: Folder) {
    const value = !folder.collapsed;
    setFolders((fs) => fs.map((f) => (f.id === folder.id ? { ...f, collapsed: value } : f)));
    if (!readOnly) await supabase.from("gw_user_folders").update({ collapsed: value }).eq("id", folder.id);
  }

  async function moveFolder(folder: Folder, direction: -1 | 1) {
    const ordered = [...folders].sort((a, b) => a.sort_order - b.sort_order);
    const index = ordered.findIndex((f) => f.id === folder.id);
    const other = ordered[index + direction];
    if (!other) return;
    const swapped = arrayMove(ordered, index, index + direction).map((f, i) => ({ ...f, sort_order: i + 1 }));
    setFolders(swapped);
    await Promise.all(
      swapped.map((f) => supabase.from("gw_user_folders").update({ sort_order: f.sort_order }).eq("id", f.id)),
    );
  }

  async function confirmDeleteFolder(folder: Folder) {
    // 删除文件夹：里面的模块回到未分类
    const next: Containers = { ...containers, [ROOT]: [...containers[ROOT], ...(containers[folder.id] ?? [])] };
    delete next[folder.id];
    setContainers(next);
    setFolders((fs) => fs.filter((f) => f.id !== folder.id));
    setDeleteFolder(null);
    const { error } = await supabase.from("gw_user_folders").delete().eq("id", folder.id);
    if (error) return setToast(t("saveFailed"));
    persist(next);
  }

  // ---------------------------------------------------------------- 画面
  const announcements = data.announcements.filter((a) => !dismissed.includes(a.id));
  const q = query.trim().toLowerCase();
  const searchResults = q
    ? data.modules.filter((m) =>
        [m.name, m.code, m.description, m.category].some((v) => v?.toLowerCase().includes(q)),
      )
    : [];
  const sortedFolders = [...folders].sort((a, b) => a.sort_order - b.sort_order);
  const activeModule = activeId ? moduleMap.get(activeId.startsWith(LIB) ? activeId.slice(LIB.length) : activeId) : null;
  const newCount = data.modules.filter((m) => m.is_new && !onHome.has(m.id)).length;

  const renderCard = (id: string) => {
    const mod = moduleMap.get(id);
    if (!mod) return null;
    return (
      <SortableModuleCard
        key={id}
        id={id}
        module={mod}
        size={sizes[id] ?? "large"}
        disabled={readOnly}
        onOpen={() => handleOpen(mod)}
        menu={readOnly ? undefined : <CardMenuButton label={t("cardMenu")} onClick={() => setMenuFor(id)} />}
      />
    );
  };

  const board = (
    <div className="space-y-4">
      {sortedFolders.map((folder, i) => (
        <FolderSection
          key={folder.id}
          folder={folder}
          count={containers[folder.id]?.length ?? 0}
          readOnly={readOnly}
          isFirst={i === 0}
          isLast={i === sortedFolders.length - 1}
          onToggle={() => toggleFolder(folder)}
          onEdit={() => setFolderDialog({ folder })}
          onDelete={() => setDeleteFolder(folder)}
          onMove={(d) => moveFolder(folder, d)}
        >
          <SortableContext items={containers[folder.id] ?? []} strategy={rectSortingStrategy}>
            <CardGrid>{(containers[folder.id] ?? []).map(renderCard)}</CardGrid>
          </SortableContext>
          {(containers[folder.id] ?? []).length === 0 && <p className="py-3 text-center text-xs text-slate-400">{t("emptyFolder")}</p>}
        </FolderSection>
      ))}

      <DropZone id={ROOT}>
        {folders.length > 0 && <h3 className="mb-2 text-sm font-medium text-slate-500">{t("uncategorized")}</h3>}
        <SortableContext items={containers[ROOT]} strategy={rectSortingStrategy}>
          <CardGrid>{containers[ROOT].map(renderCard)}</CardGrid>
        </SortableContext>
        {containers[ROOT].length === 0 &&
          (onHome.size === 0 ? (
            <EmptyState>{data.modules.length === 0 ? t("noModules") : t("emptyHome")}</EmptyState>
          ) : (
            !readOnly && (
              <p className="rounded-xl border border-dashed border-slate-300 py-4 text-center text-xs text-slate-400 dark:border-slate-700">
                {t("emptyFolder")}
              </p>
            )
          ))}
      </DropZone>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* 公告条 */}
      {announcements.map((a) => (
        <div
          key={a.id}
          className={cn(
            "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm",
            a.level === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              : "border-brand-100 bg-brand-50 text-brand-700 dark:border-brand-700/40 dark:bg-brand-700/10 dark:text-brand-100",
          )}
        >
          {a.level === "warning" ? <TriangleAlert className="mt-0.5 size-4 shrink-0" /> : <Megaphone className="mt-0.5 size-4 shrink-0" />}
          <p className="flex-1 whitespace-pre-line">{a.message}</p>
          {!readOnly && (
            <button
              aria-label={t("dismiss")}
              className="rounded p-0.5 opacity-60 hover:opacity-100"
              onClick={() => dismissAnnouncement(a.id)}
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      ))}

      {previewUninitialized && (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          <Info className="size-4" /> {t("previewUninitialized")}
        </div>
      )}

      {/* 搜索 + 操作 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="pl-9" type="search" />
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setFolderDialog({})} className="flex-1 sm:flex-none">
              <FolderPlus className="size-4" /> {t("newFolder")}
            </Button>
            <Button variant="secondary" onClick={() => setLibraryOpen(true)} className="relative flex-1 sm:flex-none">
              <Library className="size-4" /> {t("library")}
              {newCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 rounded-full bg-rose-500 px-1.5 text-[10px] font-bold leading-4 text-white">
                  {newCount}
                </span>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* 最近打开 */}
      {!q && recent.length > 0 && (
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-slate-500">
            <Clock className="size-4" /> {t("recent")}
          </h3>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {recent.map((id) => {
              const m = moduleMap.get(id);
              if (!m) return null;
              return (
                <button
                  key={id}
                  onClick={() => handleOpen(m)}
                  className="flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white py-1.5 pr-3 pl-1.5 text-sm hover:border-brand-500 dark:border-slate-800 dark:bg-slate-900"
                >
                  <span className="flex size-6 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">
                    <ModuleIcon name={m.icon} className="size-3.5" />
                  </span>
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {q ? (
        <div>
          <h3 className="mb-2 text-sm font-medium text-slate-500">{t("searchResults", { count: searchResults.length })}</h3>
          {searchResults.length === 0 ? (
            <EmptyState>{t("noResults")}</EmptyState>
          ) : (
            <CardGrid>
              {searchResults.map((m) => (
                <div key={m.id} className={sizeSpan.large}>
                  <ModuleCardView module={m} size="large" onOpen={() => handleOpen(m)} />
                </div>
              ))}
            </CardGrid>
          )}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <div className={cn(libraryOpen && "lg:grid lg:grid-cols-[1fr_20rem] lg:gap-5")}>
            {board}
            {libraryOpen && (
              <LibraryPanel
                modules={data.modules}
                onHome={onHome}
                folders={sortedFolders}
                onAdd={addToHome}
                onClose={() => setLibraryOpen(false)}
              />
            )}
          </div>
          <DragOverlay>
            {activeModule && (
              <div className="w-56 rotate-2 opacity-95">
                <ModuleCardView module={activeModule} size={activeId?.startsWith(LIB) ? "large" : sizes[activeModule.id] ?? "large"} dragging />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {!readOnly && !q && onHome.size > 0 && <p className="text-center text-xs text-slate-400">{t("dragHint")}</p>}

      {/* 卡片选单 */}
      {menuFor && moduleMap.get(menuFor) && (
        <Modal open onClose={() => setMenuFor(null)} title={moduleMap.get(menuFor)!.name}>
          <div className="space-y-5">
            <div>
              <p className="mb-2 text-sm font-medium">{t("cardSize")}</p>
              <div className="grid grid-cols-3 gap-2">
                {(["large", "small", "list"] as CardSize[]).map((s) => (
                  <Button
                    key={s}
                    variant={(sizes[menuFor] ?? "large") === s ? "primary" : "secondary"}
                    onClick={() => setCardSize(menuFor, s)}
                  >
                    {t(`size.${s}`)}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">{t("moveTo")}</p>
              <Select value={findContainer(menuFor) ?? ROOT} onChange={(e) => moveToFolder(menuFor, e.target.value)}>
                <option value={ROOT}>{t("uncategorized")}</option>
                {sortedFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="ghost" className="w-full text-red-600 dark:text-red-400" onClick={() => removeFromHome(menuFor)}>
              <Trash2 className="size-4" /> {t("removeFromHome")}
            </Button>
          </div>
        </Modal>
      )}

      {folderDialog && (
        <FolderDialog folder={folderDialog.folder} onClose={() => setFolderDialog(null)} onSave={saveFolder} />
      )}

      {deleteFolder && (
        <Modal open onClose={() => setDeleteFolder(null)} title={t("deleteFolderTitle")}>
          <p className="mb-5 text-sm text-slate-600 dark:text-slate-300">{t("deleteFolderBody", { name: deleteFolder.name })}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteFolder(null)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" onClick={() => confirmDeleteFolder(deleteFolder)}>
              {t("delete")}
            </Button>
          </div>
        </Modal>
      )}

      {toast && (
        <div className="fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 sm:bottom-6">
          <div className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">{toast}</div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 已关闭的公告（存在浏览器）

const DISMISSED_KEY = "gw_dismissed_announcements";
const DISMISSED_EVENT = "gw-dismissed-change";

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function subscribeDismissed(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(DISMISSED_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(DISMISSED_EVENT, callback);
  };
}

function useDismissedAnnouncements(): string[] {
  const raw = useSyncExternalStore(subscribeDismissed, readDismissed, () => "[]");
  return useMemo(() => {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }, [raw]);
}

function dismissAnnouncement(id: string) {
  try {
    const ids = JSON.parse(readDismissed()) as string[];
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids, id].slice(-50)));
  } catch {
    // localStorage 不可用时无法记住，忽略
  }
  window.dispatchEvent(new Event(DISMISSED_EVENT));
}

// ------------------------------------------------------------------ 子元件

function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{children}</div>;
}

function DropZone({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: CONTAINER + id });
  return (
    <div ref={setNodeRef} className={cn("rounded-xl transition-colors", isOver && "bg-brand-50/60 dark:bg-brand-700/10", className)}>
      {children}
    </div>
  );
}

function FolderSection({
  folder,
  count,
  readOnly,
  isFirst,
  isLast,
  onToggle,
  onEdit,
  onDelete,
  onMove,
  children,
}: {
  folder: Folder;
  count: number;
  readOnly: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  children: ReactNode;
}) {
  const t = useTranslations("home");
  const color = folderColor(folder.color);
  return (
    <DropZone id={folder.id} className={cn("border-l-4 bg-white/60 p-3 dark:bg-slate-900/40", color.bar)}>
      <div className="flex items-center gap-2">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={!folder.collapsed}>
          {folder.collapsed ? <ChevronRight className="size-4 shrink-0" /> : <ChevronDown className="size-4 shrink-0" />}
          <span className={cn("size-2.5 shrink-0 rounded-full", color.dot)} />
          <span className="truncate font-medium">{folder.name}</span>
          <span className="text-xs text-slate-400">{count}</span>
        </button>
        {!readOnly && (
          <div className="flex items-center">
            <IconButton label={t("moveUp")} onClick={() => onMove(-1)} disabled={isFirst}>
              <ArrowUp className="size-4" />
            </IconButton>
            <IconButton label={t("moveDown")} onClick={() => onMove(1)} disabled={isLast}>
              <ArrowDown className="size-4" />
            </IconButton>
            <IconButton label={t("editFolder")} onClick={onEdit}>
              <Pencil className="size-4" />
            </IconButton>
            <IconButton label={t("deleteFolder")} onClick={onDelete}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
      {!folder.collapsed && <div className="mt-3">{children}</div>}
    </DropZone>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800"
    >
      {children}
    </button>
  );
}

function FolderDialog({
  folder,
  onClose,
  onSave,
}: {
  folder?: Folder;
  onClose: () => void;
  onSave: (name: string, color: string, folder?: Folder) => void;
}) {
  const t = useTranslations("home");
  const [name, setName] = useState(folder?.name ?? "");
  const [color, setColor] = useState(folder?.color ?? "blue");
  return (
    <Modal open onClose={onClose} title={folder ? t("editFolder") : t("newFolder")}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim(), color, folder);
        }}
      >
        <Input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t("folderName")} />
        <div>
          <p className="mb-2 text-sm font-medium">{t("folderColor")}</p>
          <div className="flex flex-wrap gap-2">
            {FOLDER_COLOR_KEYS.map((key) => (
              <button
                type="button"
                key={key}
                aria-label={key}
                onClick={() => setColor(key)}
                className={cn(
                  "flex size-9 items-center justify-center rounded-full",
                  folderColor(key).dot,
                  color === key && "ring-2 ring-offset-2 ring-slate-900 dark:ring-white dark:ring-offset-slate-900",
                )}
              >
                {color === key && <Check className="size-4 text-white" />}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            {t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LibraryPanel({
  modules,
  onHome,
  folders,
  onAdd,
  onClose,
}: {
  modules: HomeModule[];
  onHome: Set<string>;
  folders: Folder[];
  onAdd: (moduleId: string, folderId?: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("home");
  const [target, setTarget] = useState(ROOT);
  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-4 shadow-2xl lg:sticky lg:top-20 lg:z-auto lg:max-h-[calc(100dvh-7rem)] lg:rounded-xl lg:shadow-none dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">{t("library")}</h3>
        <button onClick={onClose} aria-label={t("close")} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
          <X className="size-4" />
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">{t("libraryHint")}</p>
      {folders.length > 0 && (
        <Select value={target} onChange={(e) => setTarget(e.target.value)} className="mb-3">
          <option value={ROOT}>{t("addTo", { name: t("uncategorized") })}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {t("addTo", { name: f.name })}
            </option>
          ))}
        </Select>
      )}
      <ul className="space-y-2">
        {modules.map((m) => (
          <LibraryItem key={m.id} module={m} added={onHome.has(m.id)} onAdd={() => onAdd(m.id, target)} />
        ))}
      </ul>
    </aside>
  );
}

function LibraryItem({ module, added, onAdd }: { module: HomeModule; added: boolean; onAdd: () => void }) {
  const t = useTranslations("home");
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: LIB + module.id, disabled: added });
  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "touch-drag flex items-center gap-3 rounded-lg border border-slate-200 p-2 dark:border-slate-800",
        !added && "cursor-grab",
        isDragging && "opacity-40",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">
        <ModuleIcon name={module.icon} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{module.name}</span>
          {module.is_new && !added && <span className="rounded bg-rose-500 px-1 text-[10px] font-bold leading-4 text-white">{t("new")}</span>}
        </span>
        {module.description && <span className="block truncate text-xs text-slate-500">{module.description}</span>}
      </span>
      {added ? (
        <span className="flex items-center gap-1 text-xs text-emerald-600" title={t("onHome")}>
          <Check className="size-4" />
        </span>
      ) : (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={onAdd}
          aria-label={t("addToHome")}
          className="rounded-md p-1.5 text-brand-600 hover:bg-brand-50 dark:text-brand-100 dark:hover:bg-brand-700/20"
        >
          <Plus className="size-4" />
        </button>
      )}
    </li>
  );
}
