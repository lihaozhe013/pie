// TypeScript 7 no longer applies subpath ambient module declarations from
// @types packages (declare module "pkg/dist/…"), so the deep imports of
// react-syntax-highlighter lost their types. The project only imports these
// deep paths — never the package root — so @types/react-syntax-highlighter
// was removed and the exact surface the UI uses is declared here instead.
declare module 'react-syntax-highlighter/dist/esm/prism-light' {
  import type { ComponentType, CSSProperties, ReactNode } from 'react';

  export interface SyntaxHighlighterProps {
    language?: string | undefined;
    style?: { [key: string]: CSSProperties } | undefined;
    showLineNumbers?: boolean | undefined;
    lineNumberStyle?: CSSProperties | ((lineNumber: number) => CSSProperties) | undefined;
    customStyle?: CSSProperties | undefined;
    codeTagProps?:
      { style?: CSSProperties | undefined; className?: string | undefined } | undefined;
    wrapLongLines?: boolean | undefined;
    children?: ReactNode | undefined;
  }

  const PrismLight: ComponentType<SyntaxHighlighterProps>;
  export default PrismLight;
}

declare module 'react-syntax-highlighter/dist/cjs/styles/prism' {
  import type { CSSProperties } from 'react';

  export const vs: { [key: string]: CSSProperties };
  export const vscDarkPlus: { [key: string]: CSSProperties };
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/vs' {
  import type { CSSProperties } from 'react';

  const style: { [key: string]: CSSProperties };
  export default style;
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus' {
  import type { CSSProperties } from 'react';

  const style: { [key: string]: CSSProperties };
  export default style;
}
