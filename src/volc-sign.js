/**
 * 火山引擎（Volcengine）签名 V4 —— 只实现验证过的最小面。
 *
 * ## 为什么需要这个文件
 *
 * 火山方舟的**用量/套餐额度接口在控制面 OpenAPI 上**（`open.volcengineapi.com`），
 * 而不是数据面推理域名（`ark.cn-beijing.volces.com`，那只是模型调用的 baseURL）。
 * 控制面**强制 AK/SK 签名**，官方文档把「静态长效 AK/SK → 直接 V4 签名」列为三条
 * 控制面鉴权路径之一。
 *
 * **推理用的 `ark-` 开头那把 Bearer Key 在这里完全不能用**：实测把它塞进
 * `Authorization`，网关在**格式层**就拒了（HTTP 400 / `InvalidAuthorization`
 * 100024），不是权限问题。所以额度查询要的是火山账号的 AccessKey ID + Secret
 * AccessKey，与推理 Key 是**两套凭据**。
 *
 * ## 算法要点（照搬标准 AWS SigV4 会签名失败）
 *
 * 这是 AWS SigV4 的火山变体，三处差异：
 *   1. algorithm 串是 `HMAC-SHA256`，**没有 `AWS4` 前缀**；
 *   2. credential scope 以 `request` 结尾，**不是** `aws4_request`；
 *   3. 签名密钥派生时 SK **不加** `AWS4` 前缀（`kDate = HMAC(SK, YYYYMMDD)`）。
 *
 * ## 关于「canonical headers 要不要排序」这个坑
 *
 * 社区实现里对此说法不一（有说必须固定顺序、按字母序会失败）。这里**刻意不从数组
 * 里硬编码顺序**，而是排序一次、然后 `SignedHeaders` 与 canonical headers **都由这
 * 一份排好序的数组生成**——于是两者在构造上不可能不一致。
 *
 * SigV4 的服务端是按请求里 `SignedHeaders` 列出的顺序去重建 canonical request 的，
 * 因此只要「签名方算的」与「自己声明的」一致就能通过；不一致才是失败原因。用同一
 * 数组生成两处，就把这个失败模式从根上消掉了，也不必赌哪种顺序对。
 *
 * ## 纯函数、无 IO
 *
 * 这里只做字符串与摘要计算，不碰网络也不读时钟（`now` 由调用方传入），
 * 因此可以直接跑确定性断言（见 tools/test.mjs）。
 * @module dsh-pixel-dashboard/lib/volc-sign
 */

import { createHash, createHmac } from 'node:crypto'

/** 控制面 OpenAPI 网关。**固定**，不接受任何改写（端点决定凭据发给谁）。 */
export const VOLC_OPENAPI_HOST = 'open.volcengineapi.com'

/** 控制面 API 版本。 */
export const VOLC_API_VERSION = '2024-01-01'

/** Agent/Coding Plan 目前在 cn-beijing。 */
export const VOLC_DEFAULT_REGION = 'cn-beijing'

/** 签名与鉴权里用的 service 名（服务端会回显同一个值）。 */
export const VOLC_SERVICE = 'ark'

/** 请求体固定为这个 content-type（也参与签名）。 */
export const VOLC_CONTENT_TYPE = 'application/json; charset=utf-8'

/** 空 body 的 SHA-256，省一次摘要。 */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** 十六进制 SHA-256。 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** HMAC-SHA256，返回字节。 */
function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

/**
 * RFC3986 编码：除 unreserved（`A-Za-z0-9-_.~`）外全部 `%XX`。
 * 注意不能直接用 `encodeURIComponent`——它不编码 `!'()*`，与 SigV4 要求不符。
 * @param {string} input - 原始串。
 * @returns {string} 编码后的串。
 */
export function uriEncode(input) {
  let out = ''
  for (const byte of Buffer.from(String(input), 'utf8')) {
    const char = String.fromCharCode(byte)
    out += /[A-Za-z0-9\-_.~]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/**
 * 构造 canonical query string：按 key 字母序、逐段编码。
 *
 * 返回值**同时用于签名和实际请求 URL**，保证两者逐字一致——不一致就会签名不匹配。
 * @param {string} action - OpenAPI Action，如 `GetCodingPlanUsage`。
 * @param {string} [region] - 区域，默认 cn-beijing。
 * @returns {string} 形如 `Action=X&Region=cn-beijing&Version=2024-01-01`。
 */
export function canonicalQuery(action, region = VOLC_DEFAULT_REGION) {
  return [
    ['Action', action],
    ['Region', region],
    ['Version', VOLC_API_VERSION],
  ]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join('&')
}

/**
 * 把毫秒时间戳格式化成签名用的两个日期串。
 * @param {number} now - 毫秒时间戳。
 * @returns {{xDate:string,shortDate:string}} `20240621T000000Z` 与 `20240621`。
 */
export function volcDates(now) {
  // toISOString 是 UTC，正好是火山要求的 UTC 时间戳
  const iso = new Date(now).toISOString()
  const xDate = `${iso.slice(0, 10).replace(/-/g, '')}T${iso.slice(11, 19).replace(/:/g, '')}Z`
  return { xDate, shortDate: xDate.slice(0, 8) }
}

/**
 * 生成火山签名 V4 的鉴权头。
 *
 * 返回三个头都要带上：`Authorization` / `X-Date` / `X-Content-Sha256`。
 * `canonicalQueryString` 必须与实际请求 URL 的 query **完全一致**。
 * @param {object} input - 输入。
 * @param {string} input.accessKeyId - AccessKey ID。
 * @param {string} input.secretAccessKey - Secret Access Key。
 * @param {string} input.action - OpenAPI Action。
 * @param {string} [input.region] - 区域。
 * @param {string} [input.body] - 请求体（默认空串，与会话里的 body 一致）。
 * @param {number} [input.now] - 毫秒时间戳（默认当前时间；测试可注入）。
 * @returns {{authorization:string,xDate:string,xContentSha256:string,query:string,url:string}} 签名结果。
 */
export function signVolcRequest({
  accessKeyId,
  secretAccessKey,
  action,
  region = VOLC_DEFAULT_REGION,
  body = '',
  now = Date.now(),
}) {
  const query = canonicalQuery(action, region)
  const { xDate, shortDate } = volcDates(now)
  const bodyText = String(body ?? '')
  const xContentSha256 = bodyText === '' ? EMPTY_SHA256 : sha256Hex(bodyText)

  // 排序一次，两处共用：canonical headers 与 SignedHeaders 由同一数组生成，
  // 构造上不可能不一致（见文件头说明）。
  const headers = [
    ['content-type', VOLC_CONTENT_TYPE],
    ['host', VOLC_OPENAPI_HOST],
    ['x-content-sha256', xContentSha256],
    ['x-date', xDate],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value}\n`).join('')
  const signedHeaders = headers.map(([name]) => name).join(';')

  const canonicalRequest = [
    'POST',
    '/',
    query,
    canonicalHeaders,
    signedHeaders,
    xContentSha256,
  ].join('\n')

  const credentialScope = `${shortDate}/${region}/${VOLC_SERVICE}/request`
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  // 派生链：SK 不加 AWS4 前缀，终止串是 request
  const kDate = hmac(Buffer.from(secretAccessKey, 'utf8'), shortDate)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, VOLC_SERVICE)
  const kSigning = hmac(kService, 'request')
  const signature = hmac(kSigning, stringToSign).toString('hex')

  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    authorization,
    xDate,
    xContentSha256,
    query,
    url: `https://${VOLC_OPENAPI_HOST}/?${query}`,
  }
}

/**
 * 从火山 OpenAPI 响应里抽 `ResponseMetadata.Error`（或顶层 `Error`）。
 *
 * 火山网关的失败**不一定走 HTTP 状态码**：业务错误常以 200/400 携带同一份信封返回，
 * 所以必须解析信封，只看状态码会把失败当成功。
 * @param {object} body - 响应体。
 * @returns {{code:string,message:string}|undefined} 错误；无错时 undefined。
 */
export function volcResponseError(body) {
  const error = body?.ResponseMetadata?.Error ?? body?.Error
  if (error === null || typeof error !== 'object') return undefined
  const code = typeof error.Code === 'string' ? error.Code : ''
  const message = typeof error.Message === 'string' ? error.Message : ''
  if (code === '' && message === '') return undefined
  return { code, message }
}

/**
 * 判断火山错误码是否属于**鉴权类**。
 *
 * 用途只有一个：把「凭据不对」与「接口/权限其它问题」分开，前者要给出
 * 「这里要的是 AK/SK，不是 ark- 推理 Key」这条唯一有用的提示。
 * @param {string} code - 错误码。
 * @returns {boolean} 是否鉴权类。
 */
export function isVolcAuthErrorCode(code) {
  const text = String(code ?? '').toLowerCase()
  return text.includes('auth')
    || text.includes('signature')
    || text.includes('accessdenied')
    || text.includes('denied')
    || text.includes('unauthorized')
    || text.includes('forbidden')
    || text.includes('credential')
    || text.includes('accesskey')
    || text.includes('secret')
    || text.includes('token')
}
