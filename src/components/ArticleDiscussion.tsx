"use client";

import {
  ArrowUp,
  AudioLines,
  MessageCircle,
  Mic,
  MicOff,
  Square,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

export type ArticleDiscussionScope =
  | {
      kind: "whole";
    }
  | {
      kind: "selection";
      text: string;
    };

type DiscussionMessage = {
  sequence: string;
  id: string;
  requestId: string;
  role: "user" | "assistant";
  status: "pending" | "complete" | "error";
  content: string;
  scope?: "whole" | "selection";
  selection?: string;
  responseId?: string;
  model?: string;
  incomplete?: boolean;
  context?: DiscussionContext;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
};

type DiscussionContext = {
  scope: "whole" | "selection";
  truncated: boolean;
  originalCharacters: number;
  includedCharacters: number;
  note?: string;
};

type DiscussionListResponse = {
  articleId: string;
  messages: DiscussionMessage[];
  hasMore: boolean;
};

type DiscussionResponse = {
  requestId: string;
  status: "complete" | "pending" | "error";
  reply?: string;
  responseId?: string;
  model?: string;
  incomplete?: boolean;
  context?: DiscussionContext;
  error?: string;
};

type VoiceState =
  "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export type ArticleDiscussionMode = "dock" | "overlay" | "sheet";

export type ArticleDiscussionPhoneSnap = "compact" | "half" | "expanded";

export type ArticleDiscussionProps = {
  articleId: string;
  articleTitle: string;
  open: boolean;
  scope: ArticleDiscussionScope;
  mode?: ArticleDiscussionMode;
  phoneSnap?: ArticleDiscussionPhoneSnap;
  onClose: () => void;
  onSwitchToWhole: () => void;
  onSelectionConsumed?: () => void;
  onBeforeVoiceStart: () => void;
  onPhoneSnapChange?: (snap: ArticleDiscussionPhoneSnap) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  focusComposerRequest?: number;
};

const phoneSnapOrder: ArticleDiscussionPhoneSnap[] = [
  "compact",
  "half",
  "expanded",
];

export function ArticleDiscussion({
  articleId,
  articleTitle,
  open,
  scope,
  mode,
  phoneSnap: controlledPhoneSnap,
  onClose,
  onSwitchToWhole,
  onSelectionConsumed,
  onBeforeVoiceStart,
  onPhoneSnapChange,
  returnFocusRef,
  focusComposerRequest = 0,
}: ArticleDiscussionProps) {
  const resolvedMode = useResolvedDiscussionMode(mode);
  const [messages, setMessages] = useState<DiscussionMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [announceConversationUpdates, setAnnounceConversationUpdates] =
    useState(false);
  const [lastFocusComposerRequest, setLastFocusComposerRequest] = useState(
    focusComposerRequest,
  );
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextNote, setContextNote] = useState<string | null>(null);
  const [internalPhoneSnap, setInternalPhoneSnap] =
    useState<ArticleDiscussionPhoneSnap>("half");
  const phoneSnap = controlledPhoneSnap ?? internalPhoneSnap;
  const requestControllerRef = useRef<AbortController | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const activeArticleRef = useRef(articleId);
  const drawerRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const sheetHandleRef = useRef<HTMLButtonElement | null>(null);
  const phoneMuteRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenInSheetRef = useRef(false);
  const wasPhoneVoiceActiveRef = useRef(false);
  const sheetDragRef = useRef<{
    pointerId: number;
    startY: number;
    snap: ArticleDiscussionPhoneSnap;
  } | null>(null);
  const suppressSheetHandleClickRef = useRef(false);
  const hydrationFrameRef = useRef(0);
  const conversationHydratedRef = useRef(false);
  const pendingComposerFocusRef = useRef(false);
  const pendingVoicePanelFocusRef = useRef(false);
  const focusComposerThisRender =
    open && focusComposerRequest !== lastFocusComposerRequest;
  const headingId = useId();
  const {
    state: voiceState,
    muted,
    error: voiceError,
    contextNote: voiceContextNote,
    start: startVoice,
    stop: stopVoice,
    toggleMute,
  } = useArticleVoice({
    articleId,
    scope,
    onBeforeStart: onBeforeVoiceStart,
  });
  const voiceActive = voiceState !== "idle" && voiceState !== "error";
  const voiceConnected =
    voiceState === "listening" ||
    voiceState === "thinking" ||
    voiceState === "speaking";
  const modal = resolvedMode === "overlay";

  useEffect(() => {
    activeArticleRef.current = articleId;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    loadControllerRef.current?.abort();
    loadControllerRef.current = null;
    setMessages([]);
    setDraft("");
    setIsLoading(false);
    setHistoryHasMore(false);
    setAnnounceConversationUpdates(false);
    conversationHydratedRef.current = false;
    pendingComposerFocusRef.current = false;
    window.cancelAnimationFrame(hydrationFrameRef.current);
    setIsSending(false);
    setError(null);
    setContextNote(null);

    return () => {
      requestControllerRef.current?.abort();
      loadControllerRef.current?.abort();
      window.cancelAnimationFrame(hydrationFrameRef.current);
    };
  }, [articleId]);

  const loadMessages = useCallback(
    async ({ quiet = false }: { quiet?: boolean } = {}) => {
      const controller = new AbortController();
      const capturedArticleId = articleId;

      loadControllerRef.current?.abort();
      loadControllerRef.current = controller;
      if (!quiet) {
        setIsLoading(true);
      }

      try {
        const response = await fetch(
          `/api/discussion?articleId=${encodeURIComponent(articleId)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const body = (await response.json().catch(() => ({}))) as
          | DiscussionListResponse
          | { error?: string };

        if (
          controller.signal.aborted ||
          activeArticleRef.current !== capturedArticleId
        ) {
          return false;
        }

        if (!response.ok || !("messages" in body)) {
          throw new Error(
            "error" in body && body.error
              ? body.error
              : `Could not load this discussion (${response.status}).`,
          );
        }

        setMessages(body.messages);
        setHistoryHasMore(body.hasMore);
        setContextNote(latestContextNote(body.messages));
        if (!conversationHydratedRef.current) {
          window.cancelAnimationFrame(hydrationFrameRef.current);
          hydrationFrameRef.current = window.requestAnimationFrame(() => {
            conversationHydratedRef.current = true;
            setAnnounceConversationUpdates(true);
          });
        }
        return body.messages;
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(messageFromError(loadError));
        }
        return null;
      } finally {
        if (loadControllerRef.current === controller) {
          loadControllerRef.current = null;
          if (!quiet) {
            setIsLoading(false);
          }
        }
      }
    },
    [articleId],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    setError(null);
    void loadMessages();
  }, [loadMessages, open]);

  const pendingRequestIds = messages
    .filter(
      (message) => message.role === "assistant" && message.status === "pending",
    )
    .map((message) => message.requestId)
    .join(",");

  useEffect(() => {
    if (!open || !pendingRequestIds) {
      return;
    }

    let cancelled = false;
    let timer = 0;
    const startedAt = Date.now();

    const schedule = (attempt: number) => {
      const delay = Math.min(8_000, 1_200 * 2 ** attempt);
      timer = window.setTimeout(async () => {
        const refreshed = await loadMessages({ quiet: true });

        if (cancelled) {
          return;
        }

        const stillPending =
          !refreshed ||
          refreshed.some(
            (message) =>
              message.role === "assistant" && message.status === "pending",
          );

        if (stillPending && Date.now() - startedAt < 90_000) {
          schedule(attempt + 1);
        }
      }, delay);
    };

    schedule(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadMessages, open, pendingRequestIds]);

  useEffect(() => {
    if (open) {
      return;
    }

    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    loadControllerRef.current?.abort();
    loadControllerRef.current = null;
    setIsLoading(false);
    setIsSending(false);
    setAnnounceConversationUpdates(false);
    conversationHydratedRef.current = false;
    pendingComposerFocusRef.current = false;
    pendingVoicePanelFocusRef.current = false;
    window.cancelAnimationFrame(hydrationFrameRef.current);
    stopVoice();
  }, [open, stopVoice]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const returnFocus = returnFocusRef?.current;
    const drawer = drawerRef.current;

    return () => {
      const activeElement = document.activeElement;
      const preserveActiveFocus =
        !modal &&
        activeElement instanceof HTMLElement &&
        activeElement !== document.body &&
        drawer?.contains(activeElement) !== true;
      const previous = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;

      window.requestAnimationFrame(() => {
        const target =
          preserveActiveFocus &&
          activeElement.isConnected &&
          !activeElement.hasAttribute("inert")
            ? activeElement
            : previous?.isConnected && !previous.hasAttribute("inert")
            ? previous
            : returnFocus;
        target?.focus({ preventScroll: true });
      });
    };
  }, [modal, open, returnFocusRef]);

  useEffect(() => {
    if (!open || resolvedMode === "sheet") {
      return;
    }

    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(focusTimer);
  }, [open, resolvedMode]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const background = modal
      ? Array.from(
          document.querySelectorAll<HTMLElement>(
            ".app-surface, .selection-discuss-button",
          ),
        )
      : [];
    const previousInert = background.map((element) =>
      element.hasAttribute("inert"),
    );

    background.forEach((element) => element.setAttribute("inert", ""));

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (!modal || event.key !== "Tab" || !drawerRef.current) {
        return;
      }

      const focusable = focusableElements(drawerRef.current);

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeyDown);

    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      background.forEach((element, index) => {
        if (!previousInert[index]) {
          element.removeAttribute("inert");
        }
      });
    };
  }, [modal, onClose, open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [isLoading, isSending, messages]);

  const changePhoneSnap = useCallback(
    (nextSnap: ArticleDiscussionPhoneSnap) => {
      setInternalPhoneSnap(nextSnap);
      onPhoneSnapChange?.(nextSnap);
    },
    [onPhoneSnapChange],
  );

  const stepPhoneSnap = useCallback(
    (direction: -1 | 1) => {
      const currentIndex = phoneSnapOrder.indexOf(phoneSnap);
      const nextIndex = Math.min(
        phoneSnapOrder.length - 1,
        Math.max(0, currentIndex + direction),
      );
      changePhoneSnap(phoneSnapOrder[nextIndex]);
    },
    [changePhoneSnap, phoneSnap],
  );

  useEffect(() => {
    const openInSheet = open && resolvedMode === "sheet";
    let focusFrame = 0;

    if (openInSheet && !wasOpenInSheetRef.current) {
      const composerHasFocus = document.activeElement === inputRef.current;
      changePhoneSnap(composerHasFocus ? "expanded" : "half");

      if (!composerHasFocus) {
        focusFrame = window.requestAnimationFrame(() =>
          sheetHandleRef.current?.focus({ preventScroll: true }),
        );
      }
    }

    wasOpenInSheetRef.current = openInSheet;

    return () => window.cancelAnimationFrame(focusFrame);
  }, [changePhoneSnap, open, resolvedMode]);

  useLayoutEffect(() => {
    if (lastFocusComposerRequest === focusComposerRequest) {
      return;
    }

    setLastFocusComposerRequest(focusComposerRequest);

    if (!open) {
      return;
    }

    if (resolvedMode === "sheet") {
      pendingComposerFocusRef.current = true;
      changePhoneSnap("expanded");
      return;
    }

    inputRef.current?.focus({ preventScroll: true });
  }, [
    changePhoneSnap,
    focusComposerRequest,
    lastFocusComposerRequest,
    open,
    resolvedMode,
  ]);

  useLayoutEffect(() => {
    if (
      !open ||
      !pendingComposerFocusRef.current ||
      resolvedMode !== "sheet" ||
      phoneSnap !== "expanded"
    ) {
      return;
    }

    pendingComposerFocusRef.current = false;
    inputRef.current?.focus({ preventScroll: true });
  }, [open, phoneSnap, resolvedMode]);

  useLayoutEffect(() => {
    if (
      !open ||
      !pendingVoicePanelFocusRef.current ||
      resolvedMode !== "sheet" ||
      phoneSnap !== "half"
    ) {
      return;
    }

    pendingVoicePanelFocusRef.current = false;
    const voiceControl = drawerRef.current?.querySelector<HTMLButtonElement>(
      ".voice-actions button:not(:disabled)",
    );
    (voiceControl ?? sheetHandleRef.current)?.focus({ preventScroll: true });
  }, [open, phoneSnap, resolvedMode, voiceState]);

  useEffect(() => {
    const phoneVoiceActive =
      open && resolvedMode === "sheet" && voiceActive;
    const wasPhoneVoiceActive = wasPhoneVoiceActiveRef.current;
    wasPhoneVoiceActiveRef.current = phoneVoiceActive;

    if (phoneVoiceActive && !wasPhoneVoiceActive) {
      changePhoneSnap("compact");
      const focusFrame = window.requestAnimationFrame(() =>
        phoneMuteRef.current?.focus({ preventScroll: true }),
      );
      return () => window.cancelAnimationFrame(focusFrame);
    }

    if (
      !phoneVoiceActive &&
      wasPhoneVoiceActive &&
      open &&
      resolvedMode === "sheet"
    ) {
      pendingVoicePanelFocusRef.current = true;
      changePhoneSnap("half");
    }
  }, [changePhoneSnap, open, resolvedMode, voiceActive]);

  const handleSheetHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      sheetDragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        snap: phoneSnap,
      };
      suppressSheetHandleClickRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [phoneSnap],
  );

  const handleSheetHandlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = sheetDragRef.current;

      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      const deltaY = event.clientY - drag.startY;
      sheetDragRef.current = null;

      if (Math.abs(deltaY) < 48) {
        return;
      }

      suppressSheetHandleClickRef.current = true;
      const currentIndex = phoneSnapOrder.indexOf(drag.snap);
      const nextIndex = Math.min(
        phoneSnapOrder.length - 1,
        Math.max(0, currentIndex + (deltaY < 0 ? 1 : -1)),
      );
      changePhoneSnap(phoneSnapOrder[nextIndex]);
    },
    [changePhoneSnap],
  );

  const handleSheetHandleClick = useCallback(() => {
    if (suppressSheetHandleClickRef.current) {
      suppressSheetHandleClickRef.current = false;
      return;
    }

    changePhoneSnap(phoneSnap === "expanded" ? "half" : "expanded");
  }, [changePhoneSnap, phoneSnap]);

  const handleSheetHandleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        stepPhoneSnap(1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        stepPhoneSnap(-1);
      } else if (event.key === "Home") {
        event.preventDefault();
        changePhoneSnap("compact");
      } else if (event.key === "End") {
        event.preventDefault();
        changePhoneSnap("expanded");
      }
    },
    [changePhoneSnap, stepPhoneSnap],
  );

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();

    if (!message || isSending || isLoading) {
      return;
    }

    const requestId = messageId();
    const now = new Date().toISOString();
    const capturedArticleId = articleId;
    const submittedScope = scope;
    const userMessage: DiscussionMessage = {
      sequence: `optimistic-${requestId}`,
      id: `${requestId}:user`,
      requestId,
      role: "user",
      status: "complete",
      content: message,
      scope: submittedScope.kind,
      ...(submittedScope.kind === "selection"
        ? { selection: submittedScope.text }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    const controller = new AbortController();

    loadControllerRef.current?.abort();
    loadControllerRef.current = null;
    setIsLoading(false);
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setError(null);
    setIsSending(true);

    try {
      const response = await fetch("/api/discussion", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId,
          articleId,
          scope: submittedScope.kind,
          selection:
            submittedScope.kind === "selection"
              ? submittedScope.text
              : undefined,
          message,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as
        DiscussionResponse | { error?: string };

      if (
        controller.signal.aborted ||
        activeArticleRef.current !== capturedArticleId
      ) {
        return;
      }

      if (!response.ok || !("status" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : `Discussion request failed with ${response.status}.`,
        );
      }

      onSelectionConsumed?.();

      const refreshed = await loadMessages({ quiet: true });

      if (body.status === "complete") {
        setContextNote(contextNoteFromContext(body.context));
        if (!refreshed && body.reply) {
          setMessages((current) => [
            ...current,
            responseMessageFromBody(body, now),
          ]);
        }
        if (body.incomplete) {
          setError(
            "The response stopped early. Ask again or narrow the question.",
          );
        }
      } else if (body.status === "pending") {
        if (!refreshed) {
          setMessages((current) =>
            current.some(
              (message) =>
                message.requestId === requestId &&
                message.role === "assistant",
            )
              ? current
              : [
                  ...current,
                  pendingResponseMessage(requestId, now),
                ],
          );
        }
        setContextNote(
          "Sol is finishing this reply. It is safe to close and return later.",
        );
      } else {
        setError(
          body.error ?? "This reply did not complete. Send the question again.",
        );
      }
    } catch (requestError) {
      if (
        !controller.signal.aborted &&
        activeArticleRef.current === capturedArticleId
      ) {
        setError(messageFromError(requestError));
        await loadMessages({ quiet: true });
      }
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        if (activeArticleRef.current === capturedArticleId) {
          setIsSending(false);
        }
      }
    }
  }

  if (!open) {
    return null;
  }

  return (
    <>
      {modal ? (
        <button
          className="discussion-scrim"
          type="button"
          tabIndex={-1}
          aria-label="Close article discussion"
          onClick={onClose}
        />
      ) : null}
      <aside
        ref={drawerRef}
        className={`discussion-drawer discussion-mode-${resolvedMode} ${
          resolvedMode === "sheet" ? `discussion-snap-${phoneSnap}` : ""
        }`}
        aria-labelledby={headingId}
        aria-modal={modal ? true : undefined}
        role={modal ? "dialog" : "complementary"}
      >
        {resolvedMode === "sheet" ? (
          <div className="discussion-sheet-resizer">
            <button
              ref={sheetHandleRef}
              className="discussion-drag-handle"
              type="button"
              aria-label="Resize discussion panel. Drag or use arrow keys."
              title="Drag to resize discussion"
              onClick={handleSheetHandleClick}
              onKeyDown={handleSheetHandleKeyDown}
              onPointerDown={handleSheetHandlePointerDown}
              onPointerUp={handleSheetHandlePointerUp}
              onPointerCancel={() => {
                sheetDragRef.current = null;
                suppressSheetHandleClickRef.current = false;
              }}
            >
              <span aria-hidden="true" />
            </button>
            <div
              className="discussion-snap-controls"
              role="group"
              aria-label="Discussion panel size"
            >
              {phoneSnapOrder.map((snap) => (
                <button
                  className={`discussion-snap-button snap-${snap}`}
                  key={snap}
                  type="button"
                  aria-label={`${phoneSnapLabel(snap)} discussion panel`}
                  aria-pressed={phoneSnap === snap}
                  title={phoneSnapLabel(snap)}
                  onClick={() => changePhoneSnap(snap)}
                >
                  <span aria-hidden="true" />
                </button>
              ))}
            </div>
            <button
              className="discussion-sheet-close"
              type="button"
              aria-label="Close discussion"
              title="Close discussion"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        ) : null}

        {resolvedMode === "sheet" && phoneSnap === "compact" && voiceActive ? (
          <section className="discussion-call-bar" aria-label="Voice discussion">
            <div className="discussion-call-summary">
              <span className="voice-orb active" aria-hidden="true">
                <AudioLines size={22} />
              </span>
              <span>
                <strong>Sol voice</strong>
                <small role="status" aria-live="polite" aria-atomic="true">
                  {voiceError ?? voiceContextNote ?? voiceStateLabel(voiceState)}
                </small>
              </span>
            </div>
            <div className="discussion-call-actions">
              <button
                className="discussion-call-action expand"
                type="button"
                aria-label="Expand voice discussion"
                title="Expand voice discussion"
                onClick={() => {
                  pendingVoicePanelFocusRef.current = true;
                  changePhoneSnap("half");
                }}
              >
                <ArrowUp size={21} />
              </button>
              <button
                ref={phoneMuteRef}
                className="discussion-call-action"
                type="button"
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                aria-pressed={muted}
                title={muted ? "Unmute microphone" : "Mute microphone"}
                onClick={toggleMute}
              >
                {muted ? <MicOff size={24} /> : <Mic size={24} />}
              </button>
              <button
                className="discussion-call-action end"
                type="button"
                aria-label="End voice discussion"
                title="End voice discussion"
                onClick={() => {
                  pendingVoicePanelFocusRef.current = true;
                  stopVoice();
                  changePhoneSnap("half");
                }}
              >
                <Square size={21} />
              </button>
            </div>
          </section>
        ) : null}

        <div className="discussion-content">
          <header className="discussion-header">
            <div>
              <span className="discussion-eyebrow">
                <MessageCircle size={15} />
                Article discussion
              </span>
              <h3 id={headingId}>Discuss this article</h3>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Close discussion"
              title="Close discussion"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </header>

          {scope.kind === "selection" ? (
            <div className="discussion-scope-card">
              <strong>Attached to your next question</strong>
              <p>“{shortSelection(scope.text)}”</p>
              <button type="button" onClick={onSwitchToWhole}>
                Remove passage
              </button>
            </div>
          ) : (
            <div className="discussion-scope-card whole">
              <p>Questions use the entire article unless you attach a passage.</p>
            </div>
          )}

        <section className="voice-panel" aria-label="Voice discussion">
          <div className="voice-panel-copy">
            <span
              className={`voice-orb ${voiceActive ? "active" : ""}`}
              aria-hidden="true"
            >
              <AudioLines size={20} />
            </span>
            <div>
              <strong>Pure voice</strong>
              <span role="status" aria-live="polite" aria-atomic="true">
                {voiceError ?? voiceContextNote ?? voiceStateLabel(voiceState)}
              </span>
            </div>
          </div>
          <div className="voice-actions">
            {voiceState === "connecting" ? (
              <button
                className="secondary-button voice-start"
                type="button"
                disabled
              >
                <Mic size={17} />
                Connecting…
              </button>
            ) : voiceConnected ? (
              <>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                  aria-pressed={muted}
                  title={muted ? "Unmute microphone" : "Mute microphone"}
                  onClick={toggleMute}
                >
                  {muted ? <MicOff size={17} /> : <Mic size={17} />}
                </button>
                <button
                  className="icon-button voice-stop"
                  type="button"
                  aria-label="Stop voice discussion"
                  title="Stop voice discussion"
                  onClick={() => {
                    pendingVoicePanelFocusRef.current = true;
                    stopVoice();
                  }}
                >
                  <Square size={15} />
                </button>
              </>
            ) : (
              <button
                className="secondary-button voice-start"
                type="button"
                onClick={() => void startVoice()}
              >
                <Mic size={17} />
                Start voice
              </button>
            )}
          </div>
        </section>

        <div
          className="discussion-messages"
          role="log"
          aria-label={`Conversation about ${articleTitle}`}
          aria-live={announceConversationUpdates ? "polite" : "off"}
          aria-busy={isLoading || undefined}
          aria-relevant="additions text"
        >
          {historyHasMore ? (
            <div className="discussion-history-note">
              Showing the 200 most recent messages.
            </div>
          ) : null}
          {isLoading && messages.length === 0 ? (
            <div className="discussion-empty" role="status">
              <MessageCircle size={25} />
              <strong>Loading your conversation…</strong>
              <span>This article’s typed discussion syncs to your account.</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="discussion-empty">
              <MessageCircle size={25} />
              <strong>
                {scope.kind === "selection"
                  ? "Ask about only this passage"
                  : "Ask anything grounded in this article"}
              </strong>
              <span>Typed replies use Sol with medium reasoning.</span>
            </div>
          ) : (
            messages.map((message) => (
              <div
                className={`discussion-message ${message.role} ${message.status}`}
                key={message.id}
              >
                <span>{message.role === "assistant" ? "Sol" : "You"}</span>
                {message.role === "user" && message.selection ? (
                  <blockquote>
                    Attached passage: “{shortSelection(message.selection)}”
                  </blockquote>
                ) : null}
                {message.status === "pending" ? (
                  <div className="thinking-dots" aria-label="Sol is thinking">
                    <i />
                    <i />
                    <i />
                  </div>
                ) : message.status === "error" ? (
                  <p>Reply interrupted. Send the question again.</p>
                ) : (
                  <p>{message.content}</p>
                )}
              </div>
            ))
          )}
          {isSending ? (
            <div
              className="discussion-message assistant pending"
              aria-label="Sol is thinking"
            >
              <span>Sol</span>
              <div className="thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        {(contextNote || error) && (
          <div
            className={error ? "discussion-notice error" : "discussion-notice"}
            role="status"
          >
            {error ?? contextNote}
          </div>
        )}

        <form className="discussion-composer" onSubmit={submitMessage}>
          <textarea
            key={focusComposerRequest}
            ref={inputRef}
            autoFocus={focusComposerThisRender}
            rows={2}
            maxLength={4_000}
            value={draft}
            placeholder={
              scope.kind === "selection"
                ? "Ask about the selected passage…"
                : "Ask about this article…"
            }
            aria-label="Discussion message"
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => {
              if (resolvedMode === "sheet") {
                changePhoneSnap("expanded");
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button
            className="discussion-send"
            type="submit"
            disabled={isLoading || isSending || !draft.trim()}
            aria-label="Send message"
            title="Send message"
          >
            <ArrowUp size={19} />
          </button>
        </form>
        </div>
      </aside>
    </>
  );
}

function useResolvedDiscussionMode(mode?: ArticleDiscussionMode) {
  const [automaticMode, setAutomaticMode] =
    useState<ArticleDiscussionMode>("dock");

  useEffect(() => {
    if (mode) {
      return;
    }

    const sheetQuery = window.matchMedia("(max-width: 700px)");
    const updateMode = () => {
      setAutomaticMode(sheetQuery.matches ? "sheet" : "dock");
    };

    updateMode();
    sheetQuery.addEventListener("change", updateMode);

    return () => {
      sheetQuery.removeEventListener("change", updateMode);
    };
  }, [mode]);

  return mode ?? automaticMode;
}

function phoneSnapLabel(snap: ArticleDiscussionPhoneSnap) {
  const labels: Record<ArticleDiscussionPhoneSnap, string> = {
    compact: "Compact",
    half: "Half height",
    expanded: "Expanded",
  };

  return labels[snap];
}

function useArticleVoice({
  articleId,
  scope,
  onBeforeStart,
}: {
  articleId: string;
  scope: ArticleDiscussionScope;
  onBeforeStart: () => void;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextNote, setContextNote] = useState<string | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef(0);

  const releaseResources = useCallback(() => {
    fetchControllerRef.current?.abort();
    fetchControllerRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    sessionRef.current += 1;
    releaseResources();
    setMuted(false);
    setError(null);
    setContextNote(null);
    setState("idle");
  }, [releaseResources]);

  const fail = useCallback(
    (message: string, session: number) => {
      if (sessionRef.current !== session) {
        return;
      }

      sessionRef.current += 1;
      releaseResources();
      setMuted(false);
      setError(message);
      setState("error");
    },
    [releaseResources],
  );

  useEffect(() => stop, [articleId, scope, stop]);

  useEffect(() => {
    const stopOnPageHide = () => stop();
    window.addEventListener("pagehide", stopOnPageHide);
    return () => window.removeEventListener("pagehide", stopOnPageHide);
  }, [stop]);

  const start = useCallback(async () => {
    if (state === "connecting" || peerRef.current) {
      return;
    }

    const session = sessionRef.current + 1;
    sessionRef.current = session;
    setState("connecting");
    setError(null);
    setContextNote(null);
    onBeforeStart();

    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
        throw new Error("This browser does not support live voice discussion.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sessionRef.current !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      const audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audioRef.current = audio;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => {
          fail(
            "Browser audio did not start. Try Start voice again and allow audio playback.",
            session,
          );
        });
      };
      peer.onconnectionstatechange = () => {
        if (sessionRef.current !== session) {
          return;
        }

        if (peer.connectionState === "connected") {
          setState("listening");
        } else if (
          ["failed", "closed", "disconnected"].includes(peer.connectionState)
        ) {
          fail(
            "The voice connection ended. You can start a new session.",
            session,
          );
        }
      };

      const events = peer.createDataChannel("oai-events");
      events.onopen = () => {
        if (sessionRef.current === session) {
          setState("listening");
        }
      };
      events.onmessage = (event) => {
        if (sessionRef.current !== session) {
          return;
        }

        const type = realtimeEventType(event.data);

        if (type === "input_audio_buffer.speech_started") {
          setState("listening");
        } else if (
          type === "input_audio_buffer.speech_stopped" ||
          type === "response.created"
        ) {
          setState("thinking");
        } else if (
          type.includes("output_audio.delta") ||
          type.includes("audio.delta")
        ) {
          setState("speaking");
        } else if (type === "response.done") {
          setState("listening");
        } else if (type === "error") {
          fail(
            "The live voice session reported an error. You can try again.",
            session,
          );
        }
      };
      events.onerror = () => {
        if (sessionRef.current === session) {
          fail(
            "The live voice event channel failed. You can try again.",
            session,
          );
        }
      };
      events.onclose = () => {
        if (
          sessionRef.current === session &&
          peer.connectionState !== "closed"
        ) {
          fail(
            "The live voice event channel closed. You can try again.",
            session,
          );
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      const form = new FormData();
      form.set("sdp", offer.sdp ?? "");
      form.set("articleId", articleId);
      form.set("scope", scope.kind);
      if (scope.kind === "selection") {
        form.set("selection", scope.text);
      }

      const fetchController = new AbortController();
      fetchControllerRef.current = fetchController;
      const response = await fetch("/api/realtime/calls", {
        method: "POST",
        body: form,
        signal: fetchController.signal,
      });
      fetchControllerRef.current = null;

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error ?? `Voice setup failed with ${response.status}.`,
        );
      }

      if (response.headers.get("x-ai-reader-context-truncated") === "true") {
        setContextNote(
          "The voice session uses the included portion of this article.",
        );
      }

      const answerSdp = await response.text();
      if (sessionRef.current !== session) {
        return;
      }

      await peer.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
    } catch (startError) {
      if (sessionRef.current !== session) {
        return;
      }

      fail(messageFromError(startError), session);
    }
  }, [articleId, fail, onBeforeStart, scope, state]);

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }, [muted]);

  return {
    state,
    muted,
    error,
    contextNote,
    start,
    stop,
    toggleMute,
  };
}

function realtimeEventType(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  try {
    const event = JSON.parse(value) as { type?: unknown };
    return typeof event.type === "string" ? event.type : "";
  } catch {
    return "";
  }
}

function shortSelection(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 360 ? `${normalized.slice(0, 357)}…` : normalized;
}

function contextNoteFromContext(context?: DiscussionContext) {
  if (!context) {
    return null;
  }

  return (
    context.note ??
    (context.truncated
      ? "The article exceeded the live context limit, so the discussion uses the included portion."
      : null)
  );
}

function latestContextNote(messages: DiscussionMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const note = contextNoteFromContext(messages[index].context);

    if (note) {
      return note;
    }
  }

  return null;
}

function responseMessageFromBody(
  body: DiscussionResponse,
  timestamp: string,
): DiscussionMessage {
  return {
    sequence: `optimistic-${body.requestId}-assistant`,
    id: `${body.requestId}:assistant`,
    requestId: body.requestId,
    role: "assistant",
    status: "complete",
    content: body.reply ?? "",
    ...(body.responseId ? { responseId: body.responseId } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.incomplete !== undefined ? { incomplete: body.incomplete } : {}),
    ...(body.context ? { context: body.context } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function pendingResponseMessage(
  requestId: string,
  timestamp: string,
): DiscussionMessage {
  return {
    sequence: `optimistic-${requestId}-assistant`,
    id: `${requestId}:assistant-pending`,
    requestId,
    role: "assistant",
    status: "pending",
    content: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function focusableElements(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        "button:not([disabled])",
        "textarea:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "a[href]",
        '[tabindex]:not([tabindex="-1"])',
      ].join(","),
    ),
  ).filter((element) => !element.hasAttribute("inert"));
}

function voiceStateLabel(state: VoiceState) {
  const labels: Record<VoiceState, string> = {
    idle: "Talk naturally with a speech-to-speech model.",
    connecting: "Connecting microphone…",
    listening: "Listening — ask about the article.",
    thinking: "Thinking…",
    speaking: "Speaking — interrupt anytime.",
    error: "Voice is stopped. You can try again.",
  };

  return labels[state];
}

function messageId() {
  return (
    crypto.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
