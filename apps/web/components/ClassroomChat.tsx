"use client";

import {
  Dispatch,
  FormEvent,
  SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  Paperclip,
  Pencil,
  Pin,
  SendHorizontal,
  Smile,
  Trash2,
} from "lucide-react";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import { API_BASE, apiFetch } from "@/lib/api";
import { getAccessToken, getUser } from "@/lib/auth";
import {
  CHAT_EMOJI_CATEGORIES,
  CHAT_EMOJI_LIST,
  CHAT_REACTION_QUICK,
} from "@/lib/chatEmojis";
import { fileToTutorImageDataUrl } from "@/lib/tutorMedia";
import type {
  ChatAttachment,
  ChatAttachmentKind,
  ChatFeed,
  ChatMessage,
  Classroom,
  Role,
} from "@/lib/types";

/** ~5MB original; JPEG data-URL stays under backend / gateway 16MB JSON budget. */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_FILE_BYTES = 3.5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 3 * 1024 * 1024;

type PendingAttachment = {
  kind: ChatAttachmentKind;
  fileName: string;
  mimeType: string;
  urlOrData: string;
};

type PickerPlacement = {
  top: number;
  left: number;
  openUp: boolean;
};

type ToolbarPlacement = {
  top: number;
  left: number;
};

function safeTrim(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function canDeleteMessages(role?: Role | string | null): boolean {
  const r = String(role || "").toUpperCase();
  return r === "TEACHER" || r === "ADMIN";
}

/** Authors edit their own messages only (all roles). */
function canEditMessage(message: ChatMessage, myId: string): boolean {
  if (message.deleted) return false;
  return message.senderId === myId;
}

function formatTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function readFileAsDataUrl(file: File, maxBytes: number): Promise<string> {
  if (!file) {
    return Promise.reject(new Error("Không có tệp để đọc."));
  }
  if (file.size > maxBytes) {
    return Promise.reject(
      new Error(`Tệp quá lớn (tối đa ~${Math.round(maxBytes / (1024 * 1024))}MB).`),
    );
  }
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string" || !safeTrim(result)) {
          reject(new Error("Không đọc được tệp (kết quả trống)."));
          return;
        }
        resolve(result);
      };
      reader.onerror = () =>
        reject(new Error("Không đọc được tệp. Thử lại hoặc chọn tệp khác."));
      reader.onabort = () => reject(new Error("Đọc tệp bị hủy."));
      reader.readAsDataURL(file);
    } catch {
      reject(new Error("Trình duyệt không đọc được tệp này."));
    }
  });
}

function mergeMessages(prev: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const idx = prev.findIndex((m) => m.id === incoming.id);
  if (idx >= 0) {
    const next = [...prev];
    next[idx] = incoming;
    return next;
  }
  return [...prev, incoming].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function mergePinned(prev: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const without = prev.filter((m) => m.id !== incoming.id);
  if (!incoming.pinned || incoming.deleted) return without;
  return [incoming, ...without].sort((a, b) => {
    const at = new Date(a.pinnedAt || a.createdAt).getTime();
    const bt = new Date(b.pinnedAt || b.createdAt).getTime();
    return bt - at;
  });
}

function applyIncoming(
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  setPinned: Dispatch<SetStateAction<ChatMessage[]>>,
  incoming: ChatMessage,
) {
  setMessages((prev) => mergeMessages(prev, incoming));
  setPinned((prev) => mergePinned(prev, incoming));
}

function computePickerPlacement(anchor: DOMRect): PickerPlacement {
  const pickerW = 300;
  const pickerH = 280;
  const gap = 8;
  const pad = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceAbove = anchor.top - pad;
  const spaceBelow = vh - anchor.bottom - pad;
  const openUp = spaceAbove >= Math.min(pickerH, 160) + gap || spaceAbove > spaceBelow;

  let top = openUp ? anchor.top - gap - pickerH : anchor.bottom + gap;
  top = Math.max(pad, Math.min(top, vh - Math.min(pickerH, vh - pad * 2) - pad));

  let left = anchor.left + anchor.width / 2 - pickerW / 2;
  left = Math.max(pad, Math.min(left, vw - pickerW - pad));

  return { top, left, openUp };
}

function computeToolbarPlacement(
  anchor: DOMRect,
  mine: boolean,
  optionCount: number,
): ToolbarPlacement {
  const barW = Math.min(56 + optionCount * 40, 220);
  const barH = 42;
  const gap = 6;
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = anchor.top - barH - gap;
  if (top < pad) top = anchor.bottom + gap;
  top = Math.max(pad, Math.min(top, vh - barH - pad));

  let left = mine ? anchor.right - barW : anchor.left;
  left = Math.max(pad, Math.min(left, vw - barW - pad));

  return { top, left };
}

function menuOptionCount(canEdit: boolean, canDelete: boolean): number {
  return 2 + (canEdit ? 1 : 0) + (canDelete ? 1 : 0);
}

function autoGrowTextarea(el: HTMLTextAreaElement | null, minPx = 24) {
  if (!el) return;
  el.style.maxHeight = "none";
  el.style.height = "auto";
}

type Props = {
  classroomId: string;
  backHref: string;
  backLabel?: string;
};

export default function ClassroomChat({
  classroomId,
  backHref,
  backLabel = "← Quay lại lớp",
}: Props) {
  const me = getUser();
  const myId = me?.id || "";
  const canDelete = canDeleteMessages(me?.role);

  const [classroom, setClassroom] = useState<Classroom | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pinned, setPinned] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [toolbarPos, setToolbarPos] = useState<ToolbarPlacement | null>(null);
  const [reactOpenId, setReactOpenId] = useState<string | null>(null);
  const [pickerPos, setPickerPos] = useState<PickerPlacement | null>(null);
  const [composerEmojiOpen, setComposerEmojiOpen] = useState(false);
  const [emojiTab, setEmojiTab] = useState(CHAT_EMOJI_CATEGORIES[0]?.id || "smileys");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerEmojiRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const bubbleRefs = useRef<Map<string, HTMLElement>>(new Map());
  const longPressTimer = useRef<number | null>(null);
  const hoverOpenTimer = useRef<number | null>(null);
  const suppressClickUntil = useRef(0);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const closeMenus = useCallback(() => {
    setMenuOpenId(null);
    setToolbarPos(null);
    setReactOpenId(null);
    setPickerPos(null);
  }, []);

  const closeReactionPicker = useCallback(() => {
    setReactOpenId(null);
    setPickerPos(null);
  }, []);

  const openMessageMenu = useCallback((messageId: string, mine: boolean, optionCount = 4) => {
    const el = bubbleRefs.current.get(messageId);
    if (!el) return;
    setComposerEmojiOpen(false);
    closeReactionPicker();
    setToolbarPos(computeToolbarPlacement(el.getBoundingClientRect(), mine, optionCount));
    setMenuOpenId(messageId);
  }, [closeReactionPicker]);

  const openReactionPicker = useCallback((messageId: string) => {
    const el = bubbleRefs.current.get(messageId);
    if (!el) return;
    setComposerEmojiOpen(false);
    setMenuOpenId(null);
    setToolbarPos(null);
    setPickerPos(computePickerPlacement(el.getBoundingClientRect()));
    setReactOpenId(messageId);
  }, []);

  const resizeComposer = useCallback(() => {
    autoGrowTextarea(textInputRef.current, 24);
  }, []);

  const resizeEdit = useCallback(() => {
    autoGrowTextarea(editInputRef.current, 40);
  }, []);

  const insertEmojiAtCursor = useCallback((emoji: string) => {
    const el = textInputRef.current;
    const current = text ?? "";
    if (!el) {
      setText(`${current}${emoji}`);
      return;
    }
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`;
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + emoji.length;
      el.setSelectionRange(caret, caret);
      resizeComposer();
    });
  }, [text, resizeComposer]);

  useLayoutEffect(() => {
    resizeComposer();
  }, [text, resizeComposer]);

  useLayoutEffect(() => {
    if (editingId) resizeEdit();
  }, [editDraft, editingId, resizeEdit]);

  const loadInitial = useCallback(async () => {
    if (!classroomId) return;
    setLoading(true);
    setError("");
    try {
      const [cls, feed] = await Promise.all([
        apiFetch<Classroom>(`/api/v1/classrooms/${classroomId}`),
        apiFetch<ChatFeed>(
          `/api/v1/classrooms/${classroomId}/chat/messages?limit=40`,
        ),
      ]);
      setClassroom(cls);
      setPinned(feed.pinned || []);
      setMessages(feed.messages || []);
      setHasMore((feed.messages || []).length >= 40);
      stickToBottom.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được phòng chat");
    } finally {
      setLoading(false);
    }
  }, [classroomId]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!loading && stickToBottom.current) {
      scrollToBottom();
    }
  }, [messages, loading, scrollToBottom]);

  useLayoutEffect(() => {
    if (!menuOpenId) {
      setToolbarPos(null);
      return;
    }
    const el = bubbleRefs.current.get(menuOpenId);
    if (!el) return;
    const msg =
      messages.find((m) => m.id === menuOpenId) ||
      pinned.find((m) => m.id === menuOpenId);
    const mine = msg?.senderId === myId;
    const options = menuOptionCount(
      msg ? canEditMessage(msg, myId) : false,
      canDelete,
    );
    const update = () =>
      setToolbarPos(
        computeToolbarPlacement(el.getBoundingClientRect(), !!mine, options),
      );
    update();
    window.addEventListener("resize", update);
    const list = listRef.current;
    list?.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      list?.removeEventListener("scroll", update);
    };
  }, [menuOpenId, messages, pinned, myId, canDelete]);

  useLayoutEffect(() => {
    if (!reactOpenId) {
      setPickerPos(null);
      return;
    }
    const el = bubbleRefs.current.get(reactOpenId);
    if (!el) return;
    const update = () =>
      setPickerPos(computePickerPlacement(el.getBoundingClientRect()));
    update();
    window.addEventListener("resize", update);
    const list = listRef.current;
    list?.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("resize", update);
      list?.removeEventListener("scroll", update);
    };
  }, [reactOpenId]);

  useEffect(() => {
    if (!menuOpenId && !reactOpenId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenus();
    };
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const toolbar = document.getElementById("classroom-chat-toolbar-portal");
      const picker = document.getElementById("classroom-chat-react-portal");
      const bubbleId = menuOpenId || reactOpenId;
      const bubble = bubbleId ? bubbleRefs.current.get(bubbleId) : null;
      if (toolbar?.contains(target) || picker?.contains(target) || bubble?.contains(target)) {
        return;
      }
      closeMenus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [menuOpenId, reactOpenId, closeMenus]);

  useEffect(() => {
    if (!composerEmojiOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setComposerEmojiOpen(false);
    };
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (composerEmojiRef.current?.contains(target)) return;
      setComposerEmojiOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [composerEmojiOpen]);

  // SSE live updates (+ short poll fallback)
  useEffect(() => {
    if (!classroomId) return;
    const token = getAccessToken();
    if (!token) return;

    let es: EventSource | null = null;
    let pollId: number | undefined;
    let closed = false;

    const applyMessage = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const msg = raw as ChatMessage;
      if (!msg.id) return;
      applyIncoming(setMessages, setPinned, msg);
    };

    const connect = () => {
      if (closed) return;
      const url = `${API_BASE}/api/v1/classrooms/${classroomId}/chat/stream?access_token=${encodeURIComponent(token)}`;
      es = new EventSource(url);
      es.addEventListener("message", (ev) => {
        try {
          applyMessage(JSON.parse(ev.data));
          if (stickToBottom.current) scrollToBottom();
        } catch {
          /* ignore */
        }
      });
      const syncView = (ev: MessageEvent) => {
        try {
          applyMessage(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
      };
      es.addEventListener("reaction", syncView);
      es.addEventListener("pin", syncView);
      es.addEventListener("message_edited", syncView);
      es.addEventListener("message_deleted", (ev) => {
        try {
          const data = JSON.parse(ev.data) as { id?: string };
          if (!data.id) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === data.id
                ? {
                    ...m,
                    deleted: true,
                    pinned: false,
                    pinnedAt: null,
                    text: null,
                    attachments: [],
                  }
                : m,
            ),
          );
          setPinned((prev) => prev.filter((m) => m.id !== data.id));
          if (editingId === data.id) {
            setEditingId(null);
            setEditDraft("");
          }
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        es?.close();
        es = null;
        if (!closed) {
          window.setTimeout(connect, 4000);
        }
      };
    };

    connect();

    pollId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void apiFetch<ChatFeed>(
        `/api/v1/classrooms/${classroomId}/chat/messages?limit=20`,
      )
        .then((feed) => {
          if (feed.pinned) setPinned(feed.pinned);
          setMessages((prev) => {
            let next = prev;
            for (const m of feed.messages || []) {
              next = mergeMessages(next, m);
            }
            return next;
          });
        })
        .catch(() => undefined);
    }, 25_000);

    return () => {
      closed = true;
      es?.close();
      if (pollId) window.clearInterval(pollId);
    };
  }, [classroomId, scrollToBottom, editingId]);

  async function loadOlder() {
    if (!messages.length || loadingOlder || !hasMore) return;
    const oldest = messages[0];
    setLoadingOlder(true);
    setError("");
    try {
      const feed = await apiFetch<ChatFeed>(
        `/api/v1/classrooms/${classroomId}/chat/messages?before=${encodeURIComponent(oldest.createdAt)}&limit=40`,
      );
      const older = feed.messages || [];
      if (feed.pinned) setPinned(feed.pinned);
      if (older.length === 0) {
        setHasMore(false);
      } else {
        setMessages((prev) => {
          const map = new Map<string, ChatMessage>();
          for (const m of [...older, ...prev]) map.set(m.id, m);
          return Array.from(map.values()).sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );
        });
        if (older.length < 40) setHasMore(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải thêm tin nhắn");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function onPickFile(file: File | null) {
    if (!file) return;
    setError("");
    setComposerEmojiOpen(false);
    try {
      const mime = safeTrim(file.type).toLowerCase();
      const name = safeTrim(file.name) || "attachment";
      let kind: ChatAttachmentKind;
      let urlOrData: string;
      let mimeType = mime;

      if (mime.startsWith("image/") || /\.(jpe?g|png|gif|webp)$/i.test(name)) {
        kind = "image";
        urlOrData = await fileToTutorImageDataUrl(file, MAX_IMAGE_BYTES, 1920);
        mimeType = "image/jpeg";
      } else if (mime.startsWith("video/")) {
        kind = "video";
        if (!["video/mp4", "video/webm"].includes(mime)) {
          throw new Error("Chỉ hỗ trợ video MP4 hoặc WebM.");
        }
        urlOrData = await readFileAsDataUrl(file, MAX_VIDEO_BYTES);
      } else {
        kind = "file";
        const allowed = [
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/plain",
          "application/zip",
          "application/x-zip-compressed",
        ];
        if (!allowed.includes(mime)) {
          throw new Error("Định dạng tệp không được hỗ trợ.");
        }
        urlOrData = await readFileAsDataUrl(file, MAX_FILE_BYTES);
      }

      const data = safeTrim(urlOrData);
      if (!data) {
        throw new Error("Không đọc được nội dung tệp.");
      }

      setPending({
        kind,
        fileName: name || `attachment.${kind}`,
        mimeType: mimeType || "application/octet-stream",
        urlOrData: data,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không đính kèm được tệp");
      setPending(null);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = safeTrim(text);
    if ((!body && !pending) || sending) return;

    const attachmentPayload = pending
      ? [
          {
            kind: pending.kind,
            fileName: safeTrim(pending.fileName) || `attachment.${pending.kind}`,
            mimeType: safeTrim(pending.mimeType) || "application/octet-stream",
            urlOrData: safeTrim(pending.urlOrData),
          },
        ]
      : [];

    if (attachmentPayload.length > 0 && !attachmentPayload[0].urlOrData) {
      setError("Tệp đính kèm không hợp lệ. Hãy chọn lại.");
      return;
    }

    setSending(true);
    setError("");
    setComposerEmojiOpen(false);
    stickToBottom.current = true;
    try {
      const created = await apiFetch<ChatMessage>(
        `/api/v1/classrooms/${classroomId}/chat/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            text: body || null,
            attachments: attachmentPayload,
          }),
        },
      );
      applyIncoming(setMessages, setPinned, created);
      setText("");
      setPending(null);
      scrollToBottom();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không gửi được tin nhắn");
    } finally {
      setSending(false);
    }
  }

  function requestDelete(messageId: string) {
    if (!canDelete) return;
    closeMenus();
    setPendingDeleteId(messageId);
  }

  async function onDelete(messageId: string) {
    if (!canDelete || deleting) return;
    setDeleting(true);
    setError("");
    closeMenus();
    try {
      const updated = await apiFetch<ChatMessage>(
        `/api/v1/classrooms/${classroomId}/chat/messages/${messageId}`,
        { method: "DELETE" },
      );
      applyIncoming(setMessages, setPinned, updated);
      if (editingId === messageId) {
        setEditingId(null);
        setEditDraft("");
      }
      setPendingDeleteId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không xóa được tin nhắn");
    } finally {
      setDeleting(false);
    }
  }

  async function onTogglePin(messageId: string) {
    setError("");
    closeMenus();
    try {
      const updated = await apiFetch<ChatMessage>(
        `/api/v1/classrooms/${classroomId}/chat/messages/${messageId}/pin`,
        { method: "POST" },
      );
      applyIncoming(setMessages, setPinned, updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không ghim được tin nhắn");
    }
  }

  function startEdit(message: ChatMessage) {
    if (!canEditMessage(message, myId)) return;
    closeMenus();
    setEditingId(message.id);
    setEditDraft(message.text || "");
  }

  async function saveEdit(messageId: string) {
    const body = safeTrim(editDraft);
    if (!body || savingEdit) return;
    setSavingEdit(true);
    setError("");
    try {
      const updated = await apiFetch<ChatMessage>(
        `/api/v1/classrooms/${classroomId}/chat/messages/${messageId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ text: body }),
        },
      );
      applyIncoming(setMessages, setPinned, updated);
      setEditingId(null);
      setEditDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không sửa được tin nhắn");
    } finally {
      setSavingEdit(false);
    }
  }

  async function onToggleReaction(messageId: string, emoji: string) {
    const safeEmoji = safeTrim(emoji);
    if (!safeEmoji) return;
    setError("");
    closeReactionPicker();
    try {
      const updated = await apiFetch<ChatMessage>(
        `/api/v1/classrooms/${classroomId}/chat/messages/${messageId}/reactions`,
        {
          method: "POST",
          body: JSON.stringify({ emoji: safeEmoji }),
        },
      );
      applyIncoming(setMessages, setPinned, updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thả cảm xúc được");
    }
  }

  function onScrollList() {
    const el = listRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = dist < 80;
  }

  function openMenuForMessage(message: ChatMessage, { toggle = true } = {}) {
    if (message.deleted) return;
    const mine = message.senderId === myId;
    const options = menuOptionCount(canEditMessage(message, myId), canDelete);
    if (toggle && menuOpenId === message.id) {
      closeMenus();
      return;
    }
    openMessageMenu(message.id, mine, options);
  }

  function clearLongPress() {
    if (longPressTimer.current != null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function clearHoverOpen() {
    if (hoverOpenTimer.current != null) {
      window.clearTimeout(hoverOpenTimer.current);
      hoverOpenTimer.current = null;
    }
  }

  function startLongPress(message: ChatMessage) {
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      suppressClickUntil.current = Date.now() + 500;
      openMenuForMessage(message, { toggle: false });
    }, 420);
  }

  function scrollToMessage(messageId: string) {
    const el = bubbleRefs.current.get(messageId);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.classList.add("is-flash");
    window.setTimeout(() => el?.classList.remove("is-flash"), 1200);
  }

  const canSend = Boolean(safeTrim(text) || pending) && !sending;
  const activeCategory =
    CHAT_EMOJI_CATEGORIES.find((c) => c.id === emojiTab) || CHAT_EMOJI_CATEGORIES[0];
  const menuMessage = menuOpenId
    ? messages.find((m) => m.id === menuOpenId) ||
      pinned.find((m) => m.id === menuOpenId)
    : null;

  if (loading) {
    return <p className="empty-state">Đang tải phòng chat…</p>;
  }

  if (!classroom) {
    return (
      <>
        <div className="alert alert-error">{error || "Không tìm thấy lớp học"}</div>
        <Link href={backHref} className="btn btn-ghost btn-sm">
          {backLabel}
        </Link>
      </>
    );
  }

  const toolbarPortal =
    typeof document !== "undefined" &&
    menuOpenId &&
    menuMessage &&
    !menuMessage.deleted &&
    toolbarPos &&
    createPortal(
      <div
        id="classroom-chat-toolbar-portal"
        className="classroom-chat-hover-bar"
        role="menu"
        style={{ top: toolbarPos.top, left: toolbarPos.left }}
      >
        <button
          type="button"
          role="menuitem"
          title="Cảm xúc"
          aria-label="Cảm xúc"
          onClick={() => openReactionPicker(menuOpenId)}
        >
          <Smile size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          role="menuitem"
          title={menuMessage.pinned ? "Bỏ ghim" : "Ghim"}
          aria-label={menuMessage.pinned ? "Bỏ ghim" : "Ghim"}
          className={menuMessage.pinned ? "is-active" : undefined}
          onClick={() => void onTogglePin(menuOpenId)}
        >
          <Pin size={16} strokeWidth={2} />
        </button>
        {canEditMessage(menuMessage, myId) && (
          <button
            type="button"
            role="menuitem"
            title="Sửa"
            aria-label="Sửa"
            onClick={() => startEdit(menuMessage)}
          >
            <Pencil size={16} strokeWidth={2} />
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            role="menuitem"
            title="Xóa"
            aria-label="Xóa"
            className="is-danger"
            onClick={() => requestDelete(menuOpenId)}
          >
            <Trash2 size={16} strokeWidth={2} />
          </button>
        )}
      </div>,
      document.body,
    );

  const reactionPortal =
    typeof document !== "undefined" &&
    reactOpenId &&
    pickerPos &&
    createPortal(
      <div
        id="classroom-chat-react-portal"
        className={`classroom-chat-emoji-panel classroom-chat-emoji-panel--portal${
          pickerPos.openUp ? " is-above" : " is-below"
        }`}
        role="menu"
        style={{ top: pickerPos.top, left: pickerPos.left }}
      >
        <div className="classroom-chat-emoji-quick">
          {CHAT_REACTION_QUICK.map((emoji) => (
            <button
              key={`q-${emoji}`}
              type="button"
              onClick={() => void onToggleReaction(reactOpenId, emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
        <div className="classroom-chat-emoji-grid classroom-chat-emoji-grid--react">
          {CHAT_EMOJI_LIST.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => void onToggleReaction(reactOpenId, emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>,
      document.body,
    );

  function renderBubble(m: ChatMessage) {
    const mine = m.senderId === myId;
    const showMenu = !m.deleted;
    const isEditing = editingId === m.id;

    return (
      <article
        key={m.id}
        ref={(node) => {
          if (node) bubbleRefs.current.set(m.id, node);
          else bubbleRefs.current.delete(m.id);
        }}
        className={`classroom-chat-bubble ${mine ? "classroom-chat-bubble--mine" : "classroom-chat-bubble--theirs"}${
          menuOpenId === m.id || reactOpenId === m.id ? " is-reacting" : ""
        }${m.pinned ? " is-pinned" : ""}`}
        onClick={(e) => {
          if (!showMenu || isEditing) return;
          if (Date.now() < suppressClickUntil.current) return;
          const target = e.target as HTMLElement | null;
          if (target?.closest("button, a, textarea, input, video")) return;
          openMenuForMessage(m);
        }}
        onMouseEnter={() => {
          // Secondary path: delayed hover open on pointer devices
          if (
            !showMenu ||
            isEditing ||
            menuOpenId ||
            reactOpenId ||
            !window.matchMedia("(hover: hover)").matches
          ) {
            return;
          }
          clearHoverOpen();
          hoverOpenTimer.current = window.setTimeout(() => {
            openMenuForMessage(m, { toggle: false });
          }, 380);
        }}
        onMouseLeave={(e) => {
          clearHoverOpen();
          const related = e.relatedTarget as Node | null;
          const toolbar = document.getElementById("classroom-chat-toolbar-portal");
          if (toolbar?.contains(related)) return;
          // Keep click-opened menus until outside click / Escape
        }}
        onTouchStart={() => {
          if (showMenu && !isEditing) startLongPress(m);
        }}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
        onTouchCancel={clearLongPress}
        onContextMenu={(e) => {
          if (!showMenu || isEditing) return;
          e.preventDefault();
          openMenuForMessage(m, { toggle: false });
        }}
      >
        <header className="classroom-chat-bubble-head">
          <strong>
            {m.pinned ? (
              <Pin size={12} strokeWidth={2.4} className="classroom-chat-pin-icon" />
            ) : null}
            {m.senderName || "Thành viên"}
          </strong>
          <span>
            {formatTime(m.createdAt)}
            {m.editedAt ? " · đã sửa" : ""}
          </span>
        </header>

        {m.deleted ? (
          <p className="classroom-chat-deleted">Tin nhắn đã bị xóa</p>
        ) : isEditing ? (
          <div className="classroom-chat-edit">
            <textarea
              ref={editInputRef}
              className="form-input classroom-chat-edit-input"
              value={editDraft}
              onChange={(e) => {
                setEditDraft(e.target.value);
                autoGrowTextarea(e.currentTarget, 40);
              }}
              disabled={savingEdit}
              rows={1}
              wrap="soft"
              autoFocus
            />
            <div className="classroom-chat-edit-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={savingEdit}
                onClick={() => {
                  setEditingId(null);
                  setEditDraft("");
                }}
              >
                Hủy
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={savingEdit || !safeTrim(editDraft)}
                onClick={() => void saveEdit(m.id)}
              >
                {savingEdit ? "Đang lưu…" : "Lưu"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {m.text ? <p className="chat-plain">{m.text}</p> : null}
            {(m.attachments || []).map((a) => (
              <AttachmentBlock key={a.id} attachment={a} />
            ))}
          </>
        )}

        {!m.deleted && (m.reactions || []).length > 0 && (
          <div className="classroom-chat-actions">
            <div className="classroom-chat-reactions">
              {(m.reactions || []).map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  className={`classroom-chat-reaction${r.reactedByMe ? " is-active" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onToggleReaction(m.id, r.emoji);
                  }}
                  title={r.reactedByMe ? "Bỏ cảm xúc" : "Thả cảm xúc"}
                >
                  <span>{r.emoji}</span>
                  <em>{r.count}</em>
                </button>
              ))}
            </div>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="classroom-chat">
      <div className="classroom-chat-header">
        <div>
          <h1>{classroom.name}</h1>
          <p className="classroom-chat-subtitle">Chat lớp · tin nhắn & đính kèm</p>
        </div>
        <Link href={backHref} className="btn btn-ghost btn-sm">
          {backLabel}
        </Link>
      </div>

      {error && (
        <div className="alert alert-error classroom-chat-error" role="alert">
          {error}
        </div>
      )}

      <div className="classroom-chat-panel">
        <div className="classroom-chat-toolbar">
          {hasMore ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? "Đang tải…" : "Tải tin cũ hơn"}
            </button>
          ) : (
            <span className="classroom-chat-hint">Đầu hội thoại</span>
          )}
        </div>

        {pinned.length > 0 && (
          <div className="classroom-chat-pinned" aria-label="Tin nhắn đã ghim">
            <div className="classroom-chat-pinned-label">
              <Pin size={14} strokeWidth={2.2} />
              <span>Đã ghim</span>
            </div>
            <div className="classroom-chat-pinned-list">
              {pinned.map((p) => (
                <button
                  key={`pin-${p.id}`}
                  type="button"
                  className="classroom-chat-pinned-item"
                  onClick={() => scrollToMessage(p.id)}
                  title="Nhảy tới tin nhắn"
                >
                  <strong>{p.senderName || "Thành viên"}</strong>
                  <span>{safeTrim(p.text) || (p.attachments?.length ? "Đính kèm" : "…")}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div
          className="classroom-chat-messages"
          ref={listRef}
          onScroll={onScrollList}
        >
          {messages.length === 0 ? (
            <p className="empty-state">Chưa có tin nhắn — hãy gửi tin đầu tiên.</p>
          ) : (
            messages.map((m) => renderBubble(m))
          )}
          <div ref={bottomRef} />
        </div>

        <form className="classroom-chat-composer" onSubmit={(e) => void onSubmit(e)}>
          {pending && (
            <div className="classroom-chat-pending">
              <span>
                Đính kèm: <strong>{pending.fileName}</strong>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setPending(null)}
              >
                Bỏ
              </button>
            </div>
          )}

          {composerEmojiOpen && (
            <div
              ref={composerEmojiRef}
              className="classroom-chat-emoji-panel classroom-chat-emoji-panel--composer"
              role="dialog"
              aria-label="Chọn emoji"
            >
              <div className="classroom-chat-emoji-tabs" role="tablist">
                {CHAT_EMOJI_CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    role="tab"
                    aria-selected={emojiTab === cat.id}
                    className={emojiTab === cat.id ? "is-active" : undefined}
                    onClick={() => setEmojiTab(cat.id)}
                    title={cat.label}
                  >
                    {cat.emojis[0]}
                  </button>
                ))}
              </div>
              <div className="classroom-chat-emoji-grid">
                {(activeCategory?.emojis || []).map((emoji) => (
                  <button
                    key={`${activeCategory?.id}-${emoji}`}
                    type="button"
                    onClick={() => insertEmojiAtCursor(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="classroom-chat-composer-row">
            <div className="classroom-chat-composer-field">
              <button
                type="button"
                className="classroom-chat-icon-btn"
                disabled={sending}
                aria-label="Emoji"
                aria-expanded={composerEmojiOpen}
                onClick={() => {
                  closeMenus();
                  setComposerEmojiOpen((v) => !v);
                }}
              >
                <Smile size={20} strokeWidth={1.85} />
              </button>
              <button
                type="button"
                className="classroom-chat-icon-btn"
                disabled={sending}
                aria-label="Đính kèm"
                onClick={() => {
                  setComposerEmojiOpen(false);
                  fileInputRef.current?.click();
                }}
              >
                <Paperclip size={20} strokeWidth={1.85} />
              </button>
              <textarea
                ref={textInputRef}
                className="form-input classroom-chat-composer-input"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  autoGrowTextarea(e.currentTarget, 24);
                }}
                placeholder="Nhập tin nhắn…"
                disabled={sending}
                rows={1}
                wrap="soft"
                onFocus={() => closeMenus()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!sending && (safeTrim(text) || pending)) {
                      e.currentTarget.form?.requestSubmit();
                    }
                  }
                }}
              />
              <input
                ref={fileInputRef}
                type="file"
                hidden
                accept="image/*,video/mp4,video/webm,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip"
                onChange={(e) => void onPickFile(e.target.files?.[0] || null)}
              />
            </div>
            <button
              type="submit"
              className="classroom-chat-send-btn"
              disabled={!canSend}
              aria-label={sending ? "Đang gửi" : "Gửi"}
              title={sending ? "Đang gửi…" : "Gửi"}
            >
              <SendHorizontal size={20} strokeWidth={2} />
            </button>
          </div>
        </form>
      </div>
      {toolbarPortal}
      {reactionPortal}
      <ConfirmDeleteDialog
        open={pendingDeleteId != null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDeleteId(null);
        }}
        title="Xóa tin nhắn này?"
        description={
          <p>Tin nhắn sẽ bị xóa khỏi phòng chat. Hành động này không hoàn tác.</p>
        }
        confirmLabel="Xóa tin nhắn"
        confirming={deleting}
        onConfirm={() => {
          if (pendingDeleteId) void onDelete(pendingDeleteId);
        }}
      />
    </div>
  );
}

function AttachmentBlock({ attachment }: { attachment: ChatAttachment }) {
  const kind = safeTrim(attachment.kind).toLowerCase();
  const fileName = safeTrim(attachment.fileName) || "Tệp đính kèm";
  const src = safeTrim(attachment.urlOrData);
  if (!src) return null;

  if (kind === "image") {
    return (
      <div className="chat-image-wrap classroom-chat-media">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={fileName} className="chat-generated-image" />
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="chat-video-wrap classroom-chat-media">
        <video
          className="chat-generated-video"
          controls
          src={src}
          preload="metadata"
        />
      </div>
    );
  }
  return (
    <a className="classroom-chat-file" href={src} download={fileName}>
      {fileName}
    </a>
  );
}
