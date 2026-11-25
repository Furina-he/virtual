declare module '*?url' {
  const url: string
  export default url
}

declare module '*?raw' {
  const raw: string
  export default raw
}

interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options: { eager: true; query?: '?url' | '?raw'; import: 'default' },
  ): Record<string, T>
}
