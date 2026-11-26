import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createDeskContext, startStandaloneServer } from '../src/host.js'
import { mediaDeskHome } from '../src/store.js'

const execFileAsync = promisify(execFile)
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('mediaDeskHome 優先使用 MEDIA_DESK_HOME，其次 DSH_HOME', () => {
  assert.equal(mediaDeskHome({ MEDIA_DESK_HOME: '/tmp/md', DSH_HOME: '/tmp/dsh' }), '/tmp/md')
  assert.equal(mediaDeskHome({ DSH_HOME: '/tmp/dsh' }), '/tmp/dsh')
})

test('applyAgentDraft 支援無圖片直出與搭配生圖渲染', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-agent-'))
  try {
    const desk = createDeskContext({ root })
    const item = (await desk.store.read()).items[0]

    // 1. 不生圖直接寫入成稿
    const doneProd = await desk.producer.applyAgentDraft(item.id, {
      format: 'article',
      withImages: false,
      plan: {
        title: '智能體直出標題',
        coverText: '封面大字',
        facts: ['事實一'],
        outline: ['大綱一'],
        cover: '極簡封面提示詞',
        images: [{ prompt: '配圖一提示詞', caption: '圖說' }],
        shots: [{ no: 1, shot: '特寫', visual: '畫面', voice: '旁白' }],
      },
      article: '# 智能體直出標題\n\n這是完整的正文。',
    })
    assert.equal(doneProd.status, 'done')
    assert.equal(doneProd.title, '智能體直出標題')
    assert.equal(doneProd.cover.status, 'skipped')
    assert.equal(doneProd.article, '這是完整的正文。')

    // 2. 設定生圖模型並由 applyAgentDraft 自動渲染圖片
    await desk.settings.update({
      image: { protocol: 'openai', baseUrl: 'https://img.example.com/v1', apiKey: 'sk-test', model: 'img-1' },
      generateImages: true,
      imageCount: 1,
      shotCount: 1,
    })
    const deskWithFakeFetch = createDeskContext({ root })
    // 攔截 fetch 模擬圖片回傳
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    try {
      const imgProd = await deskWithFakeFetch.producer.applyAgentDraft(item.id, {
        format: 'script',
        withImages: true,
        plan: {
          title: '帶圖成稿標題',
          coverText: '帶圖封面',
          cover: '封面畫面',
          images: [{ prompt: '配圖畫面', caption: '配圖' }],
          shots: [{ no: 1, shot: '全景', visual: '分鏡畫面', voice: '口播句' }],
        },
        article: '# 帶圖成稿標題\n\n第一句口播。\n第二句口播。',
      })
      assert.equal(imgProd.status, 'done')
      assert.equal(imgProd.cover.status, 'done')
      assert.ok(imgProd.cover.src)
      assert.equal(imgProd.images[0].status, 'done')
      assert.equal(imgProd.shots[0].status, 'done')
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('startStandaloneServer 可獨立啟動並處理 style/apply 與 produce/apply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-server-'))
  const srv = await startStandaloneServer({ port: 0, host: '127.0.0.1', root })
  try {
    const stateRes = await fetch(`${srv.url}/media-desk/state`)
    assert.equal(stateRes.status, 200)
    const { state } = await stateRes.json()
    assert.ok(Array.isArray(state.items))

    const styleRes = await fetch(`${srv.url}/media-desk/style/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        style: { name: '測試風格', summary: '簡潔直接', tone: '口語' },
      }),
    })
    assert.equal(styleRes.status, 200)
    const styleData = await styleRes.json()
    assert.equal(styleData.state.activeStyleId, styleData.id)
    const appliedStyle = styleData.state.styles.find(s => s.id === styleData.id)
    assert.equal(appliedStyle.name, '測試風格')

    const itemId = state.items[0].id
    const prodRes = await fetch(`${srv.url}/media-desk/produce/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: itemId,
        withImages: false,
        plan: { title: 'HTTP 直出', coverText: '封面' },
        article: '# HTTP 直出\n\n正文內容。',
      }),
    })
    assert.equal(prodRes.status, 200)
    const prodData = await prodRes.json()
    assert.equal(prodData.production.title, 'HTTP 直出')
  } finally {
    await new Promise(resolve => srv.server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('media-desk CLI 端到端流程可正常執行', async () => {
  const home = await mkdtemp(join(tmpdir(), 'md-cli-'))
  const env = { ...process.env, MEDIA_DESK_HOME: home }
  const cli = join(process.cwd(), 'bin', 'media-desk.js')
  const runCli = async (...args) => {
    const { stdout } = await execFileAsync(process.execPath, [cli, ...args], { env })
    return JSON.parse(stdout)
  }

  try {
    const added = await runCli('item', 'add', '--title', 'CLI 測試靈感', '--body', '測試內容')
    assert.ok(added.item?.id)
    const id = added.item.id

    const promptCtx = await runCli('produce', 'prompt', id)
    assert.equal(promptCtx.item.id, id)
    assert.ok(promptCtx.planPrompts?.user)

    const planFile = join(home, 'plan.json')
    const articleFile = join(home, 'article.md')
    await writeFile(planFile, JSON.stringify({ title: 'CLI 成稿', coverText: 'CLI封面', outline: ['重點1'] }))
    await writeFile(articleFile, '# CLI 成稿\n\n這是透過 CLI 寫入的內容。')

    const applied = await runCli('produce', 'apply', id, '--plan-file', planFile, '--article-file', articleFile, '--no-images')
    assert.equal(applied.production.title, 'CLI 成稿')
    assert.equal(applied.production.status, 'done')

    const stylePrompt = await runCli('style', 'prompt', '--name', 'CLI風格', '--text', '這是一段測試原文，語氣乾脆俐落。')
    assert.ok(stylePrompt.user?.includes('語氣乾脆俐落'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('自定義第三方助手模型：支援 OpenAI 與 Anthropic 兼容接口、密鑰脫敏與測試連接', async () => {
  const { setAssistantCustom } = await import('../src/ai.js')
  const root = await mkdtemp(join(tmpdir(), 'md-custom-llm-'))
  const srv = await startStandaloneServer({ port: 0, host: '127.0.0.1', root })
  const originalFetch = globalThis.fetch
  try {
    // 1. 儲存 OpenAI 兼容自定義模型設定（自動去掉末尾 /chat/completions，且不回傳明文 apiKey）
    const saveRes = await originalFetch(`${srv.url}/media-desk/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assistantCustom: {
          enabled: true,
          protocol: 'openai',
          baseUrl: 'https://llm.example.com/v1/chat/completions',
          model: 'deepseek-v3-custom',
          apiKey: 'sk-secret-9876',
        },
      }),
    })
    assert.equal(saveRes.status, 200)
    const saved = await saveRes.json()
    assert.equal(saved.assistantCustom.enabled, true)
    assert.equal(saved.assistantCustom.baseUrl, 'https://llm.example.com/v1')
    assert.equal(saved.assistantCustom.model, 'deepseek-v3-custom')
    assert.equal(saved.assistantCustom.hasKey, true)
    assert.equal(saved.assistantCustom.keyHint, '9876')
    assert.equal(saved.assistantCustom.apiKey, undefined)
    assert.equal(saved.assistantEffective, 'deepseek-v3-custom')

    // 2. 攔截第三方 LLM 請求，驗證 assistant/test
    const captured = []
    globalThis.fetch = async (url, init) => {
      const href = String(url)
      if (href.startsWith(srv.url)) return originalFetch(url, init)
      captured.push({ url: href, headers: init?.headers, body: JSON.parse(init?.body || '{}') })
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'OK from custom OpenAI' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const testRes = await originalFetch(`${srv.url}/media-desk/assistant/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(testRes.status, 200)
    const testData = await testRes.json()
    assert.equal(testData.ok, true)
    assert.equal(testData.model, 'deepseek-v3-custom')
    assert.equal(testData.reply, 'OK from custom OpenAI')
    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, 'https://llm.example.com/v1/chat/completions')
    assert.equal(captured[0].headers.authorization, 'Bearer sk-secret-9876')

    // 3. 切換為 Anthropic 兼容協議（空 apiKey 不覆蓋舊密鑰）
    const anthSave = await originalFetch(`${srv.url}/media-desk/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assistantCustom: {
          enabled: true,
          protocol: 'anthropic',
          baseUrl: 'https://api.anthropic.example.com/v1/messages',
          model: 'claude-sonnet-4-5',
          apiKey: '',
        },
      }),
    })
    assert.equal(anthSave.status, 200)
    const anthSaved = await anthSave.json()
    assert.equal(anthSaved.assistantCustom.baseUrl, 'https://api.anthropic.example.com/v1')
    assert.equal(anthSaved.assistantCustom.hasKey, true)

    globalThis.fetch = async (url, init) => {
      const href = String(url)
      if (href.startsWith(srv.url)) return originalFetch(url, init)
      captured.push({ url: href, headers: init?.headers, body: JSON.parse(init?.body || '{}') })
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'OK from custom Anthropic' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const anthTest = await originalFetch(`${srv.url}/media-desk/assistant/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(anthTest.status, 200)
    const anthData = await anthTest.json()
    assert.equal(anthData.reply, 'OK from custom Anthropic')
    assert.equal(captured[1].url, 'https://api.anthropic.example.com/v1/messages')
    assert.equal(captured[1].headers['x-api-key'], 'sk-secret-9876')
  } finally {
    globalThis.fetch = originalFetch
    setAssistantCustom(null)
    await new Promise(resolve => srv.server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

