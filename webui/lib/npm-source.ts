export type ParsedNpmSource = {
  name: string;
  spec: string;
  version?: string;
};

export function parseNpmSource(source: string): ParsedNpmSource | undefined {
  if (!source.startsWith('npm:')) return undefined;
  const spec = source.slice(4).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  return {
    name: match?.[1] ?? spec,
    spec,
    version: match?.[2]
  };
}
