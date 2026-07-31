"use client";

import {
  ChevronLeft,
  BookOpen,
  CloudDownload,
  Download,
  FileText,
  Link as LinkIcon,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Share2,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  ArticleDiscussion,
  type ArticleDiscussionScope,
} from "@/components/ArticleDiscussion";
import { AuthSignOutButton } from "@/components/AuthSignOutButton";
import {
  annotateBlocks,
  type AnnotatedBlock,
  type SentenceSegment,
} from "@/lib/sentences";
import type { Article, ArticleSummary, SourceType } from "@/lib/types";

type ArticleListResponse = {
  articles: ArticleSummary[];
};

type ArticleResponse = {
  article: Article;
  summary?: ArticleSummary;
};

type ImportResponse = {
  article: Article;
  summary: ArticleSummary;
};

type PendingImport = {
  id: string;
  title: string;
  detail: string;
  sourceType: SourceType;
};

type AuthStatusResponse = {
  enabled: boolean;
  configured: boolean;
  authenticated: boolean;
  authorized: boolean;
  email?: string;
};

type IntegrationFolder = {
  id?: string | number;
  folderId?: string | number;
  folder_id?: string | number;
  title?: string;
  displayTitle?: string;
  display_title?: string;
  count?: number;
};

type IntegrationProviderStatus = {
  configured?: boolean;
  connected?: boolean;
  username?: string;
  account?: string;
  folder?: string;
  folders?: IntegrationFolder[];
  message?: string;
};

type IntegrationStatusResponse = {
  instapaper?: IntegrationProviderStatus;
  dropbox?: IntegrationProviderStatus;
};

type IntegrationSyncResponse = {
  imported: number;
  deduplicated: number;
  reconciled: number;
  failed: number;
  skipped: number;
  remaining: number;
  possiblyTruncated?: boolean;
  failures?: Array<{
    externalId: string;
    title: string;
    error: string;
  }>;
  message?: string;
};

type IntegrationProvider = "instapaper" | "dropbox";

const integrationBatchSize = 5;
const wholeArticleDiscussionScope: ArticleDiscussionScope = { kind: "whole" };
const maxDiscussionSelectionCharacters = 24_000;

type SelectionDiscussionAction = {
  text: string;
  left: number;
  top: number;
  tooLong: boolean;
};

type AppView = "library" | "reader" | "settings";

type AppHistoryEntry = {
  view: AppView;
  articleId?: string;
  depth: number;
};

const historyMetadataStorageKey = "ai-reader:history-metadata";

type HistoryMetadata = {
  resolvedIds: Array<[string, string | null]>;
  unavailableIds: string[];
};

function readHistoryMetadata(): HistoryMetadata {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(historyMetadataStorageKey) ?? "{}",
    ) as Partial<HistoryMetadata>;
    return {
      resolvedIds: Array.isArray(value.resolvedIds)
        ? value.resolvedIds.filter(
            (entry): entry is [string, string | null] =>
              Array.isArray(entry) &&
              typeof entry[0] === "string" &&
              (typeof entry[1] === "string" || entry[1] === null),
          )
        : [],
      unavailableIds: Array.isArray(value.unavailableIds)
        ? value.unavailableIds.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    };
  } catch {
    return { resolvedIds: [], unavailableIds: [] };
  }
}

function persistHistoryMetadata(
  resolvedIds: Map<string, string | null>,
  unavailableIds: Set<string>,
) {
  try {
    const metadata: HistoryMetadata = {
      resolvedIds: Array.from(resolvedIds.entries()).slice(-100),
      unavailableIds: Array.from(unavailableIds).slice(-100),
    };
    window.sessionStorage.setItem(
      historyMetadataStorageKey,
      JSON.stringify(metadata),
    );
  } catch {
    // History repair is best effort when storage is unavailable.
  }
}

function appHistoryEntry(state: unknown): AppHistoryEntry | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const entry = (state as { aiReader?: unknown }).aiReader;

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Partial<AppHistoryEntry>;

  if (
    !["library", "reader", "settings"].includes(candidate.view ?? "") ||
    typeof candidate.depth !== "number"
  ) {
    return null;
  }

  if (candidate.view === "reader" && !candidate.articleId) {
    return null;
  }

  return candidate as AppHistoryEntry;
}

function writeAppHistory(mode: "push" | "replace", entry: AppHistoryEntry) {
  const currentState = window.history.state;
  const preservedState =
    currentState && typeof currentState === "object" ? currentState : {};
  const nextState = { ...preservedState, aiReader: entry };

  if (mode === "push") {
    window.history.pushState(nextState, "", window.location.href);
  } else {
    window.history.replaceState(nextState, "", window.location.href);
  }
}

export function ReaderApp() {
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [pendingImports, setPendingImports] = useState<PendingImport[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<string | null>("Loading library...");
  const [error, setError] = useState<string | null>(null);
  const [articleLoadError, setArticleLoadError] = useState<string | null>(null);
  const [articleLoadAttempt, setArticleLoadAttempt] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [isArticleLoading, setIsArticleLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [currentSentence, setCurrentSentence] = useState(0);
  const [rate, setRate] = useState(1);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [integrationStatus, setIntegrationStatus] =
    useState<IntegrationStatusResponse | null>(null);
  const [integrationStatusError, setIntegrationStatusError] = useState<
    string | null
  >(null);
  const [integrationNotice, setIntegrationNotice] = useState<string | null>(
    null,
  );
  const [instapaperFolder, setInstapaperFolder] = useState("unread");
  const [syncingIntegration, setSyncingIntegration] =
    useState<IntegrationProvider | null>(null);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [discussionScope, setDiscussionScope] =
    useState<ArticleDiscussionScope>(wholeArticleDiscussionScope);
  const [selectionDiscussionAction, setSelectionDiscussionAction] =
    useState<SelectionDiscussionAction | null>(null);
  const [appView, setAppView] = useState<AppView>("library");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const articleBodyRef = useRef<HTMLElement | null>(null);
  const libraryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const settingsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const readerBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const hasMountedRef = useRef(false);
  const articleIdRef = useRef<string | null>(null);
  const scrollPositionsRef = useRef<Record<AppView, number>>({
    library: 0,
    reader: 0,
    settings: 0,
  });
  const resolvedHistoryIdsRef = useRef(new Map<string, string | null>());
  const unavailableArticleIdsRef = useRef(new Set<string>());
  const sentencesRef = useRef<SentenceSegment[]>([]);
  const speechSessionRef = useRef(0);
  const lastTapRef = useRef<{ index: number; time: number } | null>(null);
  const rateRef = useRef(rate);
  const restoredArticleIdRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const metadata = readHistoryMetadata();
    resolvedHistoryIdsRef.current = new Map(metadata.resolvedIds);
    unavailableArticleIdsRef.current = new Set(metadata.unavailableIds);
  }, []);

  const annotated = useMemo(() => {
    if (!article) {
      return {
        blocks: [] as AnnotatedBlock[],
        sentences: [] as SentenceSegment[],
      };
    }

    return annotateBlocks(article.blocks);
  }, [article]);

  const selectedPendingImport =
    pendingImports.find((pendingImport) => pendingImport.id === selectedId) ??
    null;
  const libraryItems = useMemo(
    () => [
      ...pendingImports.map((pendingImport) => ({
        kind: "pending" as const,
        pendingImport,
      })),
      ...articles.map((articleSummary) => ({
        kind: "article" as const,
        articleSummary,
      })),
    ],
    [articles, pendingImports],
  );

  useEffect(() => {
    articleIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (appView === "reader") {
      restoredArticleIdRef.current = null;
    }
  }, [appView, selectedId]);

  useEffect(() => {
    scrollPositionsRef.current.reader = 0;
  }, [selectedId]);

  useEffect(() => {
    const shouldRestoreFocus = hasMountedRef.current;
    hasMountedRef.current = true;

    if (shouldRestoreFocus) {
      const savedPosition = scrollPositionsRef.current[appView];
      window.scrollTo({ top: savedPosition });
    }

    const focusFrame = window.requestAnimationFrame(() => {
      if (!shouldRestoreFocus) {
        return;
      }

      const target =
        appView === "library"
          ? libraryHeadingRef.current
          : appView === "settings"
            ? settingsHeadingRef.current
            : readerBackButtonRef.current;
      target?.focus({ preventScroll: true });
    });

    const rememberScrollPosition = () => {
      scrollPositionsRef.current[appView] = window.scrollY;
    };
    window.addEventListener("scroll", rememberScrollPosition, {
      passive: true,
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("scroll", rememberScrollPosition);
    };
  }, [appView]);

  useEffect(() => {
    setDiscussionOpen(false);
    setDiscussionScope(wholeArticleDiscussionScope);
    setSelectionDiscussionAction(null);
  }, [selectedId]);

  useEffect(() => {
    if (!selectionDiscussionAction) {
      return;
    }

    const dismissSelectionAction = () => setSelectionDiscussionAction(null);
    const dismissIfSelectionCleared = () => {
      if (window.getSelection()?.isCollapsed) {
        dismissSelectionAction();
      }
    };

    window.addEventListener("resize", dismissSelectionAction);
    document.addEventListener("scroll", dismissSelectionAction, true);
    document.addEventListener("selectionchange", dismissIfSelectionCleared);

    return () => {
      window.removeEventListener("resize", dismissSelectionAction);
      document.removeEventListener("scroll", dismissSelectionAction, true);
      document.removeEventListener(
        "selectionchange",
        dismissIfSelectionCleared,
      );
    };
  }, [selectionDiscussionAction]);

  useEffect(() => {
    sentencesRef.current = annotated.sentences;
  }, [annotated.sentences]);

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  const loadArticles = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setStatus("Refreshing library...");
    }

    try {
      const data = await requestJson<ArticleListResponse>("/api/articles");
      setArticles(data.articles);
      setStatus(null);
      setError(null);
    } catch (loadError) {
      setError(messageFromError(loadError));
      setStatus(null);
    }
  }, []);

  const loadIntegrationStatus = useCallback(async () => {
    try {
      const data = await requestJson<IntegrationStatusResponse>(
        "/api/integrations/status",
      );
      setIntegrationStatus(data);
      setIntegrationStatusError(null);
    } catch (loadError) {
      setIntegrationStatusError(messageFromError(loadError));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadAuthStatus() {
      const response = await fetch("/api/auth/me");

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as AuthStatusResponse;

      if (!cancelled) {
        setAuthStatus(data);
      }
    }

    void loadAuthStatus().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadArticles(true);
    const interval = window.setInterval(() => void loadArticles(false), 15000);

    return () => window.clearInterval(interval);
  }, [loadArticles]);

  useEffect(() => {
    void loadIntegrationStatus();
  }, [loadIntegrationStatus]);

  useEffect(() => {
    if (!selectedId) {
      setArticle(null);
      setArticleLoadError(null);
      return;
    }

    if (selectedPendingImport) {
      setArticle(null);
      setIsArticleLoading(false);
      setArticleLoadError(null);
      return;
    }

    if (article?.id === selectedId) {
      setIsArticleLoading(false);
      setArticleLoadError(null);
      return;
    }

    let cancelled = false;

    async function loadArticle() {
      setIsArticleLoading(true);
      setArticleLoadError(null);
      try {
        const data = await requestJson<ArticleResponse>(
          `/api/articles/${selectedId}`,
        );
        if (cancelled) {
          return;
        }

        setArticle(data.article);
        setCurrentSentence(data.article.progress.sentenceIndex);
        setArticleLoadError(null);
      } catch (loadError) {
        if (!cancelled) {
          setArticleLoadError(messageFromError(loadError));
          setArticle(null);
        }
      } finally {
        if (!cancelled) {
          setIsArticleLoading(false);
        }
      }
    }

    void loadArticle();

    return () => {
      cancelled = true;
    };
  }, [article?.id, articleLoadAttempt, selectedId, selectedPendingImport]);

  useEffect(() => {
    if (
      appView !== "reader" ||
      !article ||
      restoredArticleIdRef.current === article.id
    ) {
      return;
    }

    restoredArticleIdRef.current = article.id;
    window.requestAnimationFrame(() => {
      const activeSentence = document.querySelector<HTMLElement>(
        `[data-sentence-index="${article.progress.sentenceIndex}"]`,
      );
      activeSentence?.scrollIntoView({ block: "center", behavior: "instant" });
    });
  }, [appView, article]);

  const saveProgress = useCallback(async (sentenceIndex: number) => {
    const id = articleIdRef.current;

    if (!id) {
      return;
    }

    const sentenceCount = sentencesRef.current.length;

    const data = await requestJson<ArticleResponse>(`/api/articles/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        progress: {
          sentenceIndex,
          percent: progressPercentForSentence(sentenceIndex, sentenceCount),
        },
      }),
    });

    setArticle((current) => (current?.id === id ? data.article : current));

    if (data.summary) {
      setArticles((current) =>
        current.map((item) => (item.id === id ? (data.summary ?? item) : item)),
      );
    }
  }, []);

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioRef.current = null;
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const speakWithBrowser = useCallback((text: string, onEnd: () => void) => {
    if (!("speechSynthesis" in window)) {
      throw new Error("No speech engine is available.");
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rateRef.current;
    utterance.onend = onEnd;
    utterance.onerror = () => onEnd();
    window.speechSynthesis.speak(utterance);
  }, []);

  const playElevenLabsAudio = useCallback(
    async (text: string, session: number) => {
      const articleId = articleIdRef.current;
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text, articleId }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error ?? `TTS request failed with ${response.status}.`,
        );
      }

      const costUsd = Number(
        response.headers.get("x-processing-cost-usd") ?? 0,
      );
      const audioBlob = await response.blob();

      if (speechSessionRef.current !== session) {
        return;
      }

      if (articleId && Number.isFinite(costUsd) && costUsd > 0) {
        setArticle((current) =>
          current?.id === articleId
            ? {
                ...current,
                processingCostUsd: roundCost(
                  (current.processingCostUsd ?? 0) + costUsd,
                ),
              }
            : current,
        );
        setArticles((current) =>
          current.map((item) =>
            item.id === articleId
              ? {
                  ...item,
                  processingCostUsd: roundCost(
                    (item.processingCostUsd ?? 0) + costUsd,
                  ),
                }
              : item,
          ),
        );
      }

      cleanupAudio();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.playbackRate = rateRef.current;
      audioUrlRef.current = audioUrl;
      audioRef.current = audio;

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("Audio playback failed."));
        void audio.play().catch(reject);
      });
    },
    [cleanupAudio],
  );

  const speakFrom = useCallback(
    (sentenceIndex: number) => {
      const sentences = sentencesRef.current;

      if (sentences.length === 0) {
        return;
      }

      const startIndex = Math.min(
        Math.max(sentenceIndex, 0),
        sentences.length - 1,
      );
      const session = speechSessionRef.current + 1;
      speechSessionRef.current = session;
      cleanupAudio();
      window.speechSynthesis.cancel();
      setIsSpeaking(true);
      setError(null);

      const speakAt = async (index: number) => {
        if (speechSessionRef.current !== session) {
          return;
        }

        if (index >= sentencesRef.current.length) {
          setIsSpeaking(false);
          return;
        }

        const segment = sentencesRef.current[index];
        setCurrentSentence(segment.sentenceIndex);
        void saveProgress(segment.sentenceIndex).catch((saveError) => {
          setError(messageFromError(saveError));
        });

        try {
          await playElevenLabsAudio(segment.text, session);
          window.setTimeout(() => void speakAt(index + 1), 80);
        } catch (playbackError) {
          if (speechSessionRef.current !== session) {
            return;
          }

          setError(
            `${messageFromError(playbackError)} Falling back to browser voice.`,
          );
          try {
            speakWithBrowser(segment.text, () =>
              window.setTimeout(() => void speakAt(index + 1), 80),
            );
          } catch (fallbackError) {
            setIsSpeaking(false);
            setError(messageFromError(fallbackError));
          }
        }
      };

      void speakAt(startIndex);
    },
    [cleanupAudio, playElevenLabsAudio, saveProgress, speakWithBrowser],
  );

  const stopSpeaking = useCallback(() => {
    speechSessionRef.current += 1;
    cleanupAudio();
    window.speechSynthesis?.cancel();
    setIsSpeaking(false);
  }, [cleanupAudio]);

  useEffect(() => stopSpeaking, [stopSpeaking]);

  useEffect(() => {
    const applyEntry = (entry: AppHistoryEntry) => {
      stopSpeaking();
      setDiscussionOpen(false);
      setSelectionDiscussionAction(null);
      window.getSelection()?.removeAllRanges();

      if (entry.view === "reader" && entry.articleId) {
        const resolvedId = resolvedHistoryIdsRef.current.get(entry.articleId);
        const articleId = resolvedId ?? entry.articleId;

        if (
          resolvedId === null ||
          unavailableArticleIdsRef.current.has(articleId)
        ) {
          articleIdRef.current = null;
          writeAppHistory("replace", { view: "library", depth: 0 });
          setAppView("library");
          return;
        }

        if (articleId !== entry.articleId) {
          writeAppHistory("replace", { ...entry, articleId });
        }

        articleIdRef.current = articleId;
        setArticleLoadError(null);
        setArticleLoadAttempt((current) => current + 1);
        setSelectedId(articleId);
        setArticle((current) => (current?.id === articleId ? current : null));
      } else {
        articleIdRef.current = null;
      }

      setAppView(entry.view);
    };

    const initialEntry = appHistoryEntry(window.history.state);

    if (initialEntry) {
      applyEntry(initialEntry);
    } else {
      writeAppHistory("replace", { view: "library", depth: 0 });
    }

    const handlePopState = (event: PopStateEvent) => {
      const entry = appHistoryEntry(event.state) ?? {
        view: "library" as const,
        depth: 0,
      };
      applyEntry(entry);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [stopSpeaking]);

  const showLibrary = useCallback(() => {
    stopSpeaking();
    setDiscussionOpen(false);
    setSelectionDiscussionAction(null);
    window.getSelection()?.removeAllRanges();
    articleIdRef.current = null;
    const currentEntry = appHistoryEntry(window.history.state);

    if (currentEntry && currentEntry.depth > 0) {
      window.history.back();
    } else {
      writeAppHistory("replace", { view: "library", depth: 0 });
      setAppView("library");
    }
  }, [stopSpeaking]);

  const replaceWithLibrary = useCallback(() => {
    stopSpeaking();
    setDiscussionOpen(false);
    setSelectionDiscussionAction(null);
    window.getSelection()?.removeAllRanges();
    articleIdRef.current = null;
    writeAppHistory("replace", { view: "library", depth: 0 });
    setAppView("library");
  }, [stopSpeaking]);

  const showSettings = useCallback(() => {
    stopSpeaking();
    setSelectionDiscussionAction(null);
    articleIdRef.current = null;
    const currentDepth = appHistoryEntry(window.history.state)?.depth ?? 0;
    writeAppHistory("push", {
      view: "settings",
      depth: currentDepth + 1,
    });
    setAppView("settings");
  }, [stopSpeaking]);

  const showReader = useCallback((articleId: string) => {
    setError(null);
    setArticleLoadError(null);
    setArticleLoadAttempt((current) => current + 1);
    const currentDepth = appHistoryEntry(window.history.state)?.depth ?? 0;
    writeAppHistory("push", {
      view: "reader",
      articleId,
      depth: currentDepth + 1,
    });
    setSelectedId(articleId);
    setArticle((current) => (current?.id === articleId ? current : null));
    setAppView("reader");
  }, []);

  const handleLibraryItemSelect = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      const row = target.closest<HTMLButtonElement>("[data-article-id]");

      if (!row || !event.currentTarget.contains(row)) {
        return;
      }

      const articleId = row.dataset.articleId;

      if (!articleId) {
        return;
      }

      articleIdRef.current = articleId;
      showReader(articleId);
    },
    [showReader],
  );

  useEffect(() => {
    if (appView === "library" || discussionOpen) {
      return;
    }

    const returnToLibrary = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLSelectElement)
      ) {
        event.preventDefault();
        showLibrary();
      }
    };

    window.addEventListener("keydown", returnToLibrary);
    return () => window.removeEventListener("keydown", returnToLibrary);
  }, [appView, discussionOpen, showLibrary]);

  const resumeFromSentence = useCallback(
    (sentenceIndex: number) => {
      setCurrentSentence(sentenceIndex);
      void saveProgress(sentenceIndex).catch((saveError) => {
        setError(messageFromError(saveError));
      });
      speakFrom(sentenceIndex);
    },
    [saveProgress, speakFrom],
  );

  const handleSentenceTap = useCallback(
    (sentenceIndex: number) => {
      if (!window.getSelection()?.isCollapsed) {
        return;
      }

      const now = Date.now();
      const lastTap = lastTapRef.current;

      if (lastTap?.index === sentenceIndex && now - lastTap.time < 800) {
        resumeFromSentence(sentenceIndex);
        lastTapRef.current = null;
        return;
      }

      lastTapRef.current = {
        index: sentenceIndex,
        time: now,
      };
    },
    [resumeFromSentence],
  );

  const captureArticleSelection = useCallback(() => {
    const root = articleBodyRef.current;
    const selection = window.getSelection();

    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      setSelectionDiscussionAction(null);
      return;
    }

    const { anchorNode, focusNode } = selection;

    if (
      !anchorNode ||
      !focusNode ||
      !root.contains(anchorNode) ||
      !root.contains(focusNode)
    ) {
      setSelectionDiscussionAction(null);
      return;
    }

    const text = selection.toString().replace(/\s+/g, " ").trim();

    if (!text) {
      setSelectionDiscussionAction(null);
      return;
    }

    const bounds = selection.getRangeAt(0).getBoundingClientRect();
    const actionWidth = 212;
    const gutter = 12;
    const aboveSelection = bounds.top - 48;
    const top =
      aboveSelection >= gutter
        ? aboveSelection
        : Math.min(bounds.bottom + 10, window.innerHeight - 50);

    setSelectionDiscussionAction({
      text,
      tooLong: text.length > maxDiscussionSelectionCharacters,
      left: Math.min(
        Math.max(bounds.left + bounds.width / 2 - actionWidth / 2, gutter),
        window.innerWidth - actionWidth - gutter,
      ),
      top,
    });
  }, []);

  const openWholeArticleDiscussion = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelectionDiscussionAction(null);
    setDiscussionScope(wholeArticleDiscussionScope);
    setDiscussionOpen(true);
  }, []);

  const openSelectionDiscussion = useCallback(() => {
    if (!selectionDiscussionAction || selectionDiscussionAction.tooLong) {
      return;
    }

    setDiscussionScope({
      kind: "selection",
      text: selectionDiscussionAction.text,
    });
    setDiscussionOpen(true);
    setSelectionDiscussionAction(null);
    window.getSelection()?.removeAllRanges();
  }, [selectionDiscussionAction]);

  const closeDiscussion = useCallback(() => {
    setDiscussionOpen(false);
  }, []);

  const switchDiscussionToWholeArticle = useCallback(() => {
    setDiscussionScope(wholeArticleDiscussionScope);
  }, []);

  async function handleUrlSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!url.trim()) {
      return;
    }

    setIsImporting(true);
    const pendingImport = pendingImportFromUrl(url.trim());
    setPendingImports((current) => [pendingImport, ...current]);
    articleIdRef.current = pendingImport.id;
    const currentDepth = appHistoryEntry(window.history.state)?.depth ?? 0;
    writeAppHistory("push", {
      view: "reader",
      articleId: pendingImport.id,
      depth: currentDepth + 1,
    });
    setSelectedId(pendingImport.id);
    setAppView("reader");
    setArticle(null);
    setStatus("Parsing URL...");
    setError(null);

    try {
      const data = await requestJson<ImportResponse>("/api/articles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: url.trim() }),
      });

      setPendingImports((current) =>
        current.filter((item) => item.id !== pendingImport.id),
      );
      setArticles((current) => [
        data.summary,
        ...current.filter((item) => item.id !== data.summary.id),
      ]);
      resolvedHistoryIdsRef.current.set(pendingImport.id, data.article.id);
      persistHistoryMetadata(
        resolvedHistoryIdsRef.current,
        unavailableArticleIdsRef.current,
      );
      if (articleIdRef.current === pendingImport.id) {
        const pendingEntry = appHistoryEntry(window.history.state);
        writeAppHistory("replace", {
          view: "reader",
          articleId: data.article.id,
          depth: pendingEntry?.depth ?? 1,
        });
        articleIdRef.current = data.article.id;
        setSelectedId(data.article.id);
        setArticle(data.article);
      }
      setUrl("");
      setStatus(null);
    } catch (submitError) {
      resolvedHistoryIdsRef.current.set(pendingImport.id, null);
      persistHistoryMetadata(
        resolvedHistoryIdsRef.current,
        unavailableArticleIdsRef.current,
      );
      setPendingImports((current) =>
        current.filter((item) => item.id !== pendingImport.id),
      );
      if (articleIdRef.current === pendingImport.id) {
        articleIdRef.current = null;
        setSelectedId(null);
        setArticle(null);
        replaceWithLibrary();
      }
      setError(messageFromError(submitError));
      setStatus(null);
    } finally {
      setIsImporting(false);
    }
  }

  async function handleFileUpload(file: File | undefined) {
    if (!file) {
      return;
    }

    const form = new FormData();
    form.append("file", file);
    const pendingImport = pendingImportFromFile(file);
    setIsImporting(true);
    setPendingImports((current) => [pendingImport, ...current]);
    articleIdRef.current = pendingImport.id;
    const currentDepth = appHistoryEntry(window.history.state)?.depth ?? 0;
    writeAppHistory("push", {
      view: "reader",
      articleId: pendingImport.id,
      depth: currentDepth + 1,
    });
    setSelectedId(pendingImport.id);
    setAppView("reader");
    setArticle(null);
    setStatus(`Parsing ${file.name}...`);
    setError(null);

    try {
      const data = await requestJson<ImportResponse>("/api/articles", {
        method: "POST",
        body: form,
      });

      setPendingImports((current) =>
        current.filter((item) => item.id !== pendingImport.id),
      );
      setArticles((current) => [
        data.summary,
        ...current.filter((item) => item.id !== data.summary.id),
      ]);
      resolvedHistoryIdsRef.current.set(pendingImport.id, data.article.id);
      persistHistoryMetadata(
        resolvedHistoryIdsRef.current,
        unavailableArticleIdsRef.current,
      );
      if (articleIdRef.current === pendingImport.id) {
        const pendingEntry = appHistoryEntry(window.history.state);
        writeAppHistory("replace", {
          view: "reader",
          articleId: data.article.id,
          depth: pendingEntry?.depth ?? 1,
        });
        articleIdRef.current = data.article.id;
        setSelectedId(data.article.id);
        setArticle(data.article);
      }
      setStatus(null);
    } catch (uploadError) {
      resolvedHistoryIdsRef.current.set(pendingImport.id, null);
      persistHistoryMetadata(
        resolvedHistoryIdsRef.current,
        unavailableArticleIdsRef.current,
      );
      setPendingImports((current) =>
        current.filter((item) => item.id !== pendingImport.id),
      );
      if (articleIdRef.current === pendingImport.id) {
        articleIdRef.current = null;
        setSelectedId(null);
        setArticle(null);
        replaceWithLibrary();
      }
      setError(messageFromError(uploadError));
      setStatus(null);
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleIntegrationSync(provider: IntegrationProvider) {
    setSyncingIntegration(provider);
    setIntegrationNotice(
      provider === "instapaper"
        ? "Syncing Instapaper…"
        : "Syncing @Voice from Dropbox…",
    );

    try {
      const endpoint =
        provider === "instapaper"
          ? "/api/integrations/instapaper/sync"
          : "/api/integrations/dropbox/sync";
      const body =
        provider === "instapaper"
          ? { folder: instapaperFolder, batchSize: integrationBatchSize }
          : { batchSize: integrationBatchSize };
      const result = await requestJson<IntegrationSyncResponse>(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      setIntegrationNotice(integrationSyncMessage(provider, result));
      await Promise.all([loadArticles(false), loadIntegrationStatus()]);
    } catch (syncError) {
      setIntegrationNotice(
        `${provider === "instapaper" ? "Instapaper" : "@Voice"} sync failed: ${messageFromError(
          syncError,
        )}`,
      );
    } finally {
      setSyncingIntegration(null);
    }
  }

  async function handleDeleteArticle() {
    if (!selectedId) {
      return;
    }

    const confirmed = window.confirm("Delete this saved article?");

    if (!confirmed) {
      return;
    }

    const deletingId = selectedId;
    stopSpeaking();
    setError(null);

    try {
      await requestJson<{ ok: boolean }>(`/api/articles/${deletingId}`, {
        method: "DELETE",
      });

      unavailableArticleIdsRef.current.add(deletingId);
      persistHistoryMetadata(
        resolvedHistoryIdsRef.current,
        unavailableArticleIdsRef.current,
      );
      setArticles((current) =>
        current.filter((item) => item.id !== deletingId),
      );
      if (articleIdRef.current === deletingId) {
        articleIdRef.current = null;
        setSelectedId(null);
        setArticle(null);
        replaceWithLibrary();
      }
    } catch (deleteError) {
      if (articleIdRef.current === deletingId) {
        setError(messageFromError(deleteError));
      }
    }
  }

  const readableProgress = article ? progressRatio(article) : 0;
  const firstContentBlockIndex = annotated.blocks.findIndex(
    annotatedBlockHasContent,
  );
  const firstContentBlock =
    firstContentBlockIndex >= 0
      ? annotated.blocks[firstContentBlockIndex]
      : undefined;
  const leadingTitleBlock =
    article &&
    firstContentBlock?.type === "heading" &&
    normalizedComparableTitle(firstContentBlock.text) ===
      normalizedComparableTitle(article.title)
      ? firstContentBlock
      : null;
  const visibleArticleBlocks = leadingTitleBlock
    ? annotated.blocks.slice(firstContentBlockIndex + 1)
    : annotated.blocks;
  const instapaperStatus = integrationStatus?.instapaper;
  const dropboxStatus = integrationStatus?.dropbox;
  const instapaperReady = integrationProviderReady(instapaperStatus);
  const dropboxReady = integrationProviderReady(dropboxStatus);
  const instapaperFolders = integrationFolderOptions(instapaperStatus?.folders);

  return (
    <main className={`reader-app view-${appView}`}>
      {appView === "library" ? (
        <section className="library-panel app-surface" aria-label="Library">
          <header className="app-bar library-app-bar">
            <div className="brand-identity">
              <div className="brand-mark" aria-hidden="true">
                <BookOpen size={20} />
              </div>
              <div>
                <h1>AI Reader</h1>
                <p>
                  {libraryCountLabel(articles.length, pendingImports.length)}
                </p>
              </div>
            </div>
            <div className="app-bar-actions">
              <button
                className="icon-button"
                type="button"
                title="Refresh library"
                aria-label="Refresh library"
                onClick={() => void loadArticles(true)}
              >
                <RefreshCw size={18} />
              </button>
              <button
                className="header-text-button"
                type="button"
                aria-label="Settings"
                onClick={showSettings}
              >
                <Settings2 size={18} />
                <span>Settings</span>
              </button>
              {authStatus?.enabled ? (
                <AuthSignOutButton onBeforeSignOut={stopSpeaking} />
              ) : null}
            </div>
          </header>

          <div className="library-page">
            <header className="library-index-header">
              <div>
                <span className="library-eyebrow">Read later</span>
                <h2
                  ref={libraryHeadingRef}
                  id="library-index-title"
                  tabIndex={-1}
                >
                  Library
                </h2>
              </div>
              <span>
                {libraryCountLabel(articles.length, pendingImports.length)}
              </span>
            </header>

            <section className="library-add-panel" aria-label="Add to library">
              <form className="import-form" onSubmit={handleUrlSubmit}>
                <label className="url-field">
                  <LinkIcon size={18} />
                  <span className="visually-hidden">Article URL</span>
                  <input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="Paste an article URL"
                    type="url"
                    disabled={isImporting}
                  />
                </label>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={isImporting || !url.trim()}
                >
                  <Plus size={18} />
                  Save
                </button>
              </form>

              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                aria-hidden="true"
                tabIndex={-1}
                accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm,.mhtml,.mht,.mhtml.zip,.url,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain,text/html,application/xhtml+xml,message/rfc822,application/x-mimearchive,application/zip,application/internet-shortcut"
                onChange={(event) =>
                  void handleFileUpload(event.target.files?.[0])
                }
              />
              <button
                className="secondary-button upload-library-button"
                type="button"
                disabled={isImporting}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={17} />
                Upload document
              </button>
            </section>

            {(status || error) && (
              <div className={error ? "notice error" : "notice"} role="status">
                {error ?? status}
              </div>
            )}

            <nav
              className="article-list"
              aria-labelledby="library-index-title"
              onClick={handleLibraryItemSelect}
            >
              {libraryItems.length === 0 ? (
                <div className="empty-library">
                  <FileText size={24} />
                  <span>Save a URL or upload a document.</span>
                </div>
              ) : (
                libraryItems.map((item) =>
                  item.kind === "pending" ? (
                    <PendingImportRow
                      key={item.pendingImport.id}
                      pendingImport={item.pendingImport}
                      selected={item.pendingImport.id === selectedId}
                    />
                  ) : (
                    <ArticleRow
                      key={item.articleSummary.id}
                      item={item.articleSummary}
                      selected={item.articleSummary.id === selectedId}
                    />
                  ),
                )
              )}
            </nav>
          </div>
        </section>
      ) : null}

      {appView === "settings" ? (
        <section
          className="settings-view app-surface"
          aria-labelledby="settings-view-title"
        >
          <header className="app-bar settings-app-bar">
            <button className="back-button" type="button" onClick={showLibrary}>
              <ChevronLeft size={20} />
              <span>Library</span>
            </button>
            <div className="view-heading">
              <span>AI Reader</span>
              <h1
                ref={settingsHeadingRef}
                id="settings-view-title"
                tabIndex={-1}
              >
                Settings
              </h1>
            </div>
            <span className="app-bar-spacer" aria-hidden="true" />
          </header>

          <div className="settings-page">
            <section
              className="settings-section"
              aria-labelledby="imports-settings-title"
            >
              <div className="settings-section-heading">
                <CloudDownload size={19} />
                <div>
                  <h2 id="imports-settings-title">Imports &amp; sharing</h2>
                  <p>Bring saved reading into one library.</p>
                </div>
              </div>

              <div className="integration-stack">
                <section
                  className="integration-card"
                  aria-labelledby="instapaper-integration-title"
                >
                  <div className="integration-card-header">
                    <div>
                      <h3 id="instapaper-integration-title">Instapaper</h3>
                      <p>
                        {integrationProviderLabel(
                          instapaperStatus,
                          integrationStatusError,
                        )}
                      </p>
                    </div>
                    <span
                      className={
                        instapaperReady
                          ? "integration-badge ready"
                          : "integration-badge"
                      }
                    >
                      {integrationProviderBadgeLabel(
                        instapaperStatus,
                        integrationStatusError,
                      )}
                    </span>
                  </div>
                  <div className="integration-controls">
                    <label>
                      Folder
                      <select
                        value={instapaperFolder}
                        disabled={
                          !instapaperReady || syncingIntegration !== null
                        }
                        onChange={(event) =>
                          setInstapaperFolder(event.target.value)
                        }
                      >
                        {instapaperFolders.map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folder.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="integration-sync-button"
                      type="button"
                      disabled={!instapaperReady || syncingIntegration !== null}
                      onClick={() => void handleIntegrationSync("instapaper")}
                    >
                      <RefreshCw
                        className={
                          syncingIntegration === "instapaper"
                            ? "spin"
                            : undefined
                        }
                        size={15}
                      />
                      Sync
                    </button>
                  </div>
                </section>

                <section
                  className="integration-card"
                  aria-labelledby="dropbox-integration-title"
                >
                  <div className="integration-card-header">
                    <div>
                      <h3 id="dropbox-integration-title">@Voice Reader</h3>
                      <p>
                        {integrationProviderLabel(
                          dropboxStatus,
                          integrationStatusError,
                        )}
                      </p>
                    </div>
                    <span
                      className={
                        dropboxReady
                          ? "integration-badge ready"
                          : "integration-badge"
                      }
                    >
                      {integrationProviderBadgeLabel(
                        dropboxStatus,
                        integrationStatusError,
                      )}
                    </span>
                  </div>
                  <div className="integration-dropbox-row">
                    <span>{dropboxStatus?.folder || "/Apps/@Voice"}</span>
                    <button
                      className="integration-sync-button"
                      type="button"
                      disabled={!dropboxReady || syncingIntegration !== null}
                      onClick={() => void handleIntegrationSync("dropbox")}
                    >
                      <RefreshCw
                        className={
                          syncingIntegration === "dropbox" ? "spin" : undefined
                        }
                        size={15}
                      />
                      Sync
                    </button>
                  </div>
                </section>

                <section
                  className="integration-help"
                  aria-labelledby="share-import-title"
                >
                  <div className="integration-help-title">
                    <Share2 size={16} />
                    <h3 id="share-import-title">Quick save</h3>
                  </div>
                  <p>
                    Install AI Reader on Android to add it to the Share sheet.
                    On iPhone or iPad, use the AI Reader Share Sheet shortcut.
                  </p>
                  <a
                    className="integration-download-link"
                    href="/ai-reader-chrome-extension.zip"
                    download
                  >
                    <Download size={15} />
                    Download Chrome extension
                  </a>
                </section>

                {(integrationNotice || integrationStatusError) && (
                  <p
                    className={
                      !integrationNotice && integrationStatusError
                        ? "integration-message error"
                        : "integration-message"
                    }
                    role="status"
                  >
                    {integrationNotice ??
                      `Integration status unavailable: ${integrationStatusError}`}
                  </p>
                )}
              </div>
            </section>

            <section
              className="settings-section"
              aria-labelledby="tts-settings-title"
            >
              <div className="settings-section-heading">
                <Volume2 size={19} />
                <div>
                  <h2 id="tts-settings-title">Read aloud</h2>
                  <p>Set the default playback speed.</p>
                </div>
              </div>
              <label className="settings-rate-row">
                <span>Voice speed</span>
                <input
                  min="0.7"
                  max="1.4"
                  step="0.05"
                  type="range"
                  value={rate}
                  onChange={(event) => setRate(Number(event.target.value))}
                />
                <output>{rate.toFixed(2)}×</output>
              </label>
            </section>

            <section
              className="settings-section appearance-summary"
              aria-labelledby="appearance-settings-title"
            >
              <div className="settings-section-heading">
                <Settings2 size={19} />
                <div>
                  <h2 id="appearance-settings-title">Appearance</h2>
                  <p>
                    Sepia paper in light mode and true black in dark mode,
                    following your device.
                  </p>
                </div>
              </div>
            </section>
          </div>
        </section>
      ) : null}

      {appView === "reader" ? (
        <section className="reader-panel app-surface" aria-label="Reader">
          <header className="reader-toolbar">
            <button
              ref={readerBackButtonRef}
              className="back-button reader-back-button"
              type="button"
              aria-label="Back to library"
              onClick={showLibrary}
            >
              <ChevronLeft size={20} />
              <span>Library</span>
            </button>
            <div className="reader-toolbar-context">
              {article ? (
                <span className="source-pill">
                  {sourceLabel(article.sourceType)}
                </span>
              ) : null}
              <span className="reader-toolbar-title">
                {selectedPendingImport?.title ?? article?.title ?? "Reader"}
              </span>
            </div>

            {article && !isArticleLoading ? (
              <div className="reader-actions">
                <button
                  className="secondary-button discuss-article-button"
                  type="button"
                  aria-label="Discuss this article"
                  onClick={openWholeArticleDiscussion}
                >
                  <MessageCircle size={18} />
                  <span>Discuss</span>
                </button>
                <button
                  className="round-button primary"
                  type="button"
                  title={isSpeaking ? "Pause" : "Read aloud"}
                  aria-label={isSpeaking ? "Pause" : "Read aloud"}
                  onClick={() => {
                    if (isSpeaking) {
                      stopSpeaking();
                    } else {
                      speakFrom(currentSentence);
                    }
                  }}
                >
                  {isSpeaking ? <Pause size={20} /> : <Play size={20} />}
                </button>
                <label className="rate-inline" title="Voice speed">
                  <Volume2 size={18} />
                  <span className="visually-hidden">Voice speed</span>
                  <input
                    aria-label="Voice speed"
                    min="0.7"
                    max="1.4"
                    step="0.05"
                    type="range"
                    value={rate}
                    onChange={(event) => setRate(Number(event.target.value))}
                  />
                </label>
                <button
                  className="round-button danger"
                  type="button"
                  title="Delete"
                  aria-label="Delete"
                  onClick={() => void handleDeleteArticle()}
                >
                  <Trash2 size={19} />
                </button>
              </div>
            ) : null}
          </header>

          {(articleLoadError ?? error) ? (
            <div className="reader-inline-notice error" role="status">
              {articleLoadError ?? error}
            </div>
          ) : null}

          {!selectedId ? (
            <div className="reader-empty">
              <BookOpen size={36} />
              <p>Choose an article from your library.</p>
              <button
                className="secondary-button"
                type="button"
                onClick={showLibrary}
              >
                Open library
              </button>
            </div>
          ) : selectedPendingImport ? (
            <ParsingReader pendingImport={selectedPendingImport} />
          ) : articleLoadError && !isArticleLoading && !article ? (
            <div className="reader-empty">
              <BookOpen size={36} />
              <p>Couldn&apos;t open this article.</p>
              <div className="reader-empty-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() =>
                    setArticleLoadAttempt((current) => current + 1)
                  }
                >
                  Try again
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={showLibrary}
                >
                  Back to library
                </button>
              </div>
            </div>
          ) : isArticleLoading || !article ? (
            <div className="reader-empty">
              <RefreshCw className="spin" size={32} />
              <p>Loading article...</p>
            </div>
          ) : (
            <>
              <div
                className="progress-strip"
                role="progressbar"
                aria-label="Reading progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(readableProgress * 100)}
              >
                <span style={{ width: `${readableProgress * 100}%` }} />
              </div>

              <div className="reader-scroll">
                <article
                  ref={articleBodyRef}
                  className="article-body"
                  onPointerUp={captureArticleSelection}
                  onKeyUp={captureArticleSelection}
                >
                  <header className="article-document-header">
                    <div className="article-source-line">
                      <span>{sourceLabel(article.sourceType)}</span>
                      {article.sourceUrl ? (
                        <a
                          href={article.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {sourceDomain(article.sourceUrl)}
                        </a>
                      ) : null}
                    </div>
                    <h1>
                      {leadingTitleBlock ? (
                        <SentenceChunks
                          chunks={leadingTitleBlock.chunks}
                          currentSentence={currentSentence}
                          onSentenceTap={handleSentenceTap}
                        />
                      ) : (
                        article.title
                      )}
                    </h1>
                    <div
                      className="article-meta-row"
                      aria-label="Article metadata"
                    >
                      <span>{article.wordCount.toLocaleString()} words</span>
                      <span>{article.estimatedMinutes} min audio</span>
                      <span>{formatDate(article.createdAt)}</span>
                      <span>
                        {formatCost(article.processingCostUsd ?? 0)} API cost
                      </span>
                    </div>
                  </header>

                  {visibleArticleBlocks.map((block) => (
                    <ArticleBlockView
                      key={block.id}
                      block={block}
                      articleSourceUrl={article.sourceUrl}
                      currentSentence={currentSentence}
                      onSentenceTap={handleSentenceTap}
                    />
                  ))}
                </article>
              </div>
            </>
          )}
        </section>
      ) : null}

      {appView === "reader" && selectionDiscussionAction && !discussionOpen ? (
        <button
          className="selection-discuss-button"
          type="button"
          style={{
            left: selectionDiscussionAction.left,
            top: selectionDiscussionAction.top,
          }}
          disabled={selectionDiscussionAction.tooLong}
          title={
            selectionDiscussionAction.tooLong
              ? "Select a shorter passage (24,000 characters or fewer)."
              : "Discuss only the selected passage"
          }
          onPointerDown={(event) => event.preventDefault()}
          onClick={openSelectionDiscussion}
        >
          <MessageCircle size={16} />
          {selectionDiscussionAction.tooLong
            ? "Select a shorter passage"
            : "Discuss selection"}
        </button>
      ) : null}
      {article ? (
        <ArticleDiscussion
          articleId={article.id}
          articleTitle={article.title}
          open={discussionOpen}
          scope={discussionScope}
          onClose={closeDiscussion}
          onSwitchToWhole={switchDiscussionToWholeArticle}
          onBeforeVoiceStart={stopSpeaking}
        />
      ) : null}
    </main>
  );
}

function ArticleRow({
  item,
  selected,
}: {
  item: ArticleSummary;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      className={`article-row ${selected ? "selected" : ""}`}
      data-article-id={item.id}
    >
      <span className="source-icon" aria-hidden="true">
        {sourceGlyph(item.sourceType)}
      </span>
      <span className="article-row-main">
        <span className="article-row-title">{item.title}</span>
        <span className="article-row-meta">
          {item.sourceUrl
            ? sourceDomain(item.sourceUrl)
            : sourceLabel(item.sourceType)}
          {" · "}
          {item.estimatedMinutes} min
          {" · "}
          {Math.round(progressRatio(item) * 100)}% read
        </span>
        <span className="mini-progress" aria-hidden="true">
          <span style={{ width: `${progressRatio(item) * 100}%` }} />
        </span>
      </span>
    </button>
  );
}

function PendingImportRow({
  pendingImport,
  selected,
}: {
  pendingImport: PendingImport;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      className={`article-row pending ${selected ? "selected" : ""}`}
      data-article-id={pendingImport.id}
      aria-busy="true"
    >
      <span className="source-icon pending" aria-hidden="true">
        <RefreshCw className="spin" size={16} />
      </span>
      <span className="article-row-main">
        <span className="article-row-title">{pendingImport.title}</span>
        <span className="article-row-meta">
          {sourceLabel(pendingImport.sourceType)} · Parsing ·{" "}
          {pendingImport.detail}
        </span>
        <span className="mini-progress indeterminate" aria-hidden="true">
          <span />
        </span>
      </span>
    </button>
  );
}

function ParsingReader({ pendingImport }: { pendingImport: PendingImport }) {
  return (
    <div className="reader-empty parsing-reader" aria-busy="true">
      <RefreshCw className="spin" size={34} />
      <p>Parsing article...</p>
      <span>{pendingImport.title}</span>
    </div>
  );
}

function ArticleBlockView({
  block,
  articleSourceUrl,
  currentSentence,
  onSentenceTap,
}: {
  block: AnnotatedBlock;
  articleSourceUrl?: string;
  currentSentence: number;
  onSentenceTap: (sentenceIndex: number) => void;
}) {
  if (block.type === "heading") {
    const HeadingTag = `h${Math.min(Math.max(block.level, 2), 4)}` as
      "h2" | "h3" | "h4";
    return (
      <HeadingTag>
        <SentenceChunks
          chunks={block.chunks}
          currentSentence={currentSentence}
          onSentenceTap={onSentenceTap}
        />
      </HeadingTag>
    );
  }

  if (block.type === "quote") {
    return (
      <blockquote>
        <SentenceChunks
          chunks={block.chunks}
          currentSentence={currentSentence}
          onSentenceTap={onSentenceTap}
        />
      </blockquote>
    );
  }

  if (block.type === "code") {
    return (
      <pre>
        <code>
          <SentenceChunks
            chunks={block.chunks}
            currentSentence={currentSentence}
            onSentenceTap={onSentenceTap}
          />
        </code>
      </pre>
    );
  }

  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";

    return (
      <ListTag>
        {block.itemChunks.map((chunks, index) => (
          <li key={`${block.id}-${index}`}>
            <SentenceChunks
              chunks={chunks}
              currentSentence={currentSentence}
              onSentenceTap={onSentenceTap}
            />
          </li>
        ))}
      </ListTag>
    );
  }

  if (block.type === "image") {
    const src = block.src
      ? proxiedImageSrc(block.src, articleSourceUrl)
      : undefined;

    return (
      <figure className="article-image-block">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- Article images come from arbitrary reader URLs.
          <img src={src} alt={block.alt} loading="lazy" />
        ) : (
          <div className="image-placeholder" aria-hidden="true">
            Image
          </div>
        )}
        {block.chunks.length > 0 ? (
          <figcaption>
            <SentenceChunks
              chunks={block.chunks}
              currentSentence={currentSentence}
              onSentenceTap={onSentenceTap}
            />
          </figcaption>
        ) : null}
      </figure>
    );
  }

  if (block.type === "table") {
    return (
      <figure className="article-table-block">
        {block.captionChunks.length > 0 ? (
          <figcaption>
            <SentenceChunks
              chunks={block.captionChunks}
              currentSentence={currentSentence}
              onSentenceTap={onSentenceTap}
            />
          </figcaption>
        ) : null}
        <div
          className="table-scroll"
          role="region"
          aria-label={block.caption ?? "Article table"}
        >
          <table>
            <tbody>
              {block.cellChunks.map((row, rowIndex) => (
                <tr key={`${block.id}-row-${rowIndex}`}>
                  {row.map((chunks, cellIndex) => {
                    const CellTag =
                      rowIndex < (block.headerRows ?? 0) ? "th" : "td";

                    return (
                      <CellTag
                        key={`${block.id}-cell-${rowIndex}-${cellIndex}`}
                      >
                        {chunks.length > 0 ? (
                          <SentenceChunks
                            chunks={chunks}
                            currentSentence={currentSentence}
                            onSentenceTap={onSentenceTap}
                          />
                        ) : (
                          "\u00a0"
                        )}
                      </CellTag>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </figure>
    );
  }

  return (
    <p>
      <SentenceChunks
        chunks={block.chunks}
        currentSentence={currentSentence}
        onSentenceTap={onSentenceTap}
      />
    </p>
  );
}

function SentenceChunks({
  chunks,
  currentSentence,
  onSentenceTap,
}: {
  chunks: SentenceSegment[];
  currentSentence: number;
  onSentenceTap: (sentenceIndex: number) => void;
}) {
  return chunks.map((chunk, index) => (
    <span
      key={chunk.sentenceIndex}
      className={`sentence ${chunk.sentenceIndex === currentSentence ? "active" : ""}`}
      data-sentence-index={chunk.sentenceIndex}
      aria-current={
        chunk.sentenceIndex === currentSentence ? "true" : undefined
      }
      role="button"
      tabIndex={0}
      onClick={() => onSentenceTap(chunk.sentenceIndex)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSentenceTap(chunk.sentenceIndex);
        }
      }}
      title="Double-tap to resume"
    >
      {chunk.text}
      {index < chunks.length - 1 ? " " : ""}
    </span>
  ));
}

function integrationProviderReady(status?: IntegrationProviderStatus) {
  return (
    status?.configured === true && status.connected !== false && !status.message
  );
}

function integrationProviderBadgeLabel(
  status: IntegrationProviderStatus | undefined,
  statusError: string | null,
) {
  if (!status && !statusError) {
    return "Checking";
  }

  return integrationProviderReady(status) ? "Ready" : "Setup";
}

function integrationProviderLabel(
  status: IntegrationProviderStatus | undefined,
  statusError: string | null,
) {
  if (!status) {
    return statusError ? "Status unavailable" : "Checking connection…";
  }

  if (integrationProviderReady(status)) {
    return status.username || status.account || status.message || "Connected";
  }

  return status.message || "Credentials required";
}

function integrationFolderOptions(folders: IntegrationFolder[] | undefined) {
  const options = new Map<string, string>([
    ["unread", "Unread"],
    ["starred", "Starred"],
    ["archive", "Archive"],
  ]);

  for (const folder of folders ?? []) {
    const rawId = folder.id ?? folder.folderId ?? folder.folder_id;

    if (rawId === undefined || rawId === null) {
      continue;
    }

    const id = String(rawId);
    const title =
      folder.displayTitle ||
      folder.display_title ||
      folder.title ||
      `Folder ${String(rawId)}`;
    const label =
      typeof folder.count === "number" && folder.count >= 0
        ? `${title} (${folder.count})`
        : title;
    options.set(id, label);
  }

  return Array.from(options, ([id, label]) => ({ id, label }));
}

function integrationSyncMessage(
  provider: IntegrationProvider,
  result: IntegrationSyncResponse,
) {
  const failureDetails = (result.failures ?? [])
    .slice(0, 2)
    .map((failure) => `${failure.title}: ${failure.error}`)
    .join(" · ");
  const detailSuffix = failureDetails ? ` ${failureDetails}` : "";

  if (result.message) {
    return `${result.message}${detailSuffix}`;
  }

  const name = provider === "instapaper" ? "Instapaper" : "@Voice";
  const remaining =
    result.remaining > 0 ? ` · ${result.remaining} remaining` : "";

  return `${name}: ${result.imported} imported · ${result.deduplicated} deduplicated · ${result.reconciled} reconciled · ${result.skipped} skipped · ${result.failed} failed${remaining}${detailSuffix}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as { error?: string };

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.assign(
        `/sign-in?redirect_url=${encodeURIComponent(
          `${window.location.pathname}${window.location.search}`,
        )}`,
      );
    }

    throw new Error(data.error ?? `Request failed with ${response.status}`);
  }

  return data as T;
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function pendingImportFromUrl(rawUrl: string): PendingImport {
  return {
    id: pendingImportId(),
    title: titleFromInputUrl(rawUrl),
    detail: sourceDomain(rawUrl),
    sourceType: "url",
  };
}

function pendingImportFromFile(file: File): PendingImport {
  return {
    id: pendingImportId(),
    title: file.name || "Untitled document",
    detail: "Local document",
    sourceType: sourceTypeFromFileName(file.name),
  };
}

function pendingImportId() {
  return `pending-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function titleFromInputUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const lastPath = decodeURIComponent(
      parsed.pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    return lastPath || parsed.hostname;
  } catch {
    return rawUrl;
  }
}

function sourceTypeFromFileName(fileName: string): SourceType {
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (extension === "pdf") {
    return "pdf";
  }

  if (extension === "docx") {
    return "docx";
  }

  if (extension === "md" || extension === "markdown" || extension === "mdown") {
    return "markdown";
  }

  return "text";
}

function libraryCountLabel(articleCount: number, pendingCount: number) {
  const articleLabel =
    articleCount === 1 ? "1 article" : `${articleCount} articles`;

  if (pendingCount === 0) {
    return articleLabel;
  }

  const pendingLabel =
    pendingCount === 1 ? "1 parsing" : `${pendingCount} parsing`;
  return `${articleLabel} / ${pendingLabel}`;
}

function progressRatio(
  article: Pick<ArticleSummary, "progress" | "sentenceCount">,
) {
  return progressPercentForSentence(
    article.progress.sentenceIndex,
    article.sentenceCount,
  );
}

function progressPercentForSentence(
  sentenceIndex: number,
  sentenceCount: number,
) {
  if (sentenceCount <= 1) {
    return sentenceCount === 1 && sentenceIndex > 0 ? 1 : 0;
  }

  return Math.min(Math.max(sentenceIndex / (sentenceCount - 1), 0), 1);
}

function sourceLabel(sourceType: SourceType) {
  const labels: Record<SourceType, string> = {
    url: "URL",
    pdf: "PDF",
    docx: "DOCX",
    markdown: "Markdown",
    text: "Text",
  };

  return labels[sourceType];
}

function sourceGlyph(sourceType: SourceType) {
  const glyphs: Record<SourceType, string> = {
    url: "URL",
    pdf: "P",
    docx: "D",
    markdown: "M",
    text: "T",
  };

  return glyphs[sourceType];
}

function annotatedBlockHasContent(block: AnnotatedBlock) {
  if (block.type === "list") {
    return block.itemChunks.some((chunks) => chunks.length > 0);
  }

  if (block.type === "table") {
    return (
      block.captionChunks.length > 0 ||
      block.cellChunks.some((row) => row.some((chunks) => chunks.length > 0))
    );
  }

  if (block.type === "image") {
    return Boolean(block.src || block.artifactKey || block.chunks.length > 0);
  }

  return block.chunks.length > 0;
}

function normalizedComparableTitle(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function sourceDomain(sourceUrl: string) {
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return sourceUrl;
  }
}

function formatCost(costUsd: number) {
  if (!Number.isFinite(costUsd) || costUsd <= 0) {
    return "$0.00";
  }

  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

function roundCost(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function proxiedImageSrc(src: string, sourceUrl?: string) {
  try {
    const imageUrl = new URL(src);

    if (!["http:", "https:"].includes(imageUrl.protocol)) {
      return src;
    }

    const params = new URLSearchParams({ url: imageUrl.href });

    if (sourceUrl) {
      params.set("source", sourceUrl);
    }

    return `/api/image?${params.toString()}`;
  } catch {
    return src;
  }
}
