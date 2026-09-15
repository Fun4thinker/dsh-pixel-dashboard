/**
 * 客户端打包脚本：把 src/client/ 下的 ESM 源文件装进 DSH 的浏览器模块容器。
 *
 * DSH 的客户端插件产物必须调用 window.__ModuleLoader__.load({ id, factory })，
 * factory 收到一个同步 require：它只认平台共享表（react 等）。为了让源码能按普通
 * ESM 分文件书写，这里在 factory 内部实现一个极小的 CJS 注册表，把相对 import
 * 重写成 require('./xxx.js')，并对 React 保留平台表的解析。
 *
 * 用法: node tools/build-client.mjs（由 tools/build.mjs 调用，产出 lib/client.js）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { Script, runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const srcDir = join(root, 'src', 'client')
const outDir = join(root, 'lib')
const outFile = join(outDir, 'client.js')

/**
 * 模块清单：先依赖、后入口，顺序只影响可读性。
 * 新增客户端文件必须登记到这里，否则打包后模块表里没有它，会以
 * 「unknown module」在浏览器里静默失效。
 */
const MODULES = [
  'format.js',
  'cost.js',
  'balance.js',
  'plans.js',
  'provider.js',
  'planView.js',
  'account.js',
  'notify.js',
  'period.js',
  'usage.js',
  'graph.js',
  'theme.js',
  'Notifier.js',
  'SessionCost.js',
  'dashboard.js',
  'entry.js',
]

/** 把 ESM 的相对 import / export 语法转成 CJS 形式：整体去缩进后按 tab 重新缩进。 */
function transform(code, id) {
  const required = new Map()
  let counter = 0
  let out = dedent(code).replace(
    /^import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([\s\S]*?)\}\s*from\s*'([^']+)'\s*$/gm,
    (match, defaultName, clause, spec) => {
      const local = aliasFor(spec, required, () => (counter += 1))
      const lines = []
      const parts = clause.split(',').map((part) => part.trim()).filter(Boolean)
      for (const part of parts) {
        const [imported, as] = part.split(/\s+as\s+/).map((piece) => piece.trim())
        lines.push(`const ${as ?? imported} = ${local}.${imported}`)
      }
      if (defaultName !== undefined) lines.push(`const ${defaultName} = ${local}.default`)
      return lines.join('\n')
    },
  )
  out = out.replace(
    /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*'([^']+)'\s*$/gm,
    (match, name, spec) => `const ${name} = ${aliasFor(spec, required, () => (counter += 1))}`,
  )
  // 纯默认导入（`import React from 'react'`）不走上面两条：命名导入那条要求花括号，
  // 命名空间那条要求 `* as`。漏掉它会把 import 语句原样留在脚本体里，同样触发语法错误。
  out = out.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s*'([^']+)'\s*$/gm,
    (match, name, spec) => `const ${name} = ${aliasFor(spec, required, () => (counter += 1))}`,
  )
  out = out.replace(/^import\s+'([^']+)'\s*$/gm, (match, spec) => `${aliasFor(spec, required, () => (counter += 1))}`)

  const exports = new Set()
  // 转出（`export { a, b as c } from './x.js'`）必须先处理：下面那条普通
  // `export {}` 规则不认识 from 子句，会把整句原样留下，而模块体是普通脚本体，
  // 残留的 `export` 会直接让整批插件加载失败。
  out = out.replace(
    /^export\s*\{([^}]*)\}\s*from\s*'([^']+)'\s*$/gm,
    (match, clause, spec) => {
      const local = aliasFor(spec, required, () => (counter += 1))
      const lines = []
      for (const part of clause.split(',').map((piece) => piece.trim()).filter(Boolean)) {
        const [imported, as] = part.split(/\s+as\s+/).map((piece) => piece.trim())
        const name = as ?? imported
        exports.add(name)
        lines.push(`const ${name} = ${local}.${imported}`)
      }
      return lines.join('\n')
    },
  )
  // 必须保留 async：丢掉它会让函数体里的 await 变成语法错误，而 combo 脚本是整批
  // 拼接进一个 <script>，一处解析失败就会让整批插件（不止本插件）全部注册不上。
  out = out.replace(/^export\s+(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm, (match, asyncKeyword, kind, name) => {
    exports.add(name)
    return `${asyncKeyword ?? ''}${kind} ${name}`
  })
  out = out.replace(/^export\s*\{([^}]*)\}\s*$/gm, (match, clause) => {
    const lines = []
    for (const part of clause.split(',').map((piece) => piece.trim()).filter(Boolean)) {
      const [local, as] = part.split(/\s+as\s+/).map((piece) => piece.trim())
      exports.add(local)
      lines.push(as === undefined || as === local ? null : `exports.${as} = ${local}`)
    }
    return lines.filter(Boolean).join('\n')
  })
  // 最后一道闸门：任何残留的 ESM 语法都必须让打包失败，而不是产出坏 bundle。
  const leftover = /^\s*(?:import|export)\b/m.exec(out)
  if (leftover !== null) {
    throw new Error(`${id} 里还有未转换的 ESM 语法：${leftover[0].trim()}`)
  }

  return {
    code: out,
    required,
    exportList: [...exports],
  }
}

/** 相对路径原样保留为 require 键；裸包名交给平台共享表。 */
function aliasFor(spec, required, next) {
  if (!spec.startsWith('.')) return `require('${spec}')`
  if (!required.has(spec)) required.set(spec, `m${next()}`)
  return required.get(spec)
}

/** 去掉源码的整体公共缩进（模块体不进入文件顶层，避免多余前导空白）。 */
function dedent(code) {
  const lines = code.replace(/\r\n/g, '\n').split('\n')
  let indent = Infinity
  for (const line of lines) {
    if (line.trim() === '') continue
    indent = Math.min(indent, line.length - line.trimStart().length)
  }
  if (!Number.isFinite(indent) || indent === 0) return lines.join('\n')
  return lines.map((line) => (line.trim() === '' ? '' : line.slice(indent))).join('\n')
}

const modules = []
for (const id of MODULES) {
  const file = join(srcDir, id)
  const { code, required, exportList } = transform(readFileSync(file, 'utf8'), id)
  const rewriters = [...required.entries()].map(([spec, local]) => {
    const target = posix.normalize(posix.join(posix.dirname(id), spec))
    return `\t\t\tconst ${local} = require(${JSON.stringify(`./${target}`)})`
  })
  modules.push({ id: `./${id}`, code, rewriters, exportList })
}

const registry = modules.map((module) => {
  const exportLines = module.exportList.length > 0
    ? `\n${module.exportList.map((name) => `\t\t\texports.${name} = ${name}`).join('\n')}\n\t\t`
    : ''
  return `\t\t${JSON.stringify(module.id)}: (exports, require) => {\n`
    + (module.rewriters.length > 0 ? `${module.rewriters.join('\n')}\n` : '')
    + `\t\t\t${module.code.trim()}\n${exportLines}},`
}).join('\n')

// 注册 id 必须是插件包名：DSH 网关按 profile 配置行里的包名（cordis.patch.yml 的
// name: 'dsh-pixel-dashboard'）校验 bundle 是否注册了同名模块。仓库根就是发布包，
// 因此这里直接读根的 package.json。
const packageId = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const bundle = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(packageId)},
	factory: (platformRequire) => {
		const MODULES = {
${registry}
		}
		const cache = {}
		// 本地注册表只认本插件拆分出的模块；其余裸包名（react 等）必须交回
		// factory 收到的平台 require，否则会在浏览器里抛 "unknown module react"。
		function load(id) {
			if (cache[id] !== undefined) return cache[id]
			const definition = MODULES[id]
			if (definition === undefined) return platformRequire(id)
			const exports = {}
			cache[id] = exports
			definition(exports, load)
			return exports
		}
		return load('./entry.js')
	},
})
`

// 语法闸门：产物是拼进 combo <script> 的普通脚本，任何语法错误都会让整批插件一起
// 加载失败（浏览器端表现为 “loaded without registering”），因此这里先编译一次。
try {
  new Script(bundle, { filename: 'client.js' })
} catch (error) {
  // 落一份可供定位的坏产物（语法错误不带行号时，直接看它对不上游源文件）。
  const badFile = `${outFile}.invalid`
  writeFileSync(badFile, bundle, 'utf8')
  console.error(`client.js 存在语法错误，已中止打包：${error.message}`)
  console.error(`坏产物已写出：${relative(root, badFile)}`)
  process.exit(1)
}

// 运行时闸门：用替身平台模块真跑一遍 factory。只做语法检查抓不到两类致命问题——
// 拆出的模块之间 require 不到，以及裸包名（react）没能交回平台表。它们都会让插件
// 在浏览器里静默失效，所以在这里先跑一次。
try {
  let factory
  const stub = () => new Proxy(function () {}, { get: () => stub(), apply: () => stub() })
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => { factory = registration.factory } } },
    console,
  }
  sandbox.globalThis = sandbox
  runInNewContext(bundle, sandbox, { filename: 'client.js' })
  const exports = factory((spec) => {
    if (typeof spec !== 'string' || spec.startsWith('.')) {
      throw new Error(`平台表收到了模块内相对请求 "${String(spec)}"`)
    }
    return stub()
  })
  if (typeof exports?.apply !== 'function') {
    throw new Error('factory 的入口模块没有导出 apply')
  }
} catch (error) {
  console.error(`client.js 无法加载（已中止打包）：${error.message}`)
  process.exit(1)
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, bundle, 'utf8')
console.log(`wrote ${relative(root, outFile)} (${bundle.length} bytes, ${modules.length} modules)`)
