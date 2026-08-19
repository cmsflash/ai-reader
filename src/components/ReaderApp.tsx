"use client";

import {
  Archive,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  BookOpen,
  Check,
  CloudDownload,
  Download,
  FileText,
  Folder,
  FolderInput,
  Link as LinkIcon,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Share2,
  TriangleAlert,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArticleDiscussion,
  type ArticleDiscussionMode,
  type ArticleDiscussionPhoneSnap,
  type ArticleDiscussionScope,
} from "@/components/ArticleDiscussion";
import { AuthSignOutButton } from "@/components/AuthSignOutButton";
import {
  annotateBlocks,
  type AnnotatedBlock,
  type SentenceSegment,
} from "@/lib/sentences";
import {
  articleImageSourceCandidates,
  proxiedImageSrc,
  shouldLoadArticleImageEagerly,
} from "@/lib/articleImage";
import { sentenceHighlightState } from "@/lib/sentenceHighlight";
import {
  browserSpeechPlan,
  detectSpeechLanguage,
  type SpeechLanguage,
} from "@/lib/speechLanguage";
import {
  articleNarrationAudioUrl,
  matchingNarrationCues,
  normalizedNarrationSegments,
  narrationProgressForSentenceIndex,
  narrationSegmentAtTime,
  narrationSentenceIndexAtProgress,
  narrationSentenceIndexAtTime,
  narrationTimeForSentenceIndex,
  narrationTitleSentenceIndex,
} from "@/lib/narrationPlayback";
import {
  appHistoryEntry,
  appUrlForHistoryEntry,
  articleIdFromAppUrl,
  type AppHistoryEntry,
  type AppView,
} from "@/lib/appHistory";
import {
  integrationSyncMaxRequests,
  integrationSyncRequestBatchSize,
  mergeIntegrationSyncResponses,
  shouldContinueIntegrationSync,
  type IntegrationSyncResponse,
} from "@/lib/integrationSync";
import {
  ARTICLE_LIST_MAX_PAGE_SIZE,
  articleMatchesLocation,
  type ArticleImportSummary,
  type ArticleListLocation,
  type ArticleListPageResponse,
  type ArticleListSortMode,
} from "@/lib/articleList";
import type {
  Article,
  ArticleFolder,
  ArticleSummary,
  SourceType,
} from "@/lib/types";

type FolderListResponse = {
  folders: ArticleFolder[];
};

type FolderResponse = {
  folder: ArticleFolder;
};

type ArticleResponse = {
  article: Article;
  summary?: ArticleSummary;
};

type ArticleOrganizationResponse = {
  organization: {
    id: string;
    folderId: string | null;
    archivedAt: string | null;
    updatedAt: string;
  };
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
  status?: "pending" | "failed" | "stalled";
  errorMessage?: string;
  retryUrl?: string;
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

type IntegrationProvider = "instapaper" | "dropbox";

type ArticleActionState = {
  articleId: string;
  left: number;
  top: number;
  view: "actions" | "move";
};

type OrganizationPatch = {
  archived?: boolean;
  folderId?: string;
};

type OrganizationNotice = {
  message: string;
  undo?: {
    articleId: string;
    patch: OrganizationPatch;
    article: ArticleSummary;
  };
};

const wholeArticleDiscussionScope: ArticleDiscussionScope = { kind: "whole" };
const maxDiscussionSelectionCharacters = 24_000;
const articleListPageSize = 30;

type SelectionDiscussionAction = {
  text: string;
  left: number;
  top: number;
  tooLong: boolean;
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

function writeAppHistory(mode: "push" | "replace", entry: AppHistoryEntry) {
  const currentState = window.history.state;
  const preservedState =
    currentState && typeof currentState === "object" ? currentState : {};
  const nextState = { ...preservedState, aiReader: entry };

  const nextUrl = appUrlForHistoryEntry(window.location.href, entry);

  if (mode === "push") {
    window.history.pushState(nextState, "", nextUrl);
  } else {
    window.history.replaceState(nextState, "", nextUrl);
  }
}

export function ReaderApp() {
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [articleTotal, setArticleTotal] = useState(0);
  const [activeArticleTotal, setActiveArticleTotal] = useState(0);
  const [nextArticleCursor, setNextArticleCursor] = useState<string | null>(
    null,
  );
  const [isLoadingMoreArticles, setIsLoadingMoreArticles] = useState(false);
  const [articleListRefreshFailed, setArticleListRefreshFailed] =
    useState(false);
  const [articleListRefreshVersion, setArticleListRefreshVersion] =
    useState(0);
  const [pendingImports, setPendingImports] = useState<PendingImport[]>([]);
  const [queuedImports, setQueuedImports] = useState<ArticleImportSummary[]>(
    [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<string | null>("Loading library...");
  const [error, setError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [articleLoadError, setArticleLoadError] = useState<string | null>(null);
  const [articleLoadAttempt, setArticleLoadAttempt] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [isArticleLoading, setIsArticleLoading] = useState(false);
  const [readerArchiveBusy, setReaderArchiveBusy] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [currentSentence, setCurrentSentence] = useState(0);
  const [contextSentenceIndex, setContextSentenceIndex] = useState<
    number | null
  >(null);
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
  const discussionMode = useArticleDiscussionMode();
  const [discussionPhoneSnap, setDiscussionPhoneSnap] =
    useState<ArticleDiscussionPhoneSnap>("half");
  const [discussionComposerFocusRequest, setDiscussionComposerFocusRequest] =
    useState(0);
  const [selectionDiscussionAction, setSelectionDiscussionAction] =
    useState<SelectionDiscussionAction | null>(null);
  const [appView, setAppView] = useState<AppView>("library");
  const [folders, setFolders] = useState<ArticleFolder[]>([]);
  const [libraryLocation, setLibraryLocation] =
    useState<ArticleListLocation>("default");
  const [librarySort, setLibrarySort] =
    useState<ArticleListSortMode>("saved-desc");
  const [articleActions, setArticleActions] =
    useState<ArticleActionState | null>(null);
  const [articleActionBusy, setArticleActionBusy] = useState(false);
  const [articleActionError, setArticleActionError] = useState<string | null>(
    null,
  );
  const [organizationNotice, setOrganizationNotice] =
    useState<OrganizationNotice | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const articleBodyRef = useRef<HTMLElement | null>(null);
  const libraryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const addHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const settingsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const readerBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const hasMountedRef = useRef(false);
  const articleIdRef = useRef<string | null>(null);
  const scrollPositionsRef = useRef<Record<AppView, number>>({
    library: 0,
    add: 0,
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
  const audioPlaybackCancelRef = useRef<(() => void) | null>(null);
  const activeNarrationArticleIdRef = useRef<string | null>(null);
  const activeNarrationSegmentOffsetRef = useRef(0);
  const narrationResumeRef = useRef<{
    articleId: string;
    currentTime: number;
  } | null>(null);
  const browserVoicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const browserUtterancesRef = useRef<SpeechSynthesisUtterance[]>([]);
  const articleActionReturnFocusRef = useRef<HTMLElement | null>(null);
  const articleListGenerationRef = useRef(0);
  const articleListLoadedCountRef = useRef(0);
  const articleListLoadingMoreRef = useRef(false);
  const articleListNeedsRefreshRef = useRef(false);
  const articleListRequestLimitRef = useRef(articleListPageSize);
  const articleListSentinelRef = useRef<HTMLDivElement | null>(null);

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
  const speechLanguage = useMemo(
    () => (article ? detectSpeechLanguage(article.textContent) : undefined),
    [article],
  );

  const selectedPendingImport =
    pendingImports.find((pendingImport) => pendingImport.id === selectedId) ??
    null;
  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const defaultFolder = useMemo(
    () => folders.find(isDefaultFolder),
    [folders],
  );
  const visibleArticles = useMemo(
    () =>
      libraryLocation === "default" && !defaultFolder
        ? articles
        : articles.filter((articleSummary) =>
            articleMatchesLocation(
              articleSummary,
              libraryLocation,
              defaultFolder?.id,
            ),
          ),
    [articles, defaultFolder, libraryLocation],
  );
  const showPendingImports =
    libraryLocation === "all" || libraryLocation === "default";
  const queuedImportRows = useMemo(
    () => queuedImports.map(pendingImportFromQueue),
    [queuedImports],
  );
  const hasRunningQueuedImports = queuedImports.some(
    (queuedImport) =>
      queuedImport.status === "pending" && !queuedImport.retryable,
  );
  const queuedImportProblemCount = queuedImports.filter(
    (queuedImport) =>
      queuedImport.status === "failed" || queuedImport.retryable,
  ).length;
  const importingCount =
    pendingImports.length + queuedImports.length - queuedImportProblemCount;
  const libraryItems = useMemo(
    () => [
      ...(showPendingImports
        ? pendingImports.map((pendingImport) => ({
            kind: "pending" as const,
            pendingImport,
          }))
        : []),
      ...(showPendingImports
        ? queuedImportRows.map((pendingImport) => ({
            kind: "queued" as const,
            pendingImport,
          }))
        : []),
      ...visibleArticles.map((articleSummary) => ({
        kind: "article" as const,
        articleSummary,
      })),
    ],
    [
      pendingImports,
      queuedImportRows,
      showPendingImports,
      visibleArticles,
    ],
  );
  const actionArticle = articleActions
    ? (articles.find((item) => item.id === articleActions.articleId) ?? null)
    : null;

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
          : appView === "add"
            ? addHeadingRef.current
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
    setDiscussionPhoneSnap("half");
    setSelectionDiscussionAction(null);
    setContextSentenceIndex(null);
  }, [selectedId]);

  useEffect(() => {
    if (contextSentenceIndex === null) {
      return;
    }

    const clearContextSentence = () => setContextSentenceIndex(null);
    const clearContextSentenceOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearContextSentence();
      }
    };

    document.addEventListener("pointerdown", clearContextSentence, true);
    document.addEventListener(
      "keydown",
      clearContextSentenceOnEscape,
      true,
    );

    return () => {
      document.removeEventListener("pointerdown", clearContextSentence, true);
      document.removeEventListener(
        "keydown",
        clearContextSentenceOnEscape,
        true,
      );
    };
  }, [contextSentenceIndex]);

  useEffect(() => {
    if (appView !== "library") {
      setArticleActions(null);
      setArticleActionError(null);
    }

    if (appView !== "reader") {
      setContextSentenceIndex(null);
    }
  }, [appView]);

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
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }, [rate]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) {
      return;
    }

    const refreshBrowserVoices = () => {
      browserVoicesRef.current = window.speechSynthesis.getVoices();
    };

    refreshBrowserVoices();
    window.speechSynthesis.addEventListener(
      "voiceschanged",
      refreshBrowserVoices,
    );

    return () => {
      window.speechSynthesis.removeEventListener(
        "voiceschanged",
        refreshBrowserVoices,
      );
    };
  }, []);

  useEffect(() => {
    articleListLoadedCountRef.current = articles.length;
  }, [articles.length]);

  const loadArticles = useCallback(
    async (showLoading = false, clearExisting = false) => {
      const generation = articleListGenerationRef.current + 1;
      const requestLimit = clearExisting
        ? articleListPageSize
        : Math.min(
            ARTICLE_LIST_MAX_PAGE_SIZE,
            Math.max(articleListPageSize, articleListLoadedCountRef.current),
          );
      articleListGenerationRef.current = generation;
      articleListRequestLimitRef.current = requestLimit;
      articleListLoadingMoreRef.current = false;
      setIsLoadingMoreArticles(false);
      setArticleListRefreshFailed(false);
      setNextArticleCursor(null);

      if (showLoading) {
        setStatus(clearExisting ? "Loading library..." : "Refreshing library...");
      }

      if (clearExisting) {
        setArticles([]);
        setArticleTotal(0);
        setQueuedImports([]);
      }

      try {
        const data = await requestJson<ArticleListPageResponse>(
          articleListUrl(libraryLocation, librarySort, undefined, requestLimit),
        );

        if (articleListGenerationRef.current !== generation) {
          return;
        }

        setArticles(data.articles);
        setQueuedImports(data.imports ?? []);
        setArticleTotal(data.total);
        setActiveArticleTotal(data.activeTotal);
        setNextArticleCursor(data.nextCursor);
        articleListNeedsRefreshRef.current = false;
        setArticleListRefreshFailed(false);
        setStatus(null);
        setError(null);
      } catch (loadError) {
        if (articleListGenerationRef.current !== generation) {
          return;
        }

        setError(messageFromError(loadError));
        setArticleListRefreshFailed(!clearExisting);
        setStatus(null);
      }
    },
    [libraryLocation, librarySort],
  );

  const loadMoreArticles = useCallback(async () => {
    const cursor = nextArticleCursor;

    if (!cursor || articleListLoadingMoreRef.current) {
      return;
    }

    const generation = articleListGenerationRef.current;
    articleListLoadingMoreRef.current = true;
    setIsLoadingMoreArticles(true);

    try {
      const data = await requestJson<ArticleListPageResponse>(
        articleListUrl(
          libraryLocation,
          librarySort,
          cursor,
          articleListRequestLimitRef.current,
        ),
      );

      if (articleListGenerationRef.current !== generation) {
        return;
      }

      setArticles((current) => mergeArticlePages(current, data.articles));
      setQueuedImports(data.imports ?? []);
      setArticleTotal(data.total);
      setActiveArticleTotal(data.activeTotal);
      setNextArticleCursor(data.nextCursor);
      setError(null);
    } catch (loadError) {
      if (articleListGenerationRef.current === generation) {
        setError(messageFromError(loadError));
      }
    } finally {
      if (articleListGenerationRef.current === generation) {
        articleListLoadingMoreRef.current = false;
        setIsLoadingMoreArticles(false);
      }
    }
  }, [libraryLocation, librarySort, nextArticleCursor]);

  const loadFolders = useCallback(async () => {
    try {
      const data = await requestJson<FolderListResponse>("/api/folders");
      setFolders(data.folders);
      setFolderError(null);
    } catch (loadError) {
      setFolderError(messageFromError(loadError));
    }
  }, []);

  const refreshLibrary = useCallback(
    async (showLoading = false) => {
      await Promise.all([loadArticles(showLoading), loadFolders()]);
    },
    [loadArticles, loadFolders],
  );

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
    void loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    void loadArticles(true, true);
  }, [loadArticles]);

  useEffect(() => {
    if (
      appView !== "library" ||
      !showPendingImports ||
      !hasRunningQueuedImports
    ) {
      return;
    }

    let cancelled = false;
    let refreshing = false;
    let pollTimer = 0;

    const refreshQueuedImports = async () => {
      if (refreshing || document.visibilityState !== "visible") {
        return;
      }

      refreshing = true;
      try {
        await loadArticles(false);
      } finally {
        refreshing = false;
      }
    };
    const poll = async () => {
      await refreshQueuedImports();

      if (!cancelled) {
        pollTimer = window.setTimeout(poll, 3_000);
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshQueuedImports();
      }
    };

    pollTimer = window.setTimeout(poll, 3_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [
    appView,
    hasRunningQueuedImports,
    loadArticles,
    showPendingImports,
  ]);

  useEffect(() => {
    if (appView !== "library" || !articleListNeedsRefreshRef.current) {
      return;
    }

    articleListNeedsRefreshRef.current = false;
    void loadArticles(false);
  }, [appView, articleListRefreshVersion, loadArticles]);

  useEffect(() => {
    if (appView === "settings") {
      void loadIntegrationStatus();
    }
  }, [appView, loadIntegrationStatus]);

  useEffect(() => {
    const sentinel = articleListSentinelRef.current;

    if (appView !== "library" || !sentinel || !nextArticleCursor) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreArticles();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [appView, loadMoreArticles, nextArticleCursor]);

  useEffect(() => {
    if (appView !== "reader") {
      setIsArticleLoading(false);
      setArticleLoadError(null);
      return;
    }

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
    const articleId = selectedId;

    async function loadArticle() {
      setIsArticleLoading(true);
      setArticleLoadError(null);
      try {
        const data = await requestJson<ArticleResponse>(
          `/api/articles/${encodeURIComponent(articleId)}`,
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
  }, [
    appView,
    article?.id,
    articleLoadAttempt,
    selectedId,
    selectedPendingImport,
  ]);

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
      articleListNeedsRefreshRef.current = true;
      setArticleListRefreshVersion((current) => current + 1);
    }
  }, []);

  const cleanupAudio = useCallback(() => {
    audioPlaybackCancelRef.current?.();
    audioPlaybackCancelRef.current = null;

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

  const browserUtterance = useCallback(
    (text: string, language?: SpeechLanguage) => {
      if (!("speechSynthesis" in window)) {
        throw new Error("No speech engine is available.");
      }

      const plan = browserSpeechPlan(
        text,
        browserVoicesRef.current.length > 0
          ? browserVoicesRef.current
          : window.speechSynthesis.getVoices(),
        language,
      );
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rateRef.current;

      if (plan.lang) {
        utterance.lang = plan.lang;
      }

      if (plan.voice) {
        utterance.voice = plan.voice;
      }

      return utterance;
    },
    [],
  );

  const releaseBrowserUtterance = useCallback(
    (utterance: SpeechSynthesisUtterance) => {
      browserUtterancesRef.current = browserUtterancesRef.current.filter(
        (queuedUtterance) => queuedUtterance !== utterance,
      );
    },
    [],
  );

  const speakWithBrowser = useCallback(
    (
      text: string,
      language: SpeechLanguage | undefined,
      onEnd: () => void,
    ) => {
      const utterance = browserUtterance(text, language);
      browserUtterancesRef.current.push(utterance);
      utterance.onend = () => {
        releaseBrowserUtterance(utterance);
        onEnd();
      };
      utterance.onerror = () => {
        releaseBrowserUtterance(utterance);
        onEnd();
      };
      window.speechSynthesis.speak(utterance);
    },
    [browserUtterance, releaseBrowserUtterance],
  );

  const speakMandarinFrom = useCallback(
    (startIndex: number, session: number) => {
      const sentences = sentencesRef.current;
      let nextIndex = startIndex;

      const enqueueNext = () => {
        if (
          speechSessionRef.current !== session ||
          nextIndex >= sentences.length
        ) {
          return false;
        }

        const segment = sentences[nextIndex];
        const segmentIndex = nextIndex;
        nextIndex += 1;
        const utterance = browserUtterance(segment.text);
        browserUtterancesRef.current.push(utterance);

        utterance.onstart = () => {
          if (speechSessionRef.current !== session) {
            return;
          }

          setCurrentSentence(segment.sentenceIndex);
          void saveProgress(segment.sentenceIndex).catch((saveError) => {
            setError(messageFromError(saveError));
          });
        };
        utterance.onend = () => {
          releaseBrowserUtterance(utterance);

          if (speechSessionRef.current !== session) {
            return;
          }

          const queuedAnother = enqueueNext();

          if (!queuedAnother && segmentIndex === sentences.length - 1) {
            setIsSpeaking(false);
          }
        };
        utterance.onerror = () => {
          releaseBrowserUtterance(utterance);

          if (speechSessionRef.current !== session) {
            return;
          }

          speechSessionRef.current += 1;
          window.speechSynthesis.cancel();
          browserUtterancesRef.current = [];
          setIsSpeaking(false);
          setError("Mandarin voice playback failed.");
        };

        window.speechSynthesis.speak(utterance);
        return true;
      };

      try {
        enqueueNext();
        enqueueNext();
      } catch (speechError) {
        speechSessionRef.current += 1;
        window.speechSynthesis?.cancel();
        browserUtterancesRef.current = [];
        setIsSpeaking(false);
        setError(messageFromError(speechError));
      }
    },
    [browserUtterance, releaseBrowserUtterance, saveProgress],
  );

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

  const playArticleNarration = useCallback(
    async (
      articleToPlay: Article,
      session: number,
      sentenceIndex: number,
      seekToSentence: boolean,
    ) => {
      cleanupAudio();
      const narration = articleToPlay.narration;

      if (!narration) {
        throw new Error("Saved narration is unavailable.");
      }

      const segments = normalizedNarrationSegments(narration);

      if (!segments?.length) {
        throw new Error("Saved narration package is invalid.");
      }

      const resume = narrationResumeRef.current;
      const resumeTime =
        resume?.articleId === articleToPlay.id ? resume.currentTime : 0;
      const narrationCues = matchingNarrationCues(
        narration.alignment,
        sentencesRef.current,
        articleToPlay.title,
        narration.durationSeconds,
      );
      const requestedCueTime = seekToSentence
        ? narrationTimeForSentenceIndex(narrationCues, sentenceIndex)
        : null;
      const requestedProgress = seekToSentence && requestedCueTime === null
        ? narrationProgressForSentenceIndex(
            sentencesRef.current,
            sentenceIndex,
          )
        : null;
      let lastSavedSentence = -1;
      let lastSavedAudioTime = Number.NEGATIVE_INFINITY;
      const totalDuration =
        narration.durationSeconds ??
        segments.reduce(
          (duration, segment) =>
            Math.max(
              duration,
              segment.startSeconds + segment.durationSeconds,
            ),
          0,
        );
      const requestedGlobalTime =
        requestedCueTime ??
        (requestedProgress === null
          ? resumeTime
          : requestedProgress * totalDuration);
      const start = narrationSegmentAtTime(segments, requestedGlobalTime) ?? {
        segment: segments[0],
        localTime: 0,
      };
      const startOffset = segments.findIndex(
        (segment) => segment.index === start.segment.index,
      );

      narrationResumeRef.current = null;
      activeNarrationArticleIdRef.current = articleToPlay.id;

      const updateNarrationProgress = (
        audio: HTMLAudioElement,
        segmentStartSeconds: number,
        complete = false,
      ) => {
        if (speechSessionRef.current !== session) {
          return;
        }

        const globalTime = complete
          ? totalDuration
          : Math.min(
              Math.max(segmentStartSeconds + audio.currentTime, 0),
              totalDuration,
            );
        const progress = complete
          ? 1
          : totalDuration > 0
            ? Math.min(Math.max(globalTime / totalDuration, 0), 1)
            : 0;
        const sentenceIndex =
          narrationSentenceIndexAtTime(narrationCues, globalTime) ??
          narrationSentenceIndexAtProgress(sentencesRef.current, progress);

        setCurrentSentence(sentenceIndex);

        if (
          sentenceIndex >= 0 &&
          sentenceIndex !== lastSavedSentence &&
          (complete || globalTime - lastSavedAudioTime >= 5)
        ) {
          lastSavedSentence = sentenceIndex;
          lastSavedAudioTime = globalTime;
          void saveProgress(sentenceIndex).catch((saveError) => {
            setError(messageFromError(saveError));
          });
        }
      };

      let preloadedAudio: HTMLAudioElement | null = null;

      try {
        for (let offset = startOffset; offset < segments.length; offset += 1) {
          if (speechSessionRef.current !== session) {
            return;
          }

          const segment = segments[offset];
          const segmentUrl = articleNarrationAudioUrl(
            articleToPlay.id,
            segments.length > 1 ? segment.index : undefined,
          );
          const audio = preloadedAudio ?? new Audio(segmentUrl);
          const localStart = offset === startOffset ? start.localTime : 0;
          const nextSegment = segments[offset + 1];

          preloadedAudio = nextSegment
            ? new Audio(
                articleNarrationAudioUrl(articleToPlay.id, nextSegment.index),
              )
            : null;

          if (preloadedAudio) {
            preloadedAudio.preload = "auto";
            preloadedAudio.load();
          }

          activeNarrationSegmentOffsetRef.current = segment.startSeconds;
          audio.preload = "auto";
          audio.playbackRate = rateRef.current;
          audioRef.current = audio;

          try {
            await new Promise<void>((resolve, reject) => {
              let playbackConfigured = false;
              let playbackSettled = false;
              const settlePlayback = (error?: unknown) => {
                if (playbackSettled) {
                  return;
                }
                playbackSettled = true;
                if (audioPlaybackCancelRef.current === cancelPlayback) {
                  audioPlaybackCancelRef.current = null;
                }
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              };
              const cancelPlayback = () => settlePlayback();
              const configurePlayback = () => {
                if (playbackConfigured) {
                  return;
                }
                playbackConfigured = true;

                if (localStart > 0 && localStart < audio.duration) {
                  audio.currentTime = localStart;
                }

                updateNarrationProgress(audio, segment.startSeconds);
              };

              audio.onloadedmetadata = configurePlayback;
              audio.ontimeupdate = () =>
                updateNarrationProgress(audio, segment.startSeconds);
              audio.onended = () => {
                if (offset === segments.length - 1) {
                  updateNarrationProgress(audio, totalDuration, true);
                }
                settlePlayback();
              };
              audio.onerror = () =>
                settlePlayback(
                  new Error("Saved narration playback failed."),
                );
              audioPlaybackCancelRef.current = cancelPlayback;

              if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
                configurePlayback();
              } else {
                audio.load();
              }
              // Call play synchronously while the original click still has
              // browser media activation. Metadata configuration can finish
              // before playback begins without postponing this permission.
              void audio.play().catch(settlePlayback);
            });
          } finally {
            audio.onloadedmetadata = null;
            audio.ontimeupdate = null;
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
            if (audioRef.current === audio) {
              audioRef.current = null;
            }
          }
        }
      } finally {
        if (preloadedAudio) {
          preloadedAudio.pause();
          preloadedAudio.removeAttribute("src");
          preloadedAudio.load();
        }
      }
    },
    [cleanupAudio, saveProgress],
  );

  const speakFrom = useCallback(
    (sentenceIndex: number, seekToSentence = false) => {
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
      browserUtterancesRef.current = [];
      setIsSpeaking(true);
      setError(null);

      if (article?.narration) {
        void playArticleNarration(
          article,
          session,
          startIndex,
          seekToSentence,
        )
          .then(() => {
            if (speechSessionRef.current === session) {
              activeNarrationArticleIdRef.current = null;
              narrationResumeRef.current = null;
              cleanupAudio();
              setIsSpeaking(false);
            }
          })
          .catch((playbackError) => {
            if (speechSessionRef.current === session) {
              activeNarrationArticleIdRef.current = null;
              cleanupAudio();
              setIsSpeaking(false);
              setError(messageFromError(playbackError));
            }
          });
        return;
      }

      if (speechLanguage === "zh-CN") {
        speakMandarinFrom(startIndex, session);
        return;
      }

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
            speakWithBrowser(segment.text, undefined, () =>
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
    [
      cleanupAudio,
      article,
      playElevenLabsAudio,
      playArticleNarration,
      saveProgress,
      speakMandarinFrom,
      speakWithBrowser,
      speechLanguage,
    ],
  );

  const stopSpeaking = useCallback(() => {
    speechSessionRef.current += 1;
    const audio = audioRef.current;
    const activeNarrationArticleId = activeNarrationArticleIdRef.current;

    if (
      audio &&
      activeNarrationArticleId &&
      Number.isFinite(audio.currentTime) &&
      activeNarrationSegmentOffsetRef.current + audio.currentTime > 0
    ) {
      narrationResumeRef.current = {
        articleId: activeNarrationArticleId,
        currentTime:
          activeNarrationSegmentOffsetRef.current + audio.currentTime,
      };
    }

    activeNarrationArticleIdRef.current = null;
    activeNarrationSegmentOffsetRef.current = 0;
    cleanupAudio();
    window.speechSynthesis?.cancel();
    browserUtterancesRef.current = [];
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
    const linkedArticleId = articleIdFromAppUrl(window.location.href);

    if (
      linkedArticleId &&
      (initialEntry?.view !== "reader" ||
        initialEntry.articleId !== linkedArticleId)
    ) {
      writeAppHistory("replace", { view: "library", depth: 0 });
      const linkedEntry: AppHistoryEntry = {
        view: "reader",
        articleId: linkedArticleId,
        depth: 1,
      };
      writeAppHistory("push", linkedEntry);
      applyEntry(linkedEntry);
    } else if (initialEntry) {
      writeAppHistory("replace", initialEntry);
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

  const replaceWithAdd = useCallback(() => {
    stopSpeaking();
    setDiscussionOpen(false);
    setSelectionDiscussionAction(null);
    window.getSelection()?.removeAllRanges();
    articleIdRef.current = null;
    const currentDepth = appHistoryEntry(window.history.state)?.depth ?? 1;
    writeAppHistory("replace", { view: "add", depth: currentDepth });
    setAppView("add");
  }, [stopSpeaking]);

  const showAdd = useCallback(() => {
    stopSpeaking();
    setSelectionDiscussionAction(null);
    setError(null);
    articleIdRef.current = null;
    const currentDepth = appHistoryEntry(window.history.state)?.depth ?? 0;
    writeAppHistory("push", {
      view: "add",
      depth: currentDepth + 1,
    });
    setAppView("add");
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

  const closeArticleActions = useCallback((restoreFocus = true) => {
    setArticleActions(null);
    setArticleActionError(null);

    if (restoreFocus) {
      window.requestAnimationFrame(() =>
        articleActionReturnFocusRef.current?.focus({ preventScroll: true }),
      );
    }
  }, []);

  const openArticleActions = useCallback(
    (
      articleId: string,
      left: number,
      top: number,
      returnFocus: HTMLElement,
    ) => {
      articleActionReturnFocusRef.current = returnFocus;
      setArticleActionError(null);
      setArticleActions({ articleId, left, top, view: "actions" });
    },
    [],
  );

  const showMoveActions = useCallback(() => {
    setArticleActionError(null);
    setArticleActions((current) =>
      current ? { ...current, view: "move" } : current,
    );
  }, []);

  const applyOrganizationState = useCallback(
    (
      articleId: string,
      updatedOrganization: ArticleOrganizationResponse["organization"],
      fallbackArticle?: ArticleSummary | Article | null,
    ) => {
      setArticles((current) => {
        const hasArticle = current.some((item) => item.id === articleId);

        if (!hasArticle && fallbackArticle) {
          return [
            articleWithOrganizationState(fallbackArticle, updatedOrganization),
            ...current,
          ];
        }

        return current.map((item) =>
          item.id === articleId
            ? articleWithOrganizationState(item, updatedOrganization)
            : item,
        );
      });
      setArticle((current) =>
        current?.id === articleId
          ? articleWithOrganizationState(current, updatedOrganization)
          : current,
      );
    },
    [],
  );

  const updateOrganization = useCallback(
    async (
      articleId: string,
      organization: OrganizationPatch,
      optimisticArticle?: ArticleSummary | Article | null,
    ) => {
      const previousOrganization = optimisticArticle
        ? organizationStateFromArticle(optimisticArticle)
        : null;

      if (optimisticArticle) {
        applyOrganizationState(
          articleId,
          organizationStateWithPatch(optimisticArticle, organization),
          optimisticArticle,
        );
      }

      try {
        const data = await requestJson<ArticleOrganizationResponse>(
          `/api/articles/${articleId}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ organization }),
          },
        );

        applyOrganizationState(
          articleId,
          data.organization,
          optimisticArticle,
        );
        void loadArticles(false);
        return data.organization;
      } catch (updateError) {
        if (previousOrganization) {
          applyOrganizationState(
            articleId,
            previousOrganization,
            optimisticArticle,
          );
        }

        throw updateError;
      }
    },
    [applyOrganizationState, loadArticles],
  );

  const focusAfterLibraryRemoval = useCallback(
    (articleId: string) => {
      const currentIndex = visibleArticles.findIndex(
        (item) => item.id === articleId,
      );
      const nextItem =
        visibleArticles[currentIndex + 1] ??
        visibleArticles[currentIndex - 1] ??
        null;

      window.requestAnimationFrame(() => {
        const target = nextItem
          ? Array.from(
              document.querySelectorAll<HTMLElement>("[data-article-open-id]"),
            ).find(
              (element) => element.dataset.articleOpenId === nextItem.id,
            )
          : null;
        (target ?? libraryHeadingRef.current)?.focus({ preventScroll: true });
      });
    },
    [visibleArticles],
  );

  const toggleArticleArchive = useCallback(
    async (targetArticle: ArticleSummary | Article) => {
      const { organization, undoPatch, wasArchived } = archiveChangeForArticle(
        targetArticle,
        folderById,
        folders,
      );

      await updateOrganization(
        targetArticle.id,
        organization,
        targetArticle,
      );
      setOrganizationNotice({
        message: wasArchived
          ? `Restored “${targetArticle.title}”.`
          : `Archived “${targetArticle.title}”.`,
        undo: {
          articleId: targetArticle.id,
          patch: undoPatch,
          article: articleWithOrganizationState(
            targetArticle,
            organizationStateWithPatch(targetArticle, organization),
          ),
        },
      });
    },
    [folderById, folders, updateOrganization],
  );

  const handleArchiveFromActions = useCallback(async () => {
    if (!actionArticle) {
      return;
    }

    setArticleActionBusy(true);
    setArticleActionError(null);

    try {
      await toggleArticleArchive(actionArticle);
      closeArticleActions(false);
      focusAfterLibraryRemoval(actionArticle.id);
    } catch (actionError) {
      setArticleActionError(messageFromError(actionError));
    } finally {
      setArticleActionBusy(false);
    }
  }, [
    actionArticle,
    closeArticleActions,
    focusAfterLibraryRemoval,
    toggleArticleArchive,
  ]);

  const moveArticleToFolder = useCallback(
    async (folderId: string, destinationName?: string) => {
      if (!actionArticle) {
        return false;
      }

      const previousFolderId =
        actionArticle.folderId ?? defaultFolder?.id;
      const movingRestores = Boolean(actionArticle.archivedAt);

      if (!previousFolderId) {
        setArticleActionError("Default folder is unavailable.");
        return false;
      }

      if (previousFolderId === folderId && !movingRestores) {
        closeArticleActions();
        return true;
      }

      setArticleActionBusy(true);
      setArticleActionError(null);

      try {
        const currentLocationFolderId = folderIdForLocation(
          libraryLocation,
          defaultFolder?.id,
        );
        const movedOutOfCurrentView =
          (libraryLocation === "archive" && movingRestores) ||
          Boolean(
            currentLocationFolderId && currentLocationFolderId !== folderId,
          );
        await updateOrganization(actionArticle.id, {
          folderId,
          ...(movingRestores ? { archived: false } : {}),
        }, actionArticle);
        const destination =
          destinationName ?? folderById.get(folderId)?.name ?? "folder";
        setOrganizationNotice({
          message: `Moved “${actionArticle.title}” to ${destination}.`,
          undo: {
            articleId: actionArticle.id,
            patch: {
              folderId: previousFolderId,
              ...(movingRestores ? { archived: true } : {}),
            },
            article: articleWithOrganizationState(
              actionArticle,
              organizationStateWithPatch(actionArticle, {
                folderId,
                ...(movingRestores ? { archived: false } : {}),
              }),
            ),
          },
        });
        closeArticleActions(!movedOutOfCurrentView);

        if (movedOutOfCurrentView) {
          focusAfterLibraryRemoval(actionArticle.id);
        }
        return true;
      } catch (actionError) {
        setArticleActionError(messageFromError(actionError));
        return false;
      } finally {
        setArticleActionBusy(false);
      }
    },
    [
      actionArticle,
      closeArticleActions,
      defaultFolder,
      focusAfterLibraryRemoval,
      folderById,
      libraryLocation,
      updateOrganization,
    ],
  );

  const createFolderAndMove = useCallback(
    async (name: string) => {
      setArticleActionBusy(true);
      setArticleActionError(null);

      try {
        const data = await requestJson<FolderResponse>("/api/folders", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ name }),
        });
        setFolders((current) =>
          current.some((folder) => folder.id === data.folder.id)
            ? current
            : [...current, data.folder].sort(compareFolders),
        );
        return await moveArticleToFolder(data.folder.id, data.folder.name);
      } catch (actionError) {
        setArticleActionError(messageFromError(actionError));
        return false;
      } finally {
        setArticleActionBusy(false);
      }
    },
    [moveArticleToFolder],
  );

  const undoOrganizationChange = useCallback(async () => {
    const undo = organizationNotice?.undo;

    if (!undo) {
      return;
    }

    setOrganizationNotice({ message: "Undoing…" });

    try {
      const optimisticArticle =
        articles.find((item) => item.id === undo.articleId) ??
        (article?.id === undo.articleId ? article : undo.article);
      await updateOrganization(undo.articleId, undo.patch, optimisticArticle);
      setOrganizationNotice({ message: "Change undone." });
    } catch (undoError) {
      setOrganizationNotice(null);
      setError(messageFromError(undoError));
    }
  }, [article, articles, organizationNotice?.undo, updateOrganization]);

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
      speakFrom(sentenceIndex, true);
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
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const readerBounds =
      root.closest<HTMLElement>(".reader-panel")?.getBoundingClientRect() ??
      null;
    const actionAreaLeft = Math.max(
      viewportLeft + gutter,
      readerBounds ? readerBounds.left + gutter : viewportLeft + gutter,
    );
    const actionAreaRight = Math.min(
      viewportLeft + viewportWidth - gutter,
      readerBounds
        ? readerBounds.right - gutter
        : viewportLeft + viewportWidth - gutter,
    );
    const maximumActionLeft = Math.max(
      actionAreaLeft,
      actionAreaRight - actionWidth,
    );
    const aboveSelection = bounds.top - 48;
    const top =
      aboveSelection >= viewportTop + gutter
        ? aboveSelection
        : Math.min(
            bounds.bottom + 10,
            viewportTop + viewportHeight - 50,
          );

    setSelectionDiscussionAction({
      text,
      tooLong: text.length > maxDiscussionSelectionCharacters,
      left: Math.min(
        Math.max(
          bounds.left + bounds.width / 2 - actionWidth / 2,
          actionAreaLeft,
        ),
        maximumActionLeft,
      ),
      top,
    });
  }, []);

  const handleSentenceContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const sentence =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(".sentence[data-sentence-index]")
          : null;

      if (!sentence || !event.currentTarget.contains(sentence)) {
        setContextSentenceIndex(null);
        return;
      }

      const sentenceIndex = Number(sentence.dataset.sentenceIndex);
      setContextSentenceIndex(
        Number.isInteger(sentenceIndex) ? sentenceIndex : null,
      );
    },
    [],
  );

  useEffect(() => {
    if (
      appView !== "reader" ||
      (discussionOpen && discussionMode === "overlay")
    ) {
      return;
    }

    let frame = 0;
    const captureOnSelectionChange = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(captureArticleSelection);
    };

    document.addEventListener("selectionchange", captureOnSelectionChange);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener(
        "selectionchange",
        captureOnSelectionChange,
      );
    };
  }, [
    appView,
    captureArticleSelection,
    discussionMode,
    discussionOpen,
  ]);

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
    if (discussionOpen) {
      setDiscussionPhoneSnap("expanded");
      setDiscussionComposerFocusRequest((current) => current + 1);
    }
    setDiscussionOpen(true);
    setSelectionDiscussionAction(null);
    window.getSelection()?.removeAllRanges();
  }, [discussionOpen, selectionDiscussionAction]);

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
    setStatus("Parsing URL...");
    setError(null);
    showLibrary();

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
      setSelectedId((current) =>
        current === pendingImport.id ? data.article.id : current,
      );
      if (articleIdRef.current === pendingImport.id) {
        const pendingEntry = appHistoryEntry(window.history.state);
        writeAppHistory("replace", {
          view: "reader",
          articleId: data.article.id,
          depth: pendingEntry?.depth ?? 1,
        });
        articleIdRef.current = data.article.id;
        setArticle(data.article);
      }
      setUrl("");
      setStatus(null);
      articleListNeedsRefreshRef.current = true;
      void loadArticles(false);
    } catch (submitError) {
      resolvedHistoryIdsRef.current.set(pendingImport.id, null);
      persistHistoryMetadata(
        resolvedHistoryIdsRef.current,
        unavailableArticleIdsRef.current,
      );
      setPendingImports((current) =>
        current.filter((item) => item.id !== pendingImport.id),
      );
      setSelectedId((current) =>
        current === pendingImport.id ? null : current,
      );
      if (articleIdRef.current === pendingImport.id) {
        articleIdRef.current = null;
        setArticle(null);
        replaceWithAdd();
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
    setStatus(`Parsing ${file.name}...`);
    setError(null);
    showLibrary();

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
      setSelectedId((current) =>
        current === pendingImport.id ? data.article.id : current,
      );
      if (articleIdRef.current === pendingImport.id) {
        const pendingEntry = appHistoryEntry(window.history.state);
        writeAppHistory("replace", {
          view: "reader",
          articleId: data.article.id,
          depth: pendingEntry?.depth ?? 1,
        });
        articleIdRef.current = data.article.id;
        setArticle(data.article);
      }
      setStatus(null);
      articleListNeedsRefreshRef.current = true;
      void loadArticles(false);
    } catch (uploadError) {
      resolvedHistoryIdsRef.current.set(pendingImport.id, null);
      persistHistoryMetadata(
        resolvedHistoryIdsRef.current,
        unavailableArticleIdsRef.current,
      );
      setPendingImports((current) =>
        current.filter((item) => item.id !== pendingImport.id),
      );
      setSelectedId((current) =>
        current === pendingImport.id ? null : current,
      );
      if (articleIdRef.current === pendingImport.id) {
        articleIdRef.current = null;
        setArticle(null);
        replaceWithAdd();
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
    let result: IntegrationSyncResponse | null = null;

    try {
      const endpoint =
        provider === "instapaper"
          ? "/api/integrations/instapaper/sync"
          : "/api/integrations/dropbox/sync";
      for (
        let completedRequests = 1;
        completedRequests <= integrationSyncMaxRequests;
        completedRequests += 1
      ) {
        const body =
          provider === "instapaper"
            ? {
                folder: instapaperFolder,
                batchSize: integrationSyncRequestBatchSize,
              }
            : { batchSize: integrationSyncRequestBatchSize };
        const response = await requestJson<IntegrationSyncResponse>(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });

        result = mergeIntegrationSyncResponses(result, response);

        if (!shouldContinueIntegrationSync(response, completedRequests)) {
          break;
        }
      }

      setIntegrationNotice(
        integrationSyncMessage(provider, result ?? emptyIntegrationSyncResponse()),
      );
      await Promise.all([loadArticles(false), loadIntegrationStatus()]);
    } catch (syncError) {
      const failureMessage = `${provider === "instapaper" ? "Instapaper" : "@Voice"} sync stopped: ${messageFromError(
        syncError,
      )}`;
      setIntegrationNotice(
        result
          ? `${integrationSyncMessage(provider, result)} ${failureMessage}`
          : failureMessage,
      );

      if (result) {
        await Promise.all([loadArticles(false), loadIntegrationStatus()]).catch(
          () => undefined,
        );
      }
    } finally {
      setSyncingIntegration(null);
    }
  }

  async function handleArchiveArticle() {
    if (!article || readerArchiveBusy) {
      return;
    }

    const archivingArticle = article;
    stopSpeaking();
    setError(null);
    setReaderArchiveBusy(true);

    try {
      await toggleArticleArchive(archivingArticle);

      if (articleIdRef.current === archivingArticle.id) {
        replaceWithLibrary();
      }
    } catch (archiveError) {
      if (articleIdRef.current === archivingArticle.id) {
        setError(messageFromError(archiveError));
      }
    } finally {
      setReaderArchiveBusy(false);
    }
  }

  async function handleDeleteArticleFromActions() {
    if (!actionArticle) {
      return;
    }

    const confirmed = window.confirm(
      `Permanently delete “${actionArticle.title}”?`,
    );

    if (!confirmed) {
      return;
    }

    setArticleActionBusy(true);
    setArticleActionError(null);

    try {
      await deleteArticleById(actionArticle.id);
      closeArticleActions(false);
      focusAfterLibraryRemoval(actionArticle.id);
      setOrganizationNotice({
        message: `Deleted “${actionArticle.title}”.`,
      });
    } catch (deleteError) {
      setArticleActionError(messageFromError(deleteError));
    } finally {
      setArticleActionBusy(false);
    }
  }

  async function deleteArticleById(deletingId: string) {
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
    void loadArticles(false);

    if (articleIdRef.current === deletingId) {
      articleIdRef.current = null;
      setSelectedId(null);
      setArticle(null);
      replaceWithLibrary();
    }
  }

  const readableProgress = article ? progressRatio(article) : 0;
  const readerArchiveLabel = readerArchiveBusy
    ? "Updating archive status"
    : article?.archivedAt
      ? "Restore article"
      : "Archive article";
  const playingSentenceIndex = isSpeaking ? currentSentence : null;
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

  const readerAppClassName = [
    "reader-app",
    `view-${appView}`,
    ...(discussionOpen
      ? [
          "discussion-open",
          `discussion-mode-${discussionMode}`,
          ...(discussionMode === "sheet"
            ? [`discussion-snap-${discussionPhoneSnap}`]
            : []),
        ]
      : []),
  ].join(" ");

  return (
    <main className={readerAppClassName}>
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
                  {libraryCountLabel(
                    activeArticleTotal,
                    importingCount,
                    queuedImportProblemCount,
                  )}
                </p>
              </div>
            </div>
            <div className="app-bar-actions">
              <button
                className="icon-button"
                type="button"
                title="Refresh library"
                aria-label="Refresh library"
                onClick={() => void refreshLibrary(true)}
              >
                <RefreshCw size={18} />
              </button>
              <button
                className="icon-button add-header-button"
                type="button"
                title="Add article"
                aria-label="Add article"
                onClick={showAdd}
              >
                <Plus size={20} />
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
                {libraryCountLabel(
                  articleTotal,
                  showPendingImports ? importingCount : 0,
                  showPendingImports ? queuedImportProblemCount : 0,
                )}
              </span>
            </header>

            <div className="library-controls" aria-label="Library controls">
              <label className="library-select-control">
                <Folder size={16} aria-hidden="true" />
                <span className="visually-hidden">Show collection</span>
                <select
                  value={libraryLocation}
                  onChange={(event) => {
                    setStatus("Loading library...");
                    setArticles([]);
                    setArticleTotal(0);
                    setNextArticleCursor(null);
                    setLibraryLocation(
                      event.target.value as ArticleListLocation,
                    );
                  }}
                >
                  <option value="default">Default</option>
                  <option value="all">All articles</option>
                  {folders
                    .filter(
                      (folder) => !folder.isArchive && !isDefaultFolder(folder),
                    )
                    .map((folder) => (
                      <option key={folder.id} value={`folder:${folder.id}`}>
                        {folder.name}
                      </option>
                    ))}
                  <option value="archive">Archive</option>
                </select>
              </label>
              <label className="library-select-control">
                <ArrowUpDown size={16} aria-hidden="true" />
                <span className="visually-hidden">Sort articles</span>
                <select
                  value={librarySort}
                  onChange={(event) => {
                    setStatus("Loading library...");
                    setArticles([]);
                    setArticleTotal(0);
                    setNextArticleCursor(null);
                    setLibrarySort(
                      event.target.value as ArticleListSortMode,
                    );
                  }}
                >
                  <option value="saved-desc">Newest saved</option>
                  <option value="saved-asc">Oldest saved</option>
                  <option value="read-desc">Recently read</option>
                  <option value="title-asc">Title A–Z</option>
                  <option value="duration-asc">Shortest first</option>
                  <option value="duration-desc">Longest first</option>
                </select>
              </label>
            </div>

            {(status || error || folderError) && (
              <div
                className={error || folderError ? "notice error" : "notice"}
                role="status"
              >
                {error ?? folderError ?? status}
              </div>
            )}

            {organizationNotice ? (
              <div className="notice organization-notice" role="status">
                <span>{organizationNotice.message}</span>
                {organizationNotice.undo ? (
                  <button type="button" onClick={undoOrganizationChange}>
                    Undo
                  </button>
                ) : null}
              </div>
            ) : null}

            <section
              className="article-list"
              aria-labelledby="library-index-title"
            >
              {libraryItems.length === 0 ? (
                status ? null : (
                  <div className="empty-library">
                    <FileText size={24} />
                    <span>{emptyLibraryMessage(libraryLocation)}</span>
                  </div>
                )
              ) : (
                libraryItems.map((item) =>
                  item.kind !== "article" ? (
                    <PendingImportRow
                      key={`${item.kind}:${item.pendingImport.id}`}
                      pendingImport={item.pendingImport}
                      selected={
                        item.kind === "pending" &&
                        item.pendingImport.id === selectedId
                      }
                      onOpen={
                        item.kind === "pending"
                          ? () => showReader(item.pendingImport.id)
                          : undefined
                      }
                    />
                  ) : (
                    <ArticleRow
                      key={item.articleSummary.id}
                      item={item.articleSummary}
                      selected={item.articleSummary.id === selectedId}
                      folderName={
                        item.articleSummary.folderId
                          ? folderById.get(item.articleSummary.folderId)?.name
                          : undefined
                      }
                      onOpen={() => showReader(item.articleSummary.id)}
                      onOpenActions={openArticleActions}
                    />
                  ),
                )
              )}
              {articleTotal > articleListPageSize ||
              nextArticleCursor ||
              isLoadingMoreArticles ||
              articleListRefreshFailed ? (
                <div
                  ref={articleListSentinelRef}
                  className="article-list-loader"
                  role="status"
                  aria-live="polite"
                  aria-busy={isLoadingMoreArticles}
                >
                  <button
                    type="button"
                    disabled={
                      isLoadingMoreArticles ||
                      (!nextArticleCursor && !articleListRefreshFailed)
                    }
                    onClick={() => {
                      if (articleListRefreshFailed) {
                        void loadArticles(false);
                      } else {
                        void loadMoreArticles();
                      }
                    }}
                  >
                    {isLoadingMoreArticles
                      ? "Loading more…"
                      : articleListRefreshFailed
                        ? "Retry loading"
                      : nextArticleCursor
                        ? "Load more"
                        : "All articles loaded"}
                  </button>
                </div>
              ) : null}
            </section>
          </div>
        </section>
      ) : null}

      {appView === "add" ? (
        <section
          className="add-view app-surface"
          aria-labelledby="add-view-title"
        >
          <header className="app-bar add-app-bar">
            <button className="back-button" type="button" onClick={showLibrary}>
              <ChevronLeft size={20} />
              <span>Library</span>
            </button>
            <div className="view-heading">
              <span>AI Reader</span>
              <h1 ref={addHeadingRef} id="add-view-title" tabIndex={-1}>
                Add
              </h1>
            </div>
            <span className="app-bar-spacer" aria-hidden="true" />
          </header>

          <div className="add-page">
            <section className="add-card" aria-labelledby="add-card-title">
              <header className="add-card-heading">
                <span className="add-card-icon" aria-hidden="true">
                  <Plus size={21} />
                </span>
                <div>
                  <h2 id="add-card-title">Add to library</h2>
                  <p>Save a web article or import a document for reading.</p>
                </div>
              </header>

              <form className="add-url-form" onSubmit={handleUrlSubmit}>
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
                  Save article
                </button>
              </form>

              <div className="add-separator" aria-hidden="true">
                <span>or</span>
              </div>

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
                className="secondary-button add-upload-button"
                type="button"
                disabled={isImporting}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={18} />
                Upload document
              </button>
              <p className="add-supported-copy">
                PDF, Word, Markdown, text, HTML, MHTML, and @Voice archives are
                supported.
              </p>

              {(status || error) && (
                <div
                  className={error ? "notice error" : "notice"}
                  role="status"
                >
                  {error ?? status}
                </div>
              )}
            </section>
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
                  title={
                    isSpeaking
                      ? "Pause"
                      : article.narration
                        ? "Play saved AI narration"
                        : "Read aloud"
                  }
                  aria-label={
                    isSpeaking
                      ? "Pause"
                      : article.narration
                        ? "Play saved AI narration"
                        : "Read aloud"
                  }
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
                  className="round-button"
                  type="button"
                  title={readerArchiveLabel}
                  aria-label={readerArchiveLabel}
                  aria-busy={readerArchiveBusy || undefined}
                  disabled={readerArchiveBusy}
                  onClick={() => void handleArchiveArticle()}
                >
                  {readerArchiveBusy ? (
                    <RefreshCw className="spin" size={19} aria-hidden="true" />
                  ) : (
                    <Archive size={19} />
                  )}
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
                  lang={speechLanguage}
                  onContextMenu={handleSentenceContextMenu}
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
                          playingSentenceIndex={playingSentenceIndex}
                          contextSentenceIndex={contextSentenceIndex}
                          onSentenceTap={handleSentenceTap}
                        />
                      ) : (
                        <span
                          className={`sentence narration-title${
                            playingSentenceIndex ===
                            narrationTitleSentenceIndex
                              ? " playing"
                              : ""
                          }`}
                          aria-current={
                            playingSentenceIndex ===
                            narrationTitleSentenceIndex
                              ? "true"
                              : undefined
                          }
                        >
                          {article.title}
                        </span>
                      )}
                    </h1>
                    <div
                      className="article-meta-row"
                      aria-label="Article metadata"
                    >
                      <span>{article.wordCount.toLocaleString()} words</span>
                      <span>
                        {article.narration?.durationSeconds
                          ? Math.max(
                              1,
                              Math.round(
                                article.narration.durationSeconds / 60,
                              ),
                            )
                          : article.estimatedMinutes}{" "}
                        min audio
                      </span>
                      <span>{formatDate(article.createdAt)}</span>
                      {article.narration ? (
                        <span title="This audio was generated by AI.">
                          AI narration
                        </span>
                      ) : null}
                      <span>
                        {formatCost(article.processingCostUsd ?? 0)} API cost
                      </span>
                    </div>
                  </header>

                  {visibleArticleBlocks.map((block) => (
                    <ArticleBlockView
                      key={`${article.id}:${block.id}`}
                      block={block}
                      articleSourceUrl={article.sourceUrl}
                      playingSentenceIndex={playingSentenceIndex}
                      contextSentenceIndex={contextSentenceIndex}
                      onSentenceTap={handleSentenceTap}
                    />
                  ))}
                </article>
              </div>
            </>
          )}
        </section>
      ) : null}

      {appView === "library" && actionArticle && articleActions ? (
        <ArticleActionsDialog
          article={actionArticle}
          folders={folders.filter((folder) => !folder.isArchive)}
          currentFolderName={
            actionArticle.folderId
              ? folderById.get(actionArticle.folderId)?.name
              : undefined
          }
          position={{ left: articleActions.left, top: articleActions.top }}
          view={articleActions.view}
          busy={articleActionBusy}
          error={articleActionError}
          onClose={() => closeArticleActions()}
          onShowActions={() =>
            setArticleActions((current) =>
              current ? { ...current, view: "actions" } : current,
            )
          }
          onShowMove={showMoveActions}
          onArchive={() => void handleArchiveFromActions()}
          onMove={(folderId) => void moveArticleToFolder(folderId)}
          onCreateFolder={(name) => createFolderAndMove(name)}
          onDelete={() => void handleDeleteArticleFromActions()}
        />
      ) : null}

      {appView === "reader" &&
      selectionDiscussionAction &&
      (!discussionOpen || discussionMode !== "overlay") ? (
        <>
          <button
            className="selection-discuss-button"
            type="button"
            style={{
              left: selectionDiscussionAction.left,
              top: selectionDiscussionAction.top,
            }}
            disabled={selectionDiscussionAction.tooLong}
            aria-describedby={
              selectionDiscussionAction.tooLong
                ? "selection-discussion-limit"
                : undefined
            }
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
          {selectionDiscussionAction.tooLong ? (
            <span
              className="visually-hidden"
              id="selection-discussion-limit"
              role="status"
            >
              Select a passage of 24,000 characters or fewer to discuss it.
            </span>
          ) : null}
        </>
      ) : null}
      {article ? (
        <ArticleDiscussion
          articleId={article.id}
          articleTitle={article.title}
          open={discussionOpen}
          mode={discussionMode}
          phoneSnap={discussionPhoneSnap}
          scope={discussionScope}
          onClose={closeDiscussion}
          onPhoneSnapChange={setDiscussionPhoneSnap}
          onSwitchToWhole={switchDiscussionToWholeArticle}
          onSelectionConsumed={switchDiscussionToWholeArticle}
          onBeforeVoiceStart={stopSpeaking}
          returnFocusRef={readerBackButtonRef}
          focusComposerRequest={discussionComposerFocusRequest}
        />
      ) : null}
    </main>
  );
}

function ArticleRow({
  item,
  selected,
  folderName,
  onOpen,
  onOpenActions,
}: {
  item: ArticleSummary;
  selected: boolean;
  folderName?: string;
  onOpen: () => void;
  onOpenActions: (
    articleId: string,
    left: number,
    top: number,
    returnFocus: HTMLElement,
  ) => void;
}) {
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const progressPercent = Math.round(progressRatio(item) * 100);

  const openActionsFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (
      event.key !== "ContextMenu" &&
      !(event.shiftKey && event.key === "F10")
    ) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    onOpenActions(
      item.id,
      rect.right - 292,
      rect.top + 42,
      event.currentTarget,
    );
  };

  const openActionsFromContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    const returnFocus = openButtonRef.current ?? event.currentTarget;
    onOpenActions(
      item.id,
      event.clientX,
      event.clientY,
      returnFocus,
    );
  };

  return (
    <article
      className={`article-row ${selected ? "selected" : ""}`}
      data-article-id={item.id}
      onContextMenu={openActionsFromContextMenu}
    >
      <button
        ref={openButtonRef}
        className="article-row-open"
        type="button"
        data-article-open-id={item.id}
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        onKeyDown={openActionsFromKeyboard}
      >
        <span
          className={`article-row-thumbnail thumbnail-${item.sourceType}`}
          aria-hidden="true"
        >
          <span className="article-thumbnail-fallback">
            {sourceGlyph(item.sourceType)}
          </span>
          {item.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Reader thumbnails can come from arbitrary archived article URLs.
            <img
              src={proxiedImageSrc(item.thumbnailUrl, item.sourceUrl)}
              alt=""
              loading="lazy"
              decoding="async"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          ) : null}
        </span>
        <span className="article-row-main">
          <span className="article-row-title">{item.title}</span>
          <span className="article-row-meta">
            {articleCardMeta(item, folderName)}
          </span>
          {item.excerpt ? (
            <span className="article-row-excerpt">{item.excerpt}</span>
          ) : null}
          {progressPercent > 0 ? (
            <span className="mini-progress" aria-hidden="true">
              <span style={{ width: `${progressPercent}%` }} />
            </span>
          ) : null}
        </span>
      </button>
      <button
        className="article-row-more"
        type="button"
        aria-label={`More actions for ${item.title}`}
        aria-haspopup="dialog"
        title="More actions"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenActions(
            item.id,
            rect.right - 292,
            rect.bottom + 6,
            event.currentTarget,
          );
        }}
      >
        <MoreHorizontal size={20} />
      </button>
    </article>
  );
}

function PendingImportRow({
  pendingImport,
  selected,
  onOpen,
}: {
  pendingImport: PendingImport;
  selected: boolean;
  onOpen?: () => void;
}) {
  const importStatus = pendingImport.status ?? "pending";
  const isWorking = importStatus === "pending";
  const statusLabel =
    importStatus === "failed"
      ? "Import failed"
      : importStatus === "stalled"
        ? "Import paused"
        : "Importing";
  const content = (
    <>
      <span
        className={`article-row-thumbnail thumbnail-${pendingImport.sourceType}`}
        aria-hidden="true"
      >
        {isWorking ? (
          <RefreshCw className="spin" size={22} />
        ) : (
          <TriangleAlert size={22} />
        )}
      </span>
      <span className="article-row-main">
        <span className="article-row-title">{pendingImport.title}</span>
        <span className="article-row-meta">
          {sourceLabel(pendingImport.sourceType)} · {statusLabel} ·{" "}
          {pendingImport.detail}
        </span>
        {!isWorking && pendingImport.errorMessage ? (
          <span className="article-row-excerpt">
            {pendingImport.errorMessage}
          </span>
        ) : null}
        {isWorking ? (
          <span className="mini-progress indeterminate" aria-hidden="true">
            <span />
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <article
      className={`article-row pending pending-${importStatus} ${selected ? "selected" : ""}`}
      data-article-id={pendingImport.id}
      aria-busy={isWorking ? "true" : undefined}
    >
      {onOpen ? (
        <button
          className="article-row-open"
          type="button"
          data-article-open-id={pendingImport.id}
          aria-current={selected ? "page" : undefined}
          onClick={onOpen}
        >
          {content}
        </button>
      ) : (
        <div className="article-row-open">{content}</div>
      )}
      {pendingImport.retryUrl ? (
        <button
          className="article-row-more queued-import-retry"
          type="button"
          aria-label={`Retry importing ${pendingImport.title}`}
          title="Retry import"
          onClick={() => window.location.assign(pendingImport.retryUrl ?? "/")}
        >
          <RefreshCw size={19} />
        </button>
      ) : (
        <span className="article-row-action-spacer" aria-hidden="true" />
      )}
    </article>
  );
}

function ArticleActionsDialog({
  article,
  folders,
  currentFolderName,
  position,
  view,
  busy,
  error,
  onClose,
  onShowActions,
  onShowMove,
  onArchive,
  onMove,
  onCreateFolder,
  onDelete,
}: {
  article: ArticleSummary;
  folders: ArticleFolder[];
  currentFolderName?: string;
  position: { left: number; top: number };
  view: "actions" | "move";
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onShowActions: () => void;
  onShowMove: () => void;
  onArchive: () => void;
  onMove: (folderId: string) => void;
  onCreateFolder: (name: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    const focusFrame = window.requestAnimationFrame(() => {
      panel
        ?.querySelector<HTMLElement>("[data-action-autofocus]")
        ?.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (busy) {
          return;
        }

        event.preventDefault();
        closeRef.current();
        return;
      }

      if (event.key !== "Tab" || !panel) {
        return;
      }

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1) ?? first;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [busy, view]);

  const style = {
    "--article-action-left": `${position.left}px`,
    "--article-action-top": `${position.top}px`,
  } as CSSProperties;

  return (
    <div
      className="article-action-scrim"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className="article-action-panel"
        role="dialog"
        aria-modal="true"
        aria-busy={busy || undefined}
        aria-labelledby="article-action-title"
        style={style}
      >
        {view === "actions" ? (
          <>
            <header className="article-action-heading">
              <div>
                <span>Article actions</span>
                <h2 id="article-action-title">{article.title}</h2>
                <p>{currentFolderName ?? "Default"}</p>
              </div>
              <button
                className="article-action-close"
                type="button"
                aria-label="Close article actions"
                disabled={busy}
                onClick={onClose}
              >
                ×
              </button>
            </header>
            <div className="article-action-list">
              <button
                type="button"
                data-action-autofocus
                disabled={busy}
                onClick={onArchive}
              >
                <Archive size={19} />
                <span>
                  <strong>{article.archivedAt ? "Restore" : "Archive"}</strong>
                  <small>
                    {article.archivedAt
                      ? "Return this article to the library"
                      : "Hide it from the active library"}
                  </small>
                </span>
              </button>
              <button type="button" disabled={busy} onClick={onShowMove}>
                <FolderInput size={19} />
                <span>
                  <strong>Move to folder</strong>
                  <small>{currentFolderName ?? "Default"}</small>
                </span>
                <ChevronRight className="article-action-chevron" size={17} />
              </button>
              <button
                className="article-action-delete"
                type="button"
                disabled={busy}
                onClick={onDelete}
              >
                <Trash2 size={19} />
                <span>
                  <strong>Delete permanently</strong>
                  <small>Remove the AI Reader copy</small>
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <header className="article-action-heading move-heading">
              <button
                className="article-action-back"
                type="button"
                data-action-autofocus
                aria-label="Back to article actions"
                disabled={busy}
                onClick={onShowActions}
              >
                <ChevronLeft size={19} />
              </button>
              <div>
                <span>Organize</span>
                <h2 id="article-action-title">Move to folder</h2>
              </div>
              <button
                className="article-action-close"
                type="button"
                aria-label="Close article actions"
                disabled={busy}
                onClick={onClose}
              >
                ×
              </button>
            </header>
            <div className="folder-choice-list">
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onMove(folder.id)}
                >
                  <Folder size={18} />
                  <span>{folder.name}</span>
                  {article.folderId === folder.id ? (
                    <Check size={18} />
                  ) : null}
                </button>
              ))}
            </div>
            <form
              className="new-folder-form"
              onSubmit={(event) => {
                event.preventDefault();
                const name = newFolderName.trim();

                if (name) {
                  void onCreateFolder(name).then((created) => {
                    if (created) {
                      setNewFolderName("");
                    }
                  });
                }
              }}
            >
              <label htmlFor="new-article-folder">New folder</label>
              <div>
                <input
                  id="new-article-folder"
                  value={newFolderName}
                  maxLength={80}
                  placeholder="Folder name"
                  disabled={busy}
                  onChange={(event) => setNewFolderName(event.target.value)}
                />
                <button
                  type="submit"
                  disabled={busy || !newFolderName.trim()}
                >
                  Create & move
                </button>
              </div>
            </form>
          </>
        )}
        {busy ? (
          <p className="article-action-status" role="status" aria-live="polite">
            <RefreshCw className="spin" size={15} aria-hidden="true" />
            Saving change…
          </p>
        ) : null}
        {error ? (
          <p className="article-action-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
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
  playingSentenceIndex,
  contextSentenceIndex,
  onSentenceTap,
}: {
  block: AnnotatedBlock;
  articleSourceUrl?: string;
  playingSentenceIndex: number | null;
  contextSentenceIndex: number | null;
  onSentenceTap: (sentenceIndex: number) => void;
}) {
  if (block.type === "heading") {
    const HeadingTag = `h${Math.min(Math.max(block.level, 2), 4)}` as
      "h2" | "h3" | "h4";
    return (
      <HeadingTag>
        <SentenceChunks
          chunks={block.chunks}
          playingSentenceIndex={playingSentenceIndex}
          contextSentenceIndex={contextSentenceIndex}
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
          playingSentenceIndex={playingSentenceIndex}
          contextSentenceIndex={contextSentenceIndex}
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
            playingSentenceIndex={playingSentenceIndex}
            contextSentenceIndex={contextSentenceIndex}
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
              playingSentenceIndex={playingSentenceIndex}
              contextSentenceIndex={contextSentenceIndex}
              onSentenceTap={onSentenceTap}
            />
          </li>
        ))}
      </ListTag>
    );
  }

  if (block.type === "image") {
    return (
      <ArticleImageBlock
        block={block}
        articleSourceUrl={articleSourceUrl}
        playingSentenceIndex={playingSentenceIndex}
        contextSentenceIndex={contextSentenceIndex}
        onSentenceTap={onSentenceTap}
      />
    );
  }

  if (block.type === "table") {
    return (
      <figure className="article-table-block">
        {block.captionChunks.length > 0 ? (
          <figcaption>
            <SentenceChunks
              chunks={block.captionChunks}
              playingSentenceIndex={playingSentenceIndex}
              contextSentenceIndex={contextSentenceIndex}
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
                            playingSentenceIndex={playingSentenceIndex}
                            contextSentenceIndex={contextSentenceIndex}
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
        playingSentenceIndex={playingSentenceIndex}
        contextSentenceIndex={contextSentenceIndex}
        onSentenceTap={onSentenceTap}
      />
    </p>
  );
}

function ArticleImageBlock({
  block,
  articleSourceUrl,
  playingSentenceIndex,
  contextSentenceIndex,
  onSentenceTap,
}: {
  block: Extract<AnnotatedBlock, { type: "image" }>;
  articleSourceUrl?: string;
  playingSentenceIndex: number | null;
  contextSentenceIndex: number | null;
  onSentenceTap: (sentenceIndex: number) => void;
}) {
  const sources = useMemo(
    () =>
      articleImageSourceCandidates(
        block.src,
        block.originalSrc,
        articleSourceUrl,
      ),
    [articleSourceUrl, block.originalSrc, block.src],
  );
  const sourceIdentity = sources.join("\0");
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [sourceIdentity]);

  const src = sources[sourceIndex];

  return (
    <figure className="article-image-block">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- Article images come from arbitrary reader URLs.
        <img
          src={src}
          alt={block.alt}
          loading={
            shouldLoadArticleImageEagerly(block.src, block.originalSrc)
              ? "eager"
              : "lazy"
          }
          onError={() => {
            setSourceIndex((current) => Math.min(current + 1, sources.length));
          }}
        />
      ) : (
        <div className="image-placeholder" aria-hidden="true">
          Image
        </div>
      )}
      {block.chunks.length > 0 ? (
        <figcaption>
          <SentenceChunks
            chunks={block.chunks}
            playingSentenceIndex={playingSentenceIndex}
            contextSentenceIndex={contextSentenceIndex}
            onSentenceTap={onSentenceTap}
          />
        </figcaption>
      ) : null}
    </figure>
  );
}

function SentenceChunks({
  chunks,
  playingSentenceIndex,
  contextSentenceIndex,
  onSentenceTap,
}: {
  chunks: SentenceSegment[];
  playingSentenceIndex: number | null;
  contextSentenceIndex: number | null;
  onSentenceTap: (sentenceIndex: number) => void;
}) {
  return chunks.map((chunk, index) => {
    const highlightState = sentenceHighlightState(
      chunk.sentenceIndex,
      playingSentenceIndex,
      contextSentenceIndex,
    );

    return (
      <span
        key={chunk.sentenceIndex}
        className={`sentence${highlightState ? ` ${highlightState}` : ""}`}
        data-sentence-index={chunk.sentenceIndex}
        aria-current={highlightState === "playing" ? "true" : undefined}
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
    );
  });
}

function useArticleDiscussionMode(): ArticleDiscussionMode {
  const [mode, setMode] = useState<ArticleDiscussionMode>("dock");

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 700px)");
    const updateMode = () => {
      setMode(phone.matches ? "sheet" : "dock");
    };

    updateMode();
    phone.addEventListener("change", updateMode);

    return () => {
      phone.removeEventListener("change", updateMode);
    };
  }, []);

  return mode;
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

function emptyIntegrationSyncResponse(): IntegrationSyncResponse {
  return {
    imported: 0,
    deduplicated: 0,
    reconciled: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
  };
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

function pendingImportFromQueue(
  queuedImport: ArticleImportSummary,
): PendingImport {
  const stalled =
    queuedImport.status === "pending" && queuedImport.retryable;

  return {
    id: queuedImport.id,
    title: queuedImport.title,
    detail: sourceDomain(queuedImport.sourceUrl),
    sourceType: "url",
    status: stalled ? "stalled" : queuedImport.status,
    errorMessage:
      queuedImport.errorMessage ??
      (stalled
        ? "The background import stopped before it finished. Retry to continue."
        : undefined),
    retryUrl: queuedImport.retryable
      ? queuedImportRetryUrl(queuedImport)
      : undefined,
  };
}

function queuedImportRetryUrl(queuedImport: ArticleImportSummary) {
  const params = new URLSearchParams({
    source: queuedImport.source,
    title: queuedImport.title,
    url: queuedImport.sourceUrl,
  });
  return `/share?${params.toString()}`;
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

function libraryCountLabel(
  articleCount: number,
  pendingCount: number,
  problemCount = 0,
) {
  const articleLabel =
    articleCount === 1 ? "1 article" : `${articleCount} articles`;

  if (pendingCount === 0 && problemCount === 0) {
    return articleLabel;
  }

  const importLabels = [];

  if (pendingCount > 0) {
    importLabels.push(
      pendingCount === 1 ? "1 importing" : `${pendingCount} importing`,
    );
  }

  if (problemCount > 0) {
    importLabels.push(
      problemCount === 1 ? "1 needs attention" : `${problemCount} need attention`,
    );
  }

  return `${articleLabel} / ${importLabels.join(" / ")}`;
}

function articleListUrl(
  location: ArticleListLocation,
  sort: ArticleListSortMode,
  cursor?: string,
  limit = articleListPageSize,
) {
  const params = new URLSearchParams({
    location,
    sort,
    limit: String(limit),
  });

  if (cursor) {
    params.set("cursor", cursor);
  }

  return `/api/articles?${params.toString()}`;
}

function mergeArticlePages(
  current: ArticleSummary[],
  incoming: ArticleSummary[],
) {
  const seen = new Set(current.map((article) => article.id));
  return [
    ...current,
    ...incoming.filter((article) => {
      if (seen.has(article.id)) {
        return false;
      }

      seen.add(article.id);
      return true;
    }),
  ];
}

function folderIdForLocation(
  location: ArticleListLocation,
  defaultFolderId?: string,
) {
  if (location === "default") {
    return defaultFolderId ?? null;
  }

  return location.startsWith("folder:")
    ? location.slice("folder:".length)
    : null;
}

function archiveChangeForArticle(
  article: ArticleSummary | Article,
  folderById: ReadonlyMap<string, ArticleFolder>,
  folders: ArticleFolder[],
) {
  const wasArchived = Boolean(article.archivedAt);
  const currentFolder = article.folderId
    ? folderById.get(article.folderId)
    : undefined;
  const defaultFolder =
    folders.find(isDefaultFolder) ??
    folders.find((folder) => !folder.isArchive);
  const organization: OrganizationPatch = wasArchived
    ? {
        archived: false,
        ...(currentFolder?.isArchive && defaultFolder
          ? { folderId: defaultFolder.id }
          : {}),
      }
    : { archived: true };
  const undoPatch: OrganizationPatch = {
    archived: wasArchived,
    ...(wasArchived && currentFolder?.isArchive && article.folderId
      ? { folderId: article.folderId }
      : {}),
  };

  return { organization, undoPatch, wasArchived };
}

function organizationStateFromArticle(
  article: ArticleSummary | Article,
): ArticleOrganizationResponse["organization"] {
  return {
    id: article.id,
    folderId: article.folderId ?? null,
    archivedAt: article.archivedAt ?? null,
    updatedAt: article.updatedAt,
  };
}

function organizationStateWithPatch(
  article: ArticleSummary | Article,
  organization: OrganizationPatch,
): ArticleOrganizationResponse["organization"] {
  const current = organizationStateFromArticle(article);
  return {
    ...current,
    folderId: Object.hasOwn(organization, "folderId")
      ? (organization.folderId ?? null)
      : current.folderId,
    archivedAt: Object.hasOwn(organization, "archived")
      ? organization.archived
        ? new Date().toISOString()
        : null
      : current.archivedAt,
    updatedAt: new Date().toISOString(),
  };
}

function articleWithOrganizationState<T extends ArticleSummary | Article>(
  article: T,
  organization: ArticleOrganizationResponse["organization"],
): T {
  return {
    ...article,
    folderId: organization.folderId ?? undefined,
    archivedAt: organization.archivedAt ?? undefined,
    updatedAt: organization.updatedAt,
  };
}

function compareFolders(left: ArticleFolder, right: ArticleFolder) {
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function isDefaultFolder(folder: ArticleFolder) {
  return (
    !folder.isArchive &&
    (folder.slug === "default" ||
      folder.name.trim().toLocaleLowerCase() === "default")
  );
}

function emptyLibraryMessage(location: ArticleListLocation) {
  if (location === "archive") {
    return "No archived articles.";
  }

  if (location === "default") {
    return "No articles in Default.";
  }

  if (location.startsWith("folder:")) {
    return "No articles in this folder.";
  }

  return "Use Add to save your first article.";
}

function articleCardMeta(item: ArticleSummary, folderName?: string) {
  const source = item.sourceUrl
    ? sourceDomain(item.sourceUrl).replace(/^www\./u, "")
    : sourceLabel(item.sourceType);
  const parts = [
    `${source} / ${formatCompactAge(item.createdAt)}`,
    `${item.estimatedMinutes} min`,
  ];
  const progress = Math.round(progressRatio(item) * 100);

  if (progress > 0) {
    parts.push(`${progress}% read`);
  }

  if (folderName) {
    parts.push(folderName);
  }

  return parts.join(" · ");
}

function formatCompactAge(value: string) {
  const elapsed = Date.now() - dateValue(value);
  const days = Math.max(0, Math.floor(elapsed / 86_400_000));

  if (days === 0) {
    return "today";
  }

  if (days < 30) {
    return `${days}d`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function dateValue(value: string) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
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
