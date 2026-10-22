import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  BLOCK_BEGIN, applyDshConfig, applyDshProviders, dshCredentialFile, dshProfileFile, effortLevelsOf,
  inputTypesOf, newlineOf, removeDshConfig, removeDshProviders, removeDshCredential, setDshCredential,
} from '../src/dsh.mjs'

const LF = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      opencode-go:',
  '        apiKeyEnv: OPENCODE_GO_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://opencode.ai/zen/go/v1',
  '- id: agent-default-model',
  '  config:',
  '    provider: opencode-go',
  '',
].join('\n')

const SOURCES = [
  { id: 'cn', models: [{ id: 'cn/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxOutputTokens: 128000 }] },
  { id: 'intl', models: [{ id: 'intl/hy3', name: 'Hy3', contextWindow: 192000, maxOutputTokens: 64000 }] },
]

function scratch (content = LF, name = 'cordis.patch.yml') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-dsh-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return { dir, file }
}

test('DSH provider：插到 llm-pi-ai 的 providers 下，带托管标记，写前备份', () => {
  const { file } = scratch()
  const result = applyDshProviders({ file, port: 8788, sources: SOURCES })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.ok(result.backup !== undefined && fs.existsSync(result.backup), '写前必须备份')

  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes(BLOCK_BEGIN))
  // 缩进跟随 sibling（6），字段 +2，模型条目 +4
  assert.match(text, /^ {6}workbuddy-cn:$/m)
  assert.match(text, /^ {8}baseURL: http:\/\/127\.0\.0\.1:8788$/m)
  assert.match(text, /^ {8}apiKeyEnv: FLOW_ONE_BRIDGE_KEY$/m)
  assert.match(text, /^ {10}- id: cn\/deepseek-v4\.1-flash$/m)
  assert.match(text, /^ {12}contextWindow: 1000000$/m)
  assert.match(text, /^ {6}workbuddy-intl:$/m)
  // oc/ocg 不重复写（DSH 里本来就有自己的 provider）
  assert.doesNotMatch(text, /workbuddy-oc/)
  // 原有内容一个都不能丢，而且位置不动（我们只追加在 providers 末尾）
  assert.match(text, /opencode-go:/)
  assert.match(text, /- id: agent-default-model/)
  assert.ok(text.indexOf('opencode-go:') < text.indexOf(BLOCK_BEGIN), '既有 provider 原地不动')
})

test('DSH provider：重跑幂等（只有一段、不叠标记）', () => {
  const { file } = scratch()
  applyDshProviders({ file, port: 8788, sources: SOURCES })
  const first = fs.readFileSync(file, 'utf8')
  const again = applyDshProviders({ file, port: 8788, sources: SOURCES })
  assert.equal(again.changed, false, '内容没变就不该再写（也不该多出备份）')
  assert.equal(fs.readFileSync(file, 'utf8'), first)
  assert.equal(first.split(BLOCK_BEGIN).length - 1, 1)
})

test('DSH provider：CRLF 的文件写出来还是 CRLF（Windows 上别给我搞成混合换行）', () => {
  const crlf = LF.replace(/\n/g, '\r\n')
  const { file } = scratch(crlf)
  assert.equal(newlineOf(crlf), '\r\n')
  applyDshProviders({ file, port: 8788, sources: SOURCES })
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes('\r\n'))
  // 不允许出现「只有 LF、没有 CR」的行尾
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/)
})

test('DSH provider：手写的旧 workbuddy 条目会被接管（不留下重复 key）', () => {
  const loose = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      opencode-go:',
    '        api: openai-completions',
    '      workbuddy-cn:',
    '        displayName: 手写的',
    '        baseURL: http://127.0.0.1:8788',
    '        models:',
    '          - id: cn/deepseek-v4.1-flash',
    '- id: agent-default-model',
    '',
  ].join('\n')
  const { file } = scratch(loose)
  applyDshProviders({ file, port: 8788, sources: SOURCES })
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.split('workbuddy-cn:').length - 1, 1, '同一个 key 只能出现一次')
  assert.doesNotMatch(text, /displayName: 手写的/)
})

test('DSH provider：卸载只删托管段，别人写的 provider 不动', () => {
  const { file } = scratch()
  applyDshProviders({ file, port: 8788, sources: SOURCES })
  const removed = removeDshProviders({ file })
  assert.equal(removed.removed, true)
  const text = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(text, /workbuddy-cn:/)
  assert.doesNotMatch(text, /flow-one 托管/)
  assert.match(text, /opencode-go:/)
  // 再删一次：没事可做
  assert.equal(removeDshProviders({ file }).removed, false)
})

test('DSH provider：找不到 llm-pi-ai 的 providers 段时诚实拒绝，不乱写', () => {
  const { file } = scratch(['- id: something-else', '  config: {}', ''].join('\n'))
  const result = applyDshProviders({ file, port: 8788, sources: SOURCES })
  assert.equal(result.ok, false)
  assert.match(result.reason, /llm-pi-ai/)
})

test('DSH 凭据：写进 refs、重跑替换、卸载只删自己那条', () => {
  const { file } = scratch(['version: 1', 'refs:', '  DEEPSEEK_API_KEY: "sk-1"', 'records: {}', ''].join('\n'), '.credentials.yaml')
  setDshCredential({ file, apiKey: 'first-key' })
  let text = fs.readFileSync(file, 'utf8')
  assert.match(text, /FLOW_ONE_BRIDGE_KEY: "first-key"/)
  assert.match(text, /DEEPSEEK_API_KEY: "sk-1"/)

  setDshCredential({ file, apiKey: 'second-key' })
  text = fs.readFileSync(file, 'utf8')
  assert.equal(text.split('FLOW_ONE_BRIDGE_KEY:').length - 1, 1, '重跑只能有一条')
  assert.match(text, /FLOW_ONE_BRIDGE_KEY: "second-key"/)

  assert.equal(removeDshCredential({ file }).removed, true)
  text = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(text, /FLOW_ONE_BRIDGE_KEY/)
  assert.match(text, /DEEPSEEK_API_KEY: "sk-1"/, '别人的凭据不能动')
})

test('applyDshConfig：provider + 凭据一步到位；没有 cn/intl 模型就不写', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-dsh-home-'))
  const env = { DSH_HOME: path.join(home, '.dsh') }
  fs.mkdirSync(path.join(env.DSH_HOME, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(env.DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'), LF)
  fs.writeFileSync(path.join(env.DSH_HOME, '.credentials.yaml'), ['version: 1', 'refs:', ''].join('\n'))

  assert.equal(dshProfileFile({ env, home }).file, path.join(env.DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'))
  assert.equal(dshCredentialFile({ env, home }), path.join(env.DSH_HOME, '.credentials.yaml'))

  const rows = [...SOURCES[0].models, ...SOURCES[1].models, { id: 'ocg/deepseek-v4.1-flash' }]
  const applied = applyDshConfig({ port: 8788, apiKey: 'bridge-key', rows, env, home })
  assert.equal(applied.ok, true)
  assert.equal(applied.models, 2)

  const removed = removeDshConfig({ env, home })
  assert.equal(removed.removed, true)
  assert.doesNotMatch(fs.readFileSync(applied.file, 'utf8'), /workbuddy-cn/)
  assert.doesNotMatch(fs.readFileSync(applied.credential, 'utf8'), /FLOW_ONE_BRIDGE_KEY/)

  // 只挂了 oc/ocg 时没东西可写
  assert.equal(applyDshConfig({ port: 8788, apiKey: 'k', rows: [{ id: 'ocg/x' }], env, home }).ok, false)
})

/** 取某个模型条目在 YAML 文本里占的行（到下一个 `- id:` 为止）。 */
function modelLines (text, id) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === `- id: ${id}`)
  assert.ok(start >= 0, `没有找到模型 ${id}`)
  const out = []
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*- id:/.test(lines[index])) break
    out.push(lines[index].trim())
  }
  return out
}

test('DSH provider：模型条目照 DSH 自己的形状补齐 input 与 reasoningEfforts', () => {
  const { file } = scratch()
  applyDshProviders({
    file,
    port: 8788,
    sources: [{
      id: 'cn',
      models: [
        { id: 'cn/vision', name: 'Vision', contextWindow: 1000, maxOutputTokens: 100, supportsImages: true, efforts: ['max', 'low', 'high'] },
        { id: 'cn/text-only', name: 'Text', contextWindow: 1000, maxOutputTokens: 100, supportsImages: false },
        { id: 'cn/unknown', name: 'Unknown' },
      ],
    }],
  })
  const text = fs.readFileSync(file, 'utf8')

  // 视觉模型：text + image；档位升序，off 在最前且值为 null（和 DSH UI 写出来的一致）
  const vision = modelLines(text, 'cn/vision')
  assert.deepEqual(vision.filter(line => line.startsWith('- ')), ['- text', '- image'])
  assert.deepEqual(
    vision.filter(line => /^(off|minimal|low|medium|high|xhigh|max):/.test(line)),
    ['off: null', 'low: low', 'high: high', 'max: max'],
  )

  // 纯文本模型：显式只声明 text（同时也覆盖视觉模型的默认继承）
  assert.deepEqual(modelLines(text, 'cn/text-only').filter(line => line.startsWith('- ')), ['- text'])
  assert.deepEqual(modelLines(text, 'cn/text-only').filter(line => line.startsWith('off:')), [])

  // 上游没给能力元数据：按纯文本 + 不给档位（不编造选项）
  const unknown = modelLines(text, 'cn/unknown')
  assert.deepEqual(unknown.filter(line => line.startsWith('- ')), ['- text'])
  assert.deepEqual(unknown.filter(line => line.includes('reasoningEfforts')), [])
})

test('DSH provider：sample 的元数据解析（input / efforts）按保守规则', () => {
  // 显式 input 优先于 supportsImages
  assert.deepEqual(inputTypesOf({ supportsImages: true, input: ['text'] }), ['text'])
  assert.deepEqual(inputTypesOf({ supportsImages: true }), ['text', 'image'])
  assert.deepEqual(inputTypesOf({ supportsImages: false }), ['text'])
  assert.deepEqual(inputTypesOf({}), ['text'])
  // 档位去重、按升级顺序排，off 不混进档位列表
  assert.deepEqual(effortLevelsOf({ efforts: ['max', 'off', 'low', 'high', 'low'] }), ['low', 'high', 'max'])
  assert.deepEqual(effortLevelsOf({}), [])
})
