import {
  memo,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useId,
  type RefObject
} from 'react';
import ReactMarkdown, { type Options as ReactMarkdownOptions } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { markdownPreviewRemarkPlugins, normalizeDisplayMath } from '@/lib/markdown';
import { isMessageGroupAnchor, splitFinalAssistantBlocks } from '@/lib/message-display';
import type {
  AgentMessage,
  AssistantMessage,
  CustomMessage,
  TextContent,
  UserMessage
} from '@/lib/types';
import { useI18n } from '@/hooks/useI18n';
import styles from './ChatMinimap.module.css';

interface Props {
  messages: AgentMessage[];
  /** The reply being streamed, read when the turns are measured: it never re-renders the minimap. */
  getStreamingMessage: () => Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  onRevealHistory: () => void;
  /** Turns of the branch the server has not sent yet: numbers continue from it (#791). */
  turnsBefore: number;
  /** Transcript window size: it mounts and unmounts rows, so measured positions go stale. */
  renderCount: number;
}

const MAX_RAIL_MARKERS = 18;
const PREVIEW_HIDE_DELAY = 160;
const MEASURE_THROTTLE_MS = 150;
const NAVIGATION_ACTIVE_LOCK_MS = 1600;

function preferredScrollBehavior(behavior: ScrollBehavior = 'smooth'): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : behavior;
}

interface AssistantPreview {
  markdown: string;
  element: HTMLDivElement | null;
}

interface TurnInfo {
  userMessage: UserMessage | CustomMessage;
  assistantPreviews: AssistantPreview[];
  scrollTop: number | null;
}

interface NodeInfo {
  targetTurn: TurnInfo;
  index: number;
}

function getUserPreview(message: UserMessage | CustomMessage): string {
  if (typeof message.content === 'string') return message.content.trim();
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function getAssistantAnswerMarkdown(message: AgentMessage | Partial<AgentMessage>): string {
  if (message.role !== 'assistant') return '';
  const { answerBlocks } = splitFinalAssistantBlocks(message as AssistantMessage);
  return answerBlocks
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

/** Splitting the answer is not free and repeats on every transcript change. */
const answerMarkdownCache = new WeakMap<AgentMessage, string>();

function getCachedAnswerMarkdown(message: AgentMessage): string {
  const cached = answerMarkdownCache.get(message);
  if (cached !== undefined) return cached;
  const markdown = getAssistantAnswerMarkdown(message);
  answerMarkdownCache.set(message, markdown);
  return markdown;
}

/**
 * Turns read from the transcript alone, without touching the DOM. The directory entry point
 * uses them so its presence never depends on a layout measurement having happened.
 */
function collectTurns(messages: readonly AgentMessage[]): TurnInfo[] {
  const turns: TurnInfo[] = [];
  let currentTurn: TurnInfo | null = null;
  for (const message of messages) {
    if (isMessageGroupAnchor(message)) {
      currentTurn = {
        userMessage: message as UserMessage | CustomMessage,
        assistantPreviews: [],
        scrollTop: null
      };
      turns.push(currentTurn);
      continue;
    }
    if (message.role !== 'assistant' || !currentTurn) continue;
    const answerMarkdown = getCachedAnswerMarkdown(message);
    if (answerMarkdown) {
      currentTurn.assistantPreviews.push({ markdown: answerMarkdown, element: null });
    }
  }
  return turns;
}

function PreviewHeading({
  level,
  children,
  headingIndex,
  onClick
}: {
  level: 1 | 2 | 3;
  children: React.ReactNode;
  headingIndex: number | null;
  onClick?: (headingIndex: number) => void;
}) {
  return (
    <button
      type="button"
      className={styles.heading}
      data-level={level}
      data-preview-heading-index={headingIndex ?? undefined}
      disabled={headingIndex === null || !onClick}
      onClick={(event) => {
        event.stopPropagation();
        if (headingIndex !== null) onClick?.(headingIndex);
      }}
    >
      {children}
    </button>
  );
}

interface PreviewAstNode {
  type?: string;
  depth?: number;
  data?: {
    hProperties?: Record<string, unknown>;
  };
}

function remarkPreviewOutline() {
  return (tree: { children?: PreviewAstNode[] }) => {
    if (!Array.isArray(tree.children)) return;
    const headings = tree.children.filter(
      (node) => node.type === 'heading' && typeof node.depth === 'number' && node.depth <= 3
    );
    if (headings.length > 0) {
      headings.forEach((node, headingIndex) => {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            'data-preview-heading-index': headingIndex
          }
        };
      });
      tree.children = headings;
      return;
    }
    const firstParagraph = tree.children.find((node) => node.type === 'paragraph');
    tree.children = firstParagraph ? [firstParagraph] : [];
  };
}

const previewRemarkPlugins = [...(markdownPreviewRemarkPlugins ?? []), remarkPreviewOutline];
const previewRehypePlugins: ReactMarkdownOptions['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, strict: false }]
];

function getPreviewHeadingIndex(node: unknown): number | null {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const value = properties?.dataPreviewHeadingIndex ?? properties?.['data-preview-heading-index'];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function createAssistantOutlineComponents(
  onHeadingClick?: (headingIndex: number) => void,
  onAnswerClick?: () => void
): ReactMarkdownOptions['components'] {
  return {
    h1: ({ children, node }) => (
      <PreviewHeading
        level={1}
        headingIndex={getPreviewHeadingIndex(node)}
        onClick={onHeadingClick}
      >
        {children}
      </PreviewHeading>
    ),
    h2: ({ children, node }) => (
      <PreviewHeading
        level={2}
        headingIndex={getPreviewHeadingIndex(node)}
        onClick={onHeadingClick}
      >
        {children}
      </PreviewHeading>
    ),
    h3: ({ children, node }) => (
      <PreviewHeading
        level={3}
        headingIndex={getPreviewHeadingIndex(node)}
        onClick={onHeadingClick}
      >
        {children}
      </PreviewHeading>
    ),
    h4: () => null,
    h5: () => null,
    h6: () => null,
    p: ({ children }) => (
      <button type="button" className={styles.paragraph} onClick={onAnswerClick}>
        {children}
      </button>
    ),
    blockquote: () => null,
    ul: () => null,
    ol: () => null,
    pre: () => null,
    table: () => null,
    hr: () => null,
    a: ({ children }) => <>{children}</>,
    code: ({ children }) => <>{children}</>
  };
}

export const AssistantOutline = memo(function AssistantOutline({
  markdown,
  onHeadingClick,
  onAnswerClick
}: {
  markdown: string;
  onHeadingClick?: (headingIndex: number) => void;
  onAnswerClick?: () => void;
}) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(markdown), [markdown]);
  const components = useMemo(
    () => createAssistantOutlineComponents(onHeadingClick, onAnswerClick),
    [onHeadingClick, onAnswerClick]
  );
  if (!markdown) return null;
  return (
    <div className={styles.outline}>
      <ReactMarkdown
        remarkPlugins={previewRemarkPlugins}
        rehypePlugins={previewRehypePlugins}
        components={components}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});

function createTurnNodes(turns: TurnInfo[]): NodeInfo[] {
  return turns.map((turn, index) => ({
    targetTurn: turn,
    index
  }));
}

export const ChatMinimap = memo(function ChatMinimap({
  messages,
  getStreamingMessage,
  scrollContainer,
  messageRefs,
  onRevealHistory,
  turnsBefore,
  renderCount
}: Props) {
  const { t } = useI18n();
  const [measuredNodes, setMeasuredNodes] = useState<NodeInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  // Which transcript the measurement belongs to: a stale one never stands in for the current.
  const measuredForRef = useRef<AgentMessage[] | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const directoryId = useId();
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodeLockRef = useRef<{ index: number; until: number } | null>(null);
  const pendingNavigationRef = useRef<{
    nodeIndex: number;
    target: 'user' | 'assistant' | 'heading';
    assistantIndex?: number;
    headingIndex?: number;
  } | null>(null);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Derived from the transcript: the entry point exists before, and without, any layout
  // measurement. Measurement only adds the positions the directory navigates to.
  const dataNodes = useMemo(() => createTurnNodes(collectTurns(messages)), [messages]);
  const nodes = measuredForRef.current === messages ? measuredNodes : dataNodes;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const railNodes = useMemo(() => {
    if (nodes.length <= MAX_RAIL_MARKERS) return nodes;
    return Array.from(
      { length: MAX_RAIL_MARKERS },
      (_, index) => nodes[Math.round((index * (nodes.length - 1)) / (MAX_RAIL_MARKERS - 1))]
    );
  }, [nodes]);
  const activeRailIndex =
    activeIndex === null || nodes.length < 2
      ? 0
      : Math.round((activeIndex * (railNodes.length - 1)) / (nodes.length - 1));

  const lockActiveNode = useCallback((index: number) => {
    activeNodeLockRef.current = {
      index,
      until: Date.now() + NAVIGATION_ACTIVE_LOCK_MS
    };
    setActiveIndex(index);
  }, []);

  const syncActiveNode = useCallback((scrollEl: HTMLDivElement, nextNodes: NodeInfo[]) => {
    const activeLock = activeNodeLockRef.current;
    if (activeLock && Date.now() < activeLock.until) {
      setActiveIndex(activeLock.index);
      return;
    }
    activeNodeLockRef.current = null;

    const positionedNodes = nextNodes.filter((node) => node.targetTurn.scrollTop !== null);
    if (positionedNodes.length === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
    const nextActiveNode = positionedNodes.reduce(
      (bestNode, node) =>
        Math.abs((node.targetTurn.scrollTop ?? 0) - focusTop) <
        Math.abs((bestNode.targetTurn.scrollTop ?? 0) - focusTop)
          ? node
          : bestNode,
      positionedNodes[0]
    );
    setActiveIndex(nextActiveNode.index);
  }, []);

  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    syncActiveNode(scrollEl, nodesRef.current);
  }, [scrollContainer, syncActiveNode]);

  const measureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;

    const refs = messageRefs.current;
    const containerRect = scrollEl.getBoundingClientRect();
    const turns: TurnInfo[] = [];
    let refIndex = 0;
    let currentTurn: TurnInfo | null = null;

    const streamingMessage = getStreamingMessage();
    const allMessages: (AgentMessage | Partial<AgentMessage>)[] = streamingMessage
      ? [...messagesRef.current, streamingMessage]
      : messagesRef.current;
    for (const message of allMessages) {
      const isAnchor = isMessageGroupAnchor(message);
      if (!isAnchor && message.role !== 'assistant') continue;
      const element = refs?.[refIndex];
      refIndex++;

      if (isAnchor) {
        const elementRect = element?.getBoundingClientRect();
        currentTurn = {
          userMessage: message as UserMessage | CustomMessage,
          assistantPreviews: [],
          scrollTop: elementRect ? elementRect.top - containerRect.top + scrollEl.scrollTop : null
        };
        turns.push(currentTurn);
        continue;
      }

      if (!currentTurn) continue;
      // The streamed partial is read here and never cached: it can change between measurements.
      const answerMarkdown =
        message === streamingMessage
          ? getAssistantAnswerMarkdown(message)
          : getCachedAnswerMarkdown(message as AgentMessage);
      if (answerMarkdown) {
        currentTurn.assistantPreviews.push({
          markdown: answerMarkdown,
          element
        });
      }
    }

    const nextNodes = createTurnNodes(turns);
    measuredForRef.current = messagesRef.current;
    nodesRef.current = nextNodes;
    setMeasuredNodes(nextNodes);
    syncActiveNode(scrollEl, nextNodes);

    const pendingNavigation = pendingNavigationRef.current;
    const pendingNode = pendingNavigation ? nextNodes[pendingNavigation.nodeIndex] : null;
    if (pendingNavigation && pendingNode) {
      const assistant =
        pendingNavigation.assistantIndex === undefined
          ? null
          : pendingNode.targetTurn.assistantPreviews[pendingNavigation.assistantIndex];
      let targetTop: number | null = pendingNode.targetTurn.scrollTop;
      if (pendingNavigation.target === 'assistant') {
        const assistantRect = assistant?.element?.getBoundingClientRect();
        targetTop = assistantRect
          ? assistantRect.top - containerRect.top + scrollEl.scrollTop
          : null;
      } else if (pendingNavigation.target === 'heading') {
        const heading =
          pendingNavigation.headingIndex === undefined
            ? null
            : assistant?.element
                ?.querySelectorAll<HTMLElement>('h1, h2, h3')
                .item(pendingNavigation.headingIndex);
        const headingRect = heading?.getBoundingClientRect();
        targetTop = headingRect ? headingRect.top - containerRect.top + scrollEl.scrollTop : null;
      }
      if (targetTop === null) return;
      pendingNavigationRef.current = null;
      lockActiveNode(pendingNode.index);
      const targetOffset = scrollEl.clientHeight * 0.3;
      scrollEl.scrollTo({
        top: Math.max(0, targetTop - targetOffset),
        behavior: preferredScrollBehavior()
      });
    }
  }, [getStreamingMessage, lockActiveNode, messageRefs, scrollContainer, syncActiveNode]);

  // Coalesced: a request that arrives while a run is pending is covered by that run, which
  // measures the DOM as it is when the timer fires.
  const scheduleMeasure = useCallback(() => {
    if (measureTimerRef.current) return;
    measureTimerRef.current = setTimeout(() => {
      measureTimerRef.current = null;
      measure();
    }, MEASURE_THROTTLE_MS);
  }, [measure]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener('scroll', updateScroll, { passive: true });
    return () => el.removeEventListener('scroll', updateScroll);
  }, [scrollContainer, updateScroll]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const syncLayout = () => {
      scheduleMeasure();
      updateScroll();
    };
    const ro = new ResizeObserver(syncLayout);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncLayout();
    return () => {
      ro.disconnect();
      if (measureTimerRef.current) {
        clearTimeout(measureTimerRef.current);
        measureTimerRef.current = null;
      }
    };
  }, [scheduleMeasure, scrollContainer, updateScroll]);

  // Transcript and render-window changes re-measure right away: the data decides when
  // measured positions go stale, not a resize that may never happen.
  useEffect(() => {
    measure();
    updateScroll();
    // The commit triggers are the point: measure() reads both through refs.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the commit triggers are the point.
  }, [measure, messages, renderCount, updateScroll]);

  const scrollToNode = useCallback(
    (node: NodeInfo, behavior: ScrollBehavior) => {
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;
      lockActiveNode(node.index);
      if (node.targetTurn.scrollTop === null) {
        pendingNavigationRef.current = { nodeIndex: node.index, target: 'user' };
        onRevealHistory();
        return;
      }
      const targetTop = Math.max(0, node.targetTurn.scrollTop - scrollEl.clientHeight * 0.3);
      scrollEl.scrollTo({ top: targetTop, behavior: preferredScrollBehavior(behavior) });
    },
    [lockActiveNode, onRevealHistory, scrollContainer]
  );

  const scrollToAssistant = useCallback(
    (node: NodeInfo, assistantIndex: number) => {
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;
      const assistantElement = node.targetTurn.assistantPreviews[assistantIndex]?.element;
      if (!assistantElement) {
        pendingNavigationRef.current = {
          nodeIndex: node.index,
          target: 'assistant',
          assistantIndex
        };
        onRevealHistory();
        return;
      }
      const containerRect = scrollEl.getBoundingClientRect();
      const assistantRect = assistantElement.getBoundingClientRect();
      const targetTop =
        assistantRect.top - containerRect.top + scrollEl.scrollTop - scrollEl.clientHeight * 0.3;
      lockActiveNode(node.index);
      scrollEl.scrollTo({ top: Math.max(0, targetTop), behavior: preferredScrollBehavior() });
    },
    [lockActiveNode, onRevealHistory, scrollContainer]
  );

  const scrollToHeading = useCallback(
    (node: NodeInfo, assistantIndex: number, headingIndex: number) => {
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;
      const answerElement = node.targetTurn.assistantPreviews[assistantIndex]?.element;
      if (!answerElement) {
        pendingNavigationRef.current = {
          nodeIndex: node.index,
          target: 'heading',
          assistantIndex,
          headingIndex
        };
        onRevealHistory();
        return;
      }
      const heading = answerElement.querySelectorAll<HTMLElement>('h1, h2, h3').item(headingIndex);
      if (!heading) return;
      const containerRect = scrollEl.getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      const targetTop =
        headingRect.top - containerRect.top + scrollEl.scrollTop - scrollEl.clientHeight * 0.3;
      lockActiveNode(node.index);
      scrollEl.scrollTo({ top: Math.max(0, targetTop), behavior: preferredScrollBehavior() });
    },
    [lockActiveNode, onRevealHistory, scrollContainer]
  );

  const cancelPreviewHide = useCallback(() => {
    if (!previewHideTimerRef.current) return;
    clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);

  const showPreview = useCallback(() => {
    cancelPreviewHide();
    setOutlineOpen(true);
  }, [cancelPreviewHide]);

  const closePreview = useCallback(() => {
    cancelPreviewHide();
    setOutlineOpen(false);
  }, [cancelPreviewHide]);

  const schedulePreviewHide = useCallback(() => {
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null;
      if (!previewBoxRef.current?.contains(document.activeElement)) setOutlineOpen(false);
    }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);

  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  useEffect(() => {
    if (!outlineOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target))
        closePreview();
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (containerRef.current?.contains(document.activeElement))
        triggerRef.current?.focus({ preventScroll: true });
      closePreview();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    window.addEventListener('keydown', dismissWithEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      window.removeEventListener('keydown', dismissWithEscape, true);
    };
  }, [closePreview, outlineOpen]);

  useEffect(() => {
    if (!outlineOpen) return;
    const box = previewBoxRef.current;
    const current = box?.querySelector<HTMLElement>(
      `[data-minimap-preview-index="${activeIndexRef.current}"]`
    );
    if (box && current)
      box.scrollTop = Math.max(
        0,
        current.offsetTop - (box.clientHeight - current.offsetHeight) / 2
      );
  }, [outlineOpen]);

  const navigate = (action: () => void) => {
    action();
    closePreview();
    triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <nav
      ref={containerRef}
      className={styles.navigator}
      aria-label={t('chatMinimap.contents')}
      hidden={nodes.length === 0}
      onMouseEnter={showPreview}
      onMouseLeave={schedulePreviewHide}
      onFocusCapture={cancelPreviewHide}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closePreview();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.rail}
        data-chat-outline-trigger=""
        aria-label={t('chatMinimap.contents')}
        title={t('chatMinimap.contents')}
        aria-expanded={outlineOpen}
        aria-controls={directoryId}
        onClick={showPreview}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          showPreview();
          requestAnimationFrame(() =>
            previewBoxRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
          );
        }}
      >
        {railNodes.map((node, index) => (
          <span
            key={node.index}
            className={styles.marker}
            data-minimap-marker=""
            data-active={activeIndex !== null && index === activeRailIndex ? 'true' : undefined}
            aria-hidden="true"
          />
        ))}
      </button>
      {outlineOpen && (
        <div className={styles.popover}>
          <div
            ref={previewBoxRef}
            id={directoryId}
            className={styles.preview}
            data-minimap-preview-box=""
          >
            {turnsBefore > 0 && (
              <button
                type="button"
                className={styles.earlier}
                data-minimap-preview-earlier=""
                onClick={() =>
                  navigate(() =>
                    scrollContainer.current?.scrollTo({
                      top: 0,
                      behavior: preferredScrollBehavior()
                    })
                  )
                }
              >
                {t('chatMinimap.earlierTurns', { count: turnsBefore })}
              </button>
            )}
            {nodes.map((node) => (
              <div
                key={node.index}
                className={styles.turn}
                data-minimap-preview-index={node.index}
                data-located={activeIndex === node.index ? 'true' : undefined}
              >
                <button
                  type="button"
                  className={styles.user}
                  data-minimap-preview-user={node.index}
                  aria-current={activeIndex === node.index ? 'location' : undefined}
                  title={getUserPreview(node.targetTurn.userMessage)}
                  onClick={() => navigate(() => scrollToNode(node, 'smooth'))}
                >
                  <span className={styles.number} aria-hidden="true">
                    {turnsBefore + node.index + 1}
                  </span>
                  <span className={styles.userText}>
                    {getUserPreview(node.targetTurn.userMessage) || t('chatMinimap.untitledTurn')}
                  </span>
                </button>
                {node.targetTurn.assistantPreviews.map((assistant, assistantIndex) => (
                  <div key={assistantIndex} className={styles.assistant}>
                    <AssistantOutline
                      markdown={assistant.markdown}
                      onAnswerClick={() => navigate(() => scrollToAssistant(node, assistantIndex))}
                      onHeadingClick={(headingIndex) =>
                        navigate(() => scrollToHeading(node, assistantIndex, headingIndex))
                      }
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
});

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count)
    .fill(null)
    .map((_, i) => refs.current[i] ?? null);
  return refs;
}
