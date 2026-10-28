declare module '*?url' {
  const url: string
  export default url
}

interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options: { eager: true; query?: '?url' | '?raw'; import: 'default' },
  ): Record<string, T>
}
