import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react';
import vs from 'react-syntax-highlighter/dist/esm/styles/prism/vs';
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus';
import { useTheme } from '@/hooks/useTheme';
import { usePrismLanguages } from '@/hooks/usePrismLanguages';
import { prismLanguagesLoaded } from '@/lib/prism-languages';
import { takeHighlightBudget, waitForHighlight } from '@/lib/highlight-queue';
import { tokenizeToolCode, type ToolCodeNode } from '@/lib/tool-code-highlight';

/**
 * Syntax highlighting for tool-card content.
 *
 * A card is mostly code — a write's file, a read's result, an edit's diff, a
 * shell's command and output — all readable in the same monospace interface
 * text. `ToolCodeTokens` renders that text with the token colors a Markdown
 * fence already uses, without a box of its own: the card keeps its frame,
 * padding, scroll and error colors, and only the text inside gets colored.
 *
 * Usage: a provider names the syntax of everything below it
 * (`ToolCodeLanguageProvider`, fed by `lib/tool-code-language.ts`), and
 * `ToolCodeTokens` replaces the plain `{text}` where the card shows it. With no
 * provider — or an unknown language, or text too short/long/error-colored to be
 * worth it — it renders exactly the text it was given.
 */

type ToolCodeTheme = { [selector: string]: CSSProperties };

const THEMES: { light: ToolCodeTheme; dark: ToolCodeTheme } = {
  light: vs,
  dark: vscDarkPlus
};

/** Past this, a card's text stays plain: tokenizing it would stall the page. */
export const TOOL_CODE_MAX_CHARS = 200_000;

const ToolCodeLanguageContext = createContext<string | undefined>(undefined);

/** Names the syntax of the text inside, for every `ToolCodeTokens` below. */
export function ToolCodeLanguageProvider({
  lang,
  children
}: {
  lang: string | undefined;
  children: ReactNode;
}) {
  return (
    <ToolCodeLanguageContext.Provider value={lang}>{children}</ToolCodeLanguageContext.Provider>
  );
}

function ignoreTokenClass(name: string): boolean {
  // `token` is on every span; only the classes after it carry color.
  return name === 'token' || name === '';
}

function tokenStyle(
  theme: ToolCodeTheme,
  classNames: string[] | undefined
): CSSProperties | undefined {
  if (!classNames?.length) return undefined;
  let style: CSSProperties | undefined;
  for (const name of classNames) {
    if (ignoreTokenClass(name)) continue;
    const rule = theme[name];
    if (rule) style = { ...style, ...rule };
  }
  return style;
}

function renderTokens(nodes: ToolCodeNode[], theme: ToolCodeTheme): ReactNode[] {
  const rendered: ReactNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      rendered.push(node.value);
      continue;
    }
    rendered.push(
      <span key={rendered.length} style={tokenStyle(theme, node.properties?.className)}>
        {renderTokens(node.children ?? [], theme)}
      </span>
    );
  }
  return rendered;
}

/**
 * `text` with the syntax colors of the enclosing language, as inline nodes.
 * `budget` is false for many small pieces at once (a diff's lines): those
 * highlight on mount instead of queueing an idle slice each.
 */
export function ToolCodeTokens({ text, budget = true }: { text: string; budget?: boolean }) {
  const lang = useContext(ToolCodeLanguageContext);
  const { isDark } = useTheme();
  const wanted = Boolean(lang) && text.length > 0 && text.length <= TOOL_CODE_MAX_CHARS;
  const ready = usePrismLanguages(wanted);
  // Small text takes this task's highlight budget; anything longer waits for an
  // idle slice, like a code fence does (`lib/highlight-queue.ts`).
  const [colored, setColored] = useState(
    () => wanted && (!budget || (prismLanguagesLoaded() && takeHighlightBudget(text.length)))
  );

  useEffect(() => {
    if (!wanted || colored || !ready) return;
    return waitForHighlight(() => setColored(true));
  }, [wanted, colored, ready]);

  const nodes = useMemo(
    () => (colored && lang ? tokenizeToolCode(text, lang) : null),
    [colored, lang, text]
  );
  if (!nodes) return <>{text}</>;
  return <>{renderTokens(nodes, isDark ? THEMES.dark : THEMES.light)}</>;
}
