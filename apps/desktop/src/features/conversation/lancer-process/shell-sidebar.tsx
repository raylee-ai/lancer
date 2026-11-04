import { ModuleManager } from "./module-manager";
import { moduleZones } from "../../../../contracts/lancer-modules";
import { useEffect, useState, type CSSProperties } from "react";
import type { ProcessSurfaceActions } from "./process-types";
import { useProcessData } from "./process-glyph";
import { PlusIcon, SettingsIcon } from "../../../ui/icons";
import lancerMark from "../../../assets/lancer-mark.png";
import { ConversationEditor } from "./conversation-editor";
import {
  DEFAULT_LANCER_ASSISTANTS,
  type LancerAction,
} from "../../../../contracts/lancer-assistants";
import { AssistantItem } from "./assistant-item";
import { AssistantEditor } from "./assistant-editor";
import { conversationZoneId, stripLancerZonePrefix } from "../../../../contracts/lancer-zones";
import { t } from "../../../../contracts/i18n";
import type { ThreadMenuState } from "../../threads/hooks/use-thread-actions";
import type { ThreadListEntry } from "../../threads/thread-groups";
import { ShellSessionRow } from "./shell-session-row";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { PaneResizeHandle } from "../../../ui/pane-resize-handle";
import { usePersistedPaneWidth } from "../../../ui/use-persisted-pane-width";

import { useThreadShortcutHintsVisible } from "../../threads/thread-shortcut-hints";

const SIDEBAR_WIDTH_RANGE = { min: 200, max: 520 };
import "./assistants.css";

function ShellModuleIcon({ id, name }: { readonly id?: string; readonly name: string }) {
  // Preset modules render a localized name, so the icon keys off the stable id
  // and only falls back to the saved name for user-defined modules.
  const isVideo = id === "video" || name.includes("视频");
  const isResearch = id === "research" || name.includes("调研");
  const isXhs = id === "xhs" || name.includes("小红书");
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      {isVideo ? (
        <path d="M3 6h12v12H3zM15 10l6-3v10l-6-3" />
      ) : isResearch ? (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </>
      ) : isXhs ? (
        <>
          <rect x="4" y="3" width="16" height="18" rx="3" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </>
      ) : (
        <path d="M5 19L19 5M9 5h10v10" />
      )}
    </svg>
  );
}

export function ProcessSidebar({
  actions,
  threadMenu,
  threadShortcutOrderRef,
  threads = [],
}: {
  readonly actions: ProcessSurfaceActions;
  readonly threadMenu?: ThreadMenuState;
  readonly threadShortcutOrderRef?: import("react").RefObject<readonly ThreadListEntry[] | null>;
  readonly threads?: readonly ThreadListEntry[];
}) {
  const data = useProcessData();
  const commandHeld = useThreadShortcutHintsVisible(threadMenu?.platform ?? "linux");
  const [sidebarWidth, setSidebarWidth] = usePersistedPaneWidth(
    "pi-gui.sidebar-width",
    SIDEBAR_WIDTH_RANGE,
  );
  const [moduleEditor, setModuleEditor] = useState<string | null>(null);
  const [browsedGroup, setBrowsedGroup] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [assistantMode, setAssistantMode] = useState<"edit" | "rename" | "delete">("edit");
  const [editing, setEditing] = useState<string | null>(null);
  const [editingSession, setEditingSession] = useState<{
    id: string;
    title: string;
    zone: string;
  } | null>(null);

  const assistants = data.assistants ?? DEFAULT_LANCER_ASSISTANTS;
  const active =
    assistants.profiles.find((p) => p.id === data.assistantId) ?? assistants.profiles[0];
  const renameThread = threads.find((thread) => thread.session.id === threadMenu?.renameSessionId);
  const renameTarget = renameThread
    ? {
        id: `${renameThread.workspaceId}:${renameThread.session.id}`,
        title: stripLancerZonePrefix(renameThread.session.title),
        zone: conversationZoneId(renameThread.session.title, assistants.modules),
      }
    : editingSession;
  const selectedGroup = data.sidebar.find((group) => group.sessions.some((s) => s.selected));
  useEffect(() => {
    setBrowsedGroup(null);
  }, [selectedGroup?.name]);
  const groupName =
    browsedGroup ??
    selectedGroup?.name ??
    data.sidebar.find((group) => group.id === "chat")?.name ??
    data.sidebar[0]?.name;
  const group = data.sidebar.find((entry) => entry.name === groupName);
  const chatName = data.sidebar.find((entry) => entry.id === "chat")?.name ?? t("lancer.zone.chat");
  if (threadShortcutOrderRef) {
    threadShortcutOrderRef.current = (group?.sessions ?? []).flatMap((session) => {
      const entry = threads.find((thread) => thread.session.id === session.sessionId);
      return entry ? [entry] : [];
    });
  }
  useEffect(
    () => () => {
      if (threadShortcutOrderRef) threadShortcutOrderRef.current = null;
    },
    [threadShortcutOrderRef],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const pinnedIds = (group?.sessions ?? [])
    .filter((session) => session.pinned)
    .map((session) => session.id);
  const act = async (action: LancerAction) => {
    if (actions.onAssistantAction) await actions.onAssistantAction(action);
  };
  return (
    <aside
      className="side shell-sidebar"
      id="lancer-sidebar"
      style={
        sidebarWidth === undefined
          ? undefined
          : ({ "--lancer-sidebar-width": `${sidebarWidth}px` } as CSSProperties)
      }
    >
      <PaneResizeHandle
        className="sidebar__resize-handle"
        label="Sidebar width"
        controls="lancer-sidebar"
        edge="right"
        bounds={(_pane, container) => ({
          min: 200,
          max: Math.min(520, Math.floor(container.clientWidth * 0.4)),
        })}
        onResize={setSidebarWidth}
        onReset={() => setSidebarWidth(undefined)}
      />
      <div className="shell-sidebar__brand">
        <img src={lancerMark} alt="Lancer" />
        Lancer
      </div>
      <nav className="shell-sidebar__modules" aria-label={chatName}>
        <button
          type="button"
          aria-label={chatName}
          aria-pressed={group?.id === "chat"}
          onClick={() => {
            const chat = data.sidebar.find((g) => g.id === "chat");
            setBrowsedGroup(chat?.name ?? chatName);
            if (chat?.sessions[0]) actions.onSelectSession(chat.sessions[0].id);
            else actions.onNewThread?.("chat");
          }}
        >
          <ShellModuleIcon id="chat" name={chatName} />
          {chatName}
          <small>{data.sidebar.find((g) => g.id === "chat")?.sessions.length ?? 0}</small>
        </button>
      </nav>
      <div className="shell-sidebar__section-title">
        <span>模块</span>
        <div className="shell-sidebar__module-actions">
          <button type="button" aria-label="新增模块" onClick={() => setModuleEditor("new")}>
            <PlusIcon />
            新增
          </button>
          <button
            type="button"
            aria-label="管理模块"
            title="重命名、配置、删除与恢复模块"
            onClick={() =>
              setModuleEditor(
                group?.id !== "chat" && group?.id
                  ? group.id
                  : (data.sidebar.find((entry) => entry.id !== "chat")?.id ?? "new"),
              )
            }
          >
            管理
          </button>
        </div>
      </div>
      <nav className="shell-sidebar__modules" aria-label="模块">
        {data.sidebar
          .filter((entry) => entry.id !== "chat")
          .map((entry) => (
            <div
              className="shell-sidebar__module-row"
              key={entry.id}
              onContextMenu={(event) => {
                event.preventDefault();
                event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
                setModuleEditor(entry.id!);
              }}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  setModuleEditor(entry.id!);
                }
              }}
            >
              <button
                type="button"
                key={entry.name}
                aria-label={entry.name}
                aria-pressed={entry.name === groupName}
                onClick={() => {
                  setBrowsedGroup(entry.name);
                  const session = entry.sessions.find((s) => s.selected) ?? entry.sessions[0];
                  if (session) actions.onSelectSession(session.id);
                  else actions.onNewThread?.(entry.id);
                }}
              >
                <span style={{ color: assistants.modules?.find((m) => m.id === entry.id)?.color }}>
                  <ShellModuleIcon id={entry.id} name={entry.name} />
                </span>
                {entry.name}
                <small title="会话">{entry.sessions.length}</small>
              </button>
              <button
                type="button"
                aria-label={`设置模块：${entry.name}`}
                title="重命名、配置与删除模块"
                onClick={() => setModuleEditor(entry.id!)}
              >
                <SettingsIcon />
              </button>
            </div>
          ))}
      </nav>
      <div className="shell-sidebar__section-title">
        <span>AI 助手</span>
        <button
          type="button"
          aria-label="添加 AI 助手"
          onClick={() => {
            setAssistantMode("edit");
            setEditing("new");
          }}
        >
          <PlusIcon />
        </button>
      </div>
      <div className="shell-sidebar__residents" aria-label="AI 助手">
        {assistants.profiles.map((profile) => (
          <AssistantItem
            key={profile.id}
            profile={profile}
            active={profile.id === active?.id}
            canDelete={assistants.profiles.length > 1}
            onSelect={() => actions.onSelectAssistant?.(profile.id)}
            onEdit={(mode) => {
              setAssistantMode(mode);
              setEditing(profile.id);
            }}
          />
        ))}
      </div>
      <div className="shell-sidebar__section-title">
        <span>{group?.id === "chat" ? "会话列表" : `${group?.name ?? "模块"} · 会话`}</span>
        <button
          type="button"
          className="process-new-thread"
          aria-label="New thread"
          title="新建会话"
          onClick={() => {
            actions.onNewThread?.(group?.id);
          }}
        >
          <PlusIcon />
        </button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (!over || active.id === over.id) return;
          const from = pinnedIds.indexOf(String(active.id)),
            to = pinnedIds.indexOf(String(over.id));
          if (from < 0 || to < 0) return;
          const reorder = actions.onReorderPinnedSessions;
          if (reorder)
            void reorder(arrayMove(pinnedIds, from, to)).catch((e) => setError(String(e)));
        }}
      >
        <SortableContext items={pinnedIds} strategy={verticalListSortingStrategy}>
          <div className="lst" data-testid="lancer-zone-sidebar">
            {(group?.sessions ?? []).map((session, index) => (
              <ShellSessionRow
                key={session.id}
                session={session}
                index={index}
                active={active}
                commandHeld={commandHeld}
                actions={actions}
                threadMenu={threadMenu}
                threads={threads}
                zone={group?.id ?? "chat"}
                onEdit={setEditingSession}
                onError={setError}
              />
            ))}
            {(data.archivedSessions?.length ?? 0) > 0 ? (
              <section className="archived-thread-group">
                <button
                  type="button"
                  className="archived-thread-group__toggle"
                  aria-expanded={archivedOpen}
                  onClick={() => setArchivedOpen((v) => !v)}
                >
                  回收区 · {data.archivedSessions!.length}
                </button>
                {archivedOpen
                  ? data.archivedSessions!.map((session) => (
                      <div
                        className="session-row"
                        data-session-id={session.sessionId}
                        key={session.id}
                      >
                        <span className="archived-title">
                          {stripLancerZonePrefix(session.title)}
                        </span>
                        <button
                          type="button"
                          aria-label={`Restore ${stripLancerZonePrefix(session.title)}`}
                          onClick={() => {
                            const action = actions.onArchiveSession;
                            if (action)
                              void action(session.id, true).catch((e) => setError(String(e)));
                          }}
                        >
                          恢复
                        </button>
                      </div>
                    ))
                  : null}
              </section>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
            {!group?.sessions.length ? (
              <p className="process-empty-group">暂无会话，点击 + 开始。</p>
            ) : null}
          </div>
        </SortableContext>
      </DndContext>
      <footer className="ft shell-sidebar__footer">
        <img className="shell-sidebar__local" src={lancerMark} alt="Lancer" />
        <span>
          {t("lancer.process.localWorkspace")}
          <small>
            {t("lancer.process.moduleSummary", {
              modules: data.sidebar.filter((g) => g.id !== "chat").length,
              sessions: data.sidebar.reduce((n, entry) => n + entry.sessions.length, 0),
            })}
          </small>
        </span>
        <button
          type="button"
          aria-label={t("workbench.workspaceTools")}
          onClick={actions.onOpenTools}
        >
          <SettingsIcon />
        </button>
      </footer>
      {editing ? (
        <AssistantEditor
          key={editing}
          mode={assistantMode}
          state={assistants}
          profile={assistants.profiles.find((p) => p.id === editing)}
          onAction={act}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {moduleEditor ? (
        <ModuleManager
          modules={assistants.modules}
          initialId={moduleEditor}
          onAction={async (action) => {
            await act(action);
            if (
              action.kind === "delete-module" &&
              group?.id === action.id &&
              !group.sessions.length
            )
              actions.onNewThread?.("chat");
          }}
          onClose={() => {
            setModuleEditor(null);
            setBrowsedGroup(null);
          }}
        />
      ) : null}
      {renameTarget ? (
        <ConversationEditor
          key={renameTarget.id}
          formRef={renameThread ? threadMenu?.renamePanelRef : undefined}
          zones={moduleZones(assistants.modules)}
          title={renameTarget.title}
          zone={renameTarget.zone}
          onClose={() => {
            setEditingSession(null);
            threadMenu?.cancelRename();
          }}
          onSave={async (title) => {
            await actions.onRenameSession?.(renameTarget.id, title);
          }}
        />
      ) : null}
    </aside>
  );
}
