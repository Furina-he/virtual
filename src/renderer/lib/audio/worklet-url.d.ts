// Vite 把 `?worker&url` 导入打包成独立同源文件并返回其 URL（AudioWorklet.addModule 用）
declare module '*?worker&url' {
  const url: string
  export default url
}
