/// <reference types="vite/client" />

// Vite resolves CSS imports and CSS modules; these declarations teach TypeScript the same
// thing so a component can import its stylesheet without a per-file type.
declare module '*.css' {}
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
