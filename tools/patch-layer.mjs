/**
 * 补丁层读写与校验。
 *
 * 这个模块存在的唯一理由：补丁层写坏会重挂整棵插件树，表现却是浏览器端
 * “Failed to fetch”——排查成本极高。所以任何写入前都必须在内存里走一遍
 * 与 Loader 相同的 YAML 解析，解析不过就直接中止，绝不落盘。
 * @module tools/patch-layer
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 取 DSH 安装里自带的 js-yaml：本插件刻意不带依赖，而校验必须用与
 * Loader 相同的解析器，所以从部署目录借。
 * @param {string} [home] - DSH_HOME。
 * @returns {object} js-yaml 模块。
 */
function loadYaml(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  const anchors = [
    join(resolve(home), 'cordis.patch.yml'),
    join(resolve(home), 'profiles', 'node_modules', 'js-yaml', 'package.json'),
  ]
  for (const anchor of anchors) {
    try {
      return createRequire(pathToFileURL(anchor).href)('js-yaml')
    } catch {
      // 换下一个锚点
    }
  }
  throw new Error(`找不到 js-yaml（试过 ${anchors.join(' 与 ')}）；它随 DSH 一起安装`)
}

const yaml = loadYaml()

/**
 * 为 `!!js` 标签注册占位类型。
 * 产品补丁层里的 `!!js process.env.X` 由 Loader 求值，这里只需要它能被解析，
 * 因此按“保留原文本”的方式收下，不参与校验逻辑。
 */
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __js: String(data) }),
})
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([jsTag])

/**
 * 本插件的 loader 行 id 形状。
 * 现行 id 固定为 `pixel-dashboard`；早期「一版一目录」时期带版本后缀，
 * 两种都要能识别，否则清理会漏掉历史行。
 */
export const FAMILY = /^pixel-dashboard(-[a-z0-9]+)?$/i

/**
 * 本插件写入的说明注释前缀，清理时要一并去掉。
 *
 * 必须覆盖本插件可能写出的**所有**注释形态：漏掉一种，重装后补丁层里就会
 * 留下孤立的说明（历史事故：只认反斜杠写法，Windows 路径就漏了）。
 * 判断标准很简单——凡是我们自己写的注释，重新安装后都不该出现两份。
 */
const OWN_COMMENTS = [
  /^# ── 用户插件/, // 块首说明
  /^# 卸载：node tools[\\/]uninstall\.mjs/, // 卸载提示
  /^# 实现：/, // 指向哪个构建产物
  /^# 版本目录：/, // 早期「一版一目录」时期的说明，升级时要清掉
  /^# 触发热重载/, // 本地调试用的时戳
]

/**
 * 解析补丁层文本，格式不对就抛错。
 * @param {string} text - 补丁文件内容。
 * @param {string} label - 出错信息里显示的文件名。
 * @returns {object[]} 解析出的补丁条目。
 */
export function parsePatchLayer(text, label) {
  const trimmed = text.trim()
  if (trimmed === '') return []
  let parsed
  try {
    parsed = yaml.load(trimmed, { schema: SCHEMA })
  } catch (error) {
    throw new Error(`${label} 不是合法 YAML：${error.message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} 的顶层必须是数组（Loader 的补丁列表），实际是 ${parsed === null ? 'null' : typeof parsed}`)
  }
  return parsed
}

/**
 * 校验补丁层：必须能解析，且每个条目要么是 id 覆盖对象，要么是带非空列表的 insert。
 * 空 insert 正是本次事故的形态——它能通过“是数组”的检查，却会让整棵树重挂。
 * @param {string} text - 补丁文件内容。
 * @param {string} label - 出错信息里显示的文件名。
 * @returns {void}
 */
export function assertPatchLayer(text, label) {
  const entries = parsePatchLayer(text, label)
  entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} 第 ${index + 1} 个条目不是对象`)
    }
    if ('insert' in entry) {
      const rows = entry.insert
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`${label} 第 ${index + 1} 个条目是空 insert——会让整棵插件树重挂，必须删掉`)
      }
      for (const row of rows) {
        if (row === null || typeof row !== 'object' || typeof row.name !== 'string' || row.name === '') {
          throw new Error(`${label} 第 ${index + 1} 个 insert 里有缺少 name 的行`)
        }
      }
      return
    }
    if (typeof entry.id !== 'string' || entry.id === '') {
      throw new Error(`${label} 第 ${index + 1} 个条目既不是 insert，也没有可用的 id`)
    }
  })
}

/**
 * 读入补丁层并清掉本插件的旧版本行与说明注释。
 *
 * 这里刻意不保留任何本插件的行：调用方随后会写入一个全新的块，
 * 于是“重装同一版本”与“换版本”走的是同一条路径，不会出现
 * 旧块注释残留或空 insert 这类半清理状态。
 * @param {string} patchFile - 补丁文件路径。
 * @returns {string} 清理后的文本（未落盘）。
 */
export function readCleaned(patchFile) {
  if (!existsSync(patchFile)) return ''
  return dropFamilyRows(readFileSync(patchFile, 'utf8'))
}

/**
 * 删除本插件全部版本的 loader 行、说明注释，以及因此变空的 insert 块。
 * 只按 id 精确匹配，不动其它插件与产品行。
 * @param {string} text - 补丁文件内容。
 * @returns {string} 清理后的文本。
 */
export function dropFamilyRows(text) {
  const lines = text.split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i += 1) {
    if (OWN_COMMENTS.some((pattern) => pattern.test(lines[i]))) continue
    const match = /^\s+-\s+id:\s*(\S+)\s*$/.exec(lines[i])
    if (match !== null && FAMILY.test(match[1])) {
      // id 行连同紧随的 name 行一起丢弃
      if (/^\s+name:/.test(lines[i + 1] ?? '')) i += 1
      continue
    }
    kept.push(lines[i])
  }
  if (process.env.PATCH_LAYER_DEBUG === '1') {
    console.error('[debug] FAMILY =', String(FAMILY))
    console.error('[debug] kept =', JSON.stringify(kept))
  }
  return collapseEmptyInserts(kept.join('\n'))
}

/**
 * 去掉已经没有任何子行的 `- insert:` 块，并压掉多余空行。
 * @param {string} text - 文本。
 * @returns {string} 清理后的文本。
 */
export function collapseEmptyInserts(text) {
  // 末尾那一行没有换行符，所以“后面没有子行”必须同时承认字符串结尾，
  // 否则文件最后剩下的空 insert 永远删不掉。
  return text
    .replace(/^[ \t]*- insert:[ \t]*(?:\n(?![ \t]+- )|$)/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s*$/, '')
}
