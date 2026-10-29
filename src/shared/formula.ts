type Expression =
  | { kind: 'number'; value: number }
  | { kind: 'column'; id: string }
  | { kind: 'unary'; sign: 1 | -1; expression: Expression }
  | { kind: 'binary'; operation: string; left: Expression; right: Expression }

function parse(text: string): Expression {
  if (!text || text.length > 512) throw new Error('计算公式长度必须为 1 至 512 个字符。')
  const tokens: string[] = []
  let offset = 0
  while (offset < text.length) {
    if (/\s/.test(text[offset] ?? '')) {
      offset++
      continue
    }
    const token =
      /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|^\[[A-Za-z_][A-Za-z0-9_-]*\]|^[A-Za-z_][A-Za-z0-9_]*|^[()+*/-]/.exec(
        text.slice(offset),
      )?.[0]
    if (!token) throw new Error('计算公式只允许数值、列名、括号和加减乘除。')
    tokens.push(token)
    if (tokens.length > 128) throw new Error('计算公式过长。')
    offset += token.length
  }
  let position = 0
  const take = () => tokens[position++]
  const peek = () => tokens[position]
  function atom(depth: number): Expression {
    if (depth > 32) throw new Error('计算公式嵌套过深。')
    const token = take()
    if (token === '+' || token === '-')
      return { kind: 'unary', sign: token === '-' ? -1 : 1, expression: atom(depth + 1) }
    if (token === '(') {
      const expression = sum(depth + 1)
      if (take() !== ')') throw new Error('计算公式括号不匹配。')
      return expression
    }
    if (!token) throw new Error('计算公式缺少数值或列名。')
    if (/^\d|^\./.test(token)) {
      const value = Number(token)
      if (!Number.isFinite(value)) throw new Error('计算公式中的常量必须是有限数值。')
      return { kind: 'number', value }
    }
    if (/^\[|^[A-Za-z_]/.test(token)) return { kind: 'column', id: token.startsWith('[') ? token.slice(1, -1) : token }
    throw new Error('计算公式缺少数值或列名。')
  }
  function product(depth: number): Expression {
    let left = atom(depth)
    while (peek() === '*' || peek() === '/')
      left = { kind: 'binary', operation: take() as string, left, right: atom(depth) }
    return left
  }
  function sum(depth: number): Expression {
    let left = product(depth)
    while (peek() === '+' || peek() === '-')
      left = { kind: 'binary', operation: take() as string, left, right: product(depth) }
    return left
  }
  const expression = sum(0)
  if (position !== tokens.length) throw new Error('计算公式包含无法识别的语句。')
  return expression
}

export function formulaColumns(text: string): string[] {
  const columns = new Set<string>()
  function collect(expression: Expression) {
    if (expression.kind === 'column') columns.add(expression.id)
    else if (expression.kind === 'unary') collect(expression.expression)
    else if (expression.kind === 'binary') {
      collect(expression.left)
      collect(expression.right)
    }
  }
  collect(parse(text))
  return [...columns]
}

export function evaluateFormula(
  text: string,
  values: Readonly<Record<string, number | null>>,
): { value: number | null; message?: string } {
  function evaluate(expression: Expression): number {
    if (expression.kind === 'number') return expression.value
    if (expression.kind === 'column') {
      const value = values[expression.id]
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`计算需要先记录 ${expression.id}。`)
      return value
    }
    if (expression.kind === 'unary') return expression.sign * evaluate(expression.expression)
    const left = evaluate(expression.left)
    const right = evaluate(expression.right)
    if (expression.operation === '/' && right === 0) throw new Error('计算分母为零，请检查测量数据。')
    const value =
      expression.operation === '+'
        ? left + right
        : expression.operation === '-'
          ? left - right
          : expression.operation === '*'
            ? left * right
            : left / right
    if (!Number.isFinite(value)) throw new Error('计算结果不是有限数值，请检查测量数据。')
    return value
  }
  try {
    return { value: evaluate(parse(text)) }
  } catch (error) {
    return { value: null, message: error instanceof Error ? error.message : '计算公式无效。' }
  }
}
