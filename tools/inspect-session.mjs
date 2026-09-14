/**
 * 会话日志探针：按 dsh-session-persistence-jsonl 的帧格式扫描 .jsonl.zstd，
 * 打印事件类型分布，并抽样展示承载 usage / 模型信息的事件结构。
 *
 * 用法: node tools/inspect-session.mjs <日志文件> [抽样条数]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216

/** 复刻后端 scanZstdFrames：只走帧头/块头，不解压块内容 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remaining) return frames
    offset += remaining
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function readLines(file) {
  const bytes = readFileSync(file)
  const frames = scanZstdFrames(bytes)
  const lines = []
  for (const { start, end } of frames) {
    const text = zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')
    for (const line of text.split('\n')) if (line.trim() !== '') lines.push(JSON.parse(line))
  }
  return lines
}

const file = process.argv[2]
const sampleCount = Number(process.argv[3] ?? 3)
const rows = readLines(file)

const kinds = new Map()
for (const row of rows) kinds.set(row.type, (kinds.get(row.type) ?? 0) + 1)
console.log('== 事件类型分布 ==')
for (const [type, count] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(String(count).padStart(6), type)

// 找出带 usage / model 的事件类型，作为看板数据来源的证据
const usageTypes = new Set()
const modelTypes = new Set()
for (const row of rows) {
  const blob = JSON.stringify(row)
  if (blob.includes('"usage"')) usageTypes.add(row.type)
  if (blob.includes('"model"')) modelTypes.add(row.type)
}
console.log('\n== 带 usage 的事件类型 ==', [...usageTypes].join(', ') || '(无)')
console.log('== 带 model 的事件类型 ==', [...modelTypes].join(', ') || '(无)')

for (const type of usageTypes) {
  console.log(`\n== ${type} 抽样 ==`)
  const picked = rows.filter((r) => r.type === type).slice(0, sampleCount)
  for (const row of picked) {
    const { usage, ...rest } = row
    console.log(JSON.stringify({ ...rest, usage }, null, 1).slice(0, 1400), '\n---')
  }
}
