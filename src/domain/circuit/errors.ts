// content：内容配置有误（开发期问题）；wiring：学员接线引起，可直接展示
export class AssembleError extends Error {
  constructor(
    readonly kind: 'content' | 'wiring',
    message: string,
  ) {
    super(message)
    this.name = 'AssembleError'
  }
}
