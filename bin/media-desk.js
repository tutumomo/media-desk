#!/usr/bin/env node
// 自媒體工作台（Media Desk）標準技能 CLI：讓任何通用智能體都能透過命令列操作靈感、風格、成稿、生圖、排期、復盤與獨立 Web 工作台。
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { articlePrompts, planPrompts } from '../src/ai.js'
import { resolveExportDir, saveProduction } from '../src/export.js'
import { harvest, harvestText } from '../src/harvest.js'
import { createDeskContext, startStandaloneServer } from '../src/host.js'
import { withLang } from '../src/i18n.js'
import { computeInsights, exportSkill, proposeRules } from '../src/learn.js'
import { applyOps, PLATFORMS, STATUSES } from '../src/ops.js'
import { applyRevision } from '../src/produce.js'
import { publicSettings } from '../src/settings.js'
import { dshHome } from '../src/store.js'
import { referenceExcerpt, stylePrompts, styleToVoice } from '../src/style.js'

const HELP = `Media Desk CLI — 自媒體工作台標準技能工具

用法:
  media-desk <command> [options]

工作台狀態與設定:
  state [--compact]                       查看目前靈感、風格、規則與設定摘要
  undo                                    撤銷上一步操作
  clear-samples                           清空內建示例資料（保留使用者資料與預設風格）
  config show                             查看目前生圖與匯出設定（隱藏金鑰）
  config set [--protocol openai|bailian|wan] [--base-url URL] [--api-key KEY]
             [--model NAME] [--size WxH] [--image-count N] [--shot-count N]
             [--generate-images true|false] [--export-dir DIR]
  serve [--port 4311] [--host 127.0.0.1]  啟動獨立視覺化 Web 工作台

靈感與素材管理:
  item list [--status S] [--platform P]   列出靈感條目
  item get <id>                           查看單條靈感與成稿詳情
  item add --title TEXT [--body TEXT] [--kind note|image|video|web|quote]
           [--tags a,b] [--status idea|outline|draft|ready|published]
           [--platform P] [--scheduled-at ISO] [--url URL]
  item update <id> [--title ...] [--body ...] [--status ...] [--platform ...] [--tags ...]
  item delete <id>                        刪除靈感條目
  harvest <url> [--save] [--text-only]    抓取公開網頁標題/摘要/正文（--save 存為靈感）

風格與體裁:
  style list                              列出所有風格卡
  style use <id|null>                     切換目前使用的風格（null 表示不用特定風格）
  style prompt [--name NAME] [--text TEXT | --file PATH | --url URL]
                                          輸出風格提煉提示詞，供智能體分析原文並產出風格卡 JSON
  style apply (--file PATH | --json JSON) [--name NAME] [--source TEXT]
                                          寫入智能體提煉出的風格卡並設為啟用
  format <script|article>                 切換預設成稿體裁（口播腳本 / 文章）

一鍵成稿與修訂:
  produce prompt <id>                     輸出成稿所需的完整上下文（靈感、風格卡與原文節錄、規則、提示詞）
  produce apply <id> (--plan JSON | --plan-file PATH) (--article TEXT | --article-file PATH)
                     [--format script|article] [--with-images | --no-images]
                                          寫入智能體生成的策劃案與正文，並可選觸發自動生圖
  produce revise <id> (--file PATH | --json JSON) [--render]
                                          局部或整篇修訂成稿（--render 會重畫有更動的圖片）
  produce render <id> [--target cover|image:0|shot:0]
                                          補畫或重畫指定成稿的圖片資產
  produce export <id> [--dir PATH]        匯出成稿資料夾（腳本/文章 Markdown、封面、配圖、分鏡）

排期、復盤與寫作規則:
  schedule <id> <ISO|null> [--platform P] 設定或取消排期
  metric add [--item ID] --platform P [--date ISO] [--views N] [--likes N]
             [--comments N] [--shares N] [--saves N]
  insights [--propose]                    計算數據洞察（--propose 同時自動產生規則提案）
  skill list                              列出寫作規則
  skill add --name NAME --rule RULE [--status active|proposed]
  skill update <id> [--name ...] [--rule ...] [--status active|proposed|dismissed]
  skill delete <id>
  skill export [--dir PATH]               匯出已啟用規則為 SKILL.md
`

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
}

function fail(message, code = 1) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`)
  process.exit(code)
}

async function readInput({ json, file, text, textFile, label = 'input' }) {
  if (file) {
    const raw = file === '-' ? await readStdin() : await readFile(file, 'utf8')
    return JSON.parse(raw)
  }
  if (json) return JSON.parse(json)
  if (textFile) return textFile === '-' ? await readStdin() : await readFile(textFile, 'utf8')
  if (text !== undefined) return text
  throw new Error(`缺少 ${label} 參數`)
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function parseBool(value) {
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`無效的布林值：${value}`)
}

function parseNum(value, name) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${name} 必須是數字`)
  return n
}

async function run() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(HELP)
    return
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      lang: { type: 'string' },
      root: { type: 'string' },
      compact: { type: 'boolean' },
      title: { type: 'string' },
      body: { type: 'string' },
      kind: { type: 'string' },
      tags: { type: 'string' },
      status: { type: 'string' },
      platform: { type: 'string' },
      'scheduled-at': { type: 'string' },
      url: { type: 'string' },
      save: { type: 'boolean' },
      'text-only': { type: 'boolean' },
      name: { type: 'string' },
      text: { type: 'string' },
      file: { type: 'string' },
      json: { type: 'string' },
      source: { type: 'string' },
      plan: { type: 'string' },
      'plan-file': { type: 'string' },
      article: { type: 'string' },
      'article-file': { type: 'string' },
      format: { type: 'string' },
      'with-images': { type: 'boolean' },
      'no-images': { type: 'boolean' },
      render: { type: 'boolean' },
      target: { type: 'string' },
      dir: { type: 'string' },
      item: { type: 'string' },
      date: { type: 'string' },
      views: { type: 'string' },
      likes: { type: 'string' },
      comments: { type: 'string' },
      shares: { type: 'string' },
      saves: { type: 'string' },
      propose: { type: 'boolean' },
      rule: { type: 'string' },
      protocol: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      model: { type: 'string' },
      size: { type: 'string' },
      'image-count': { type: 'string' },
      'shot-count': { type: 'string' },
      'generate-images': { type: 'string' },
      'export-dir': { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
    },
  })

  const lang = values.lang || process.env.MEDIA_DESK_LANG || 'zh'
  await withLang(lang, async () => {
    const [cmd, sub, ...rest] = positionals
    const root = values.root || undefined

    if (cmd === 'serve') {
      const port = values.port ? parseNum(values.port, 'port') : undefined
      const host = values.host || '127.0.0.1'
      const srv = await startStandaloneServer({ port, host, root })
      printJson({ url: srv.url, port: srv.port, root: srv.store.root })
      return
    }

    const { store, settings, producer } = createDeskContext({ root })

    if (cmd === 'state') {
      const state = await store.read()
      if (values.compact) {
        printJson({
          activeStyleId: state.activeStyleId ?? null,
          draftFormat: state.draftFormat ?? 'script',
          styles: (state.styles ?? []).map(s => ({ id: s.id, name: s.name, summary: s.summary })),
          items: state.items.map(i => ({
            id: i.id, title: i.title, kind: i.kind, status: i.status,
            platform: i.platform ?? null, scheduledAt: i.scheduledAt ?? null,
            produced: i.production?.status === 'done',
          })),
          skills: state.skills.map(s => ({ id: s.id, name: s.name, status: s.status, rule: s.rule })),
        })
      } else {
        printJson(state)
      }
      return
    }

    if (cmd === 'undo') {
      const result = await store.undo()
      printJson(result)
      return
    }

    if (cmd === 'clear-samples') {
      const result = await store.mutate('清空示例', (draft) => {
        const res = applyOps(draft, [{ op: 'clear_samples' }])
        return { state: draft, ...res }
      })
      printJson(result)
      return
    }

    if (cmd === 'config') {
      if (sub === 'show' || !sub) {
        const current = await settings.read()
        printJson({ ...publicSettings(current), ready: producer.ready(current), root: store.root })
        return
      }
      if (sub === 'set') {
        const patch = {}
        const image = {}
        if (values.protocol !== undefined) image.protocol = values.protocol
        if (values['base-url'] !== undefined) image.baseUrl = values['base-url']
        if (values['api-key'] !== undefined) image.apiKey = values['api-key']
        if (values.model !== undefined) image.model = values.model
        if (values.size !== undefined) image.size = values.size
        if (Object.keys(image).length) patch.image = image
        if (values['image-count'] !== undefined) patch.imageCount = parseNum(values['image-count'], 'image-count')
        if (values['shot-count'] !== undefined) patch.shotCount = parseNum(values['shot-count'], 'shot-count')
        if (values['generate-images'] !== undefined) patch.generateImages = parseBool(values['generate-images'])
        if (values['export-dir'] !== undefined) patch.exportDir = values['export-dir']
        const updated = await settings.update(patch)
        printJson({ ...publicSettings(updated), ready: producer.ready(updated) })
        return
      }
      throw new Error(`未知 config 子命令：${sub}`)
    }

    if (cmd === 'item') {
      if (sub === 'list') {
        const state = await store.read()
        let items = state.items
        if (values.status) items = items.filter(i => i.status === values.status)
        if (values.platform) items = items.filter(i => i.platform === values.platform)
        printJson(items)
        return
      }
      if (sub === 'get') {
        const id = rest[0]
        if (!id) throw new Error('請提供靈感 ID')
        const state = await store.read()
        const item = state.items.find(i => i.id === id)
        if (!item) throw new Error(`找不到靈感：${id}`)
        printJson(item)
        return
      }
      if (sub === 'add') {
        if (!values.title) throw new Error('請提供 --title')
        const op = {
          op: 'add_item',
          title: values.title,
          kind: values.kind || 'note',
          body: values.body || '',
          tags: values.tags ? values.tags.split(',').map(s => s.trim()).filter(Boolean) : [],
          status: STATUSES.includes(values.status) ? values.status : 'idea',
          ...(PLATFORMS.includes(values.platform) ? { platform: values.platform } : {}),
          ...(values['scheduled-at'] ? { scheduledAt: values['scheduled-at'] } : {}),
          ...(values.url ? { url: values.url } : {}),
        }
        const result = await store.mutate(`新增靈感「${values.title}」`, (draft) => {
          const res = applyOps(draft, [op])
          return { ...res, item: draft.items[0] }
        })
        printJson(result)
        return
      }
      if (sub === 'update') {
        const id = rest[0]
        if (!id) throw new Error('請提供靈感 ID')
        const op = { op: 'update_item', id }
        if (values.title !== undefined) op.title = values.title
        if (values.body !== undefined) op.body = values.body
        if (values.status !== undefined) op.status = values.status
        if (values.platform !== undefined) op.platform = values.platform
        if (values.url !== undefined) op.url = values.url
        if (values.tags !== undefined) op.tags = values.tags.split(',').map(s => s.trim()).filter(Boolean)
        const result = await store.mutate(`更新靈感 ${id}`, (draft) => {
          const res = applyOps(draft, [op])
          return { ...res, item: draft.items.find(i => i.id === id) ?? null }
        })
        printJson(result)
        return
      }
      if (sub === 'delete') {
        const id = rest[0]
        if (!id) throw new Error('請提供靈感 ID')
        const result = await store.mutate(`刪除靈感 ${id}`, (draft) => applyOps(draft, [{ op: 'delete_item', id }]))
        printJson(result)
        return
      }
      throw new Error(`未知 item 子命令：${sub}`)
    }

    if (cmd === 'harvest') {
      const targetUrl = sub
      if (!targetUrl) throw new Error('請提供要抓取的 URL')
      const data = values['text-only'] ? await harvestText(targetUrl) : await harvest(targetUrl)
      if (values.save && !values['text-only']) {
        const saved = await store.mutate(`抓取靈感「${data.title || targetUrl}」`, (draft) => {
          const res = applyOps(draft, [{
            op: 'add_item',
            kind: 'web',
            title: data.title || targetUrl,
            body: data.description || '',
            url: data.url,
            source: data.siteName || '',
            status: 'idea',
          }])
          return { ...res, item: draft.items[0] }
        })
        printJson({ harvested: data, saved })
        return
      }
      printJson(data)
      return
    }

    if (cmd === 'style') {
      if (sub === 'list') {
        const state = await store.read()
        printJson({ activeStyleId: state.activeStyleId ?? null, styles: state.styles ?? [] })
        return
      }
      if (sub === 'use') {
        const id = rest[0] === 'null' || !rest[0] ? null : rest[0]
        const result = await store.mutate(`切換風格`, (draft) => applyOps(draft, [{ op: 'set_style', id }]))
        printJson(result)
        return
      }
      if (sub === 'prompt') {
        let material = ''
        if (values.url) {
          const fetched = await harvestText(values.url)
          material = fetched.text
        } else if (values.file) {
          material = values.file === '-' ? await readStdin() : await readFile(values.file, 'utf8')
        } else if (values.text) {
          material = values.text
        } else {
          throw new Error('請提供 --url、--file 或 --text 作為風格分析素材')
        }
        const prompts = stylePrompts(material, values.name || '')
        printJson({ ...prompts, referenceExcerpt: referenceExcerpt(material) })
        return
      }
      if (sub === 'apply') {
        const payload = await readInput({ json: values.json, file: values.file, label: '--json / --file' })
        const body = payload.style ? payload : { style: payload }
        if (values.name) body.name = values.name
        if (values.source) body.source = values.source
        const { normalizeStyle } = await import('../src/style.js')
        const { newId } = await import('../src/ops.js')
        const style = normalizeStyle(body.style, typeof body.name === 'string' ? body.name.trim().slice(0, 20) : '')
        const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : '智能体提炼'
        const material = typeof body.reference === 'string' ? body.reference : typeof body.material === 'string' ? body.material : ''
        const result = await store.mutate(`提炼风格「${style.name}」`, (draft) => {
          const id = newId('st')
          const row = { id, ...style, reference: referenceExcerpt(material), source, sourceUrls: body.sourceUrls ?? [], createdAt: new Date().toISOString() }
          draft.styles = [row, ...(draft.styles ?? [])]
          draft.activeStyleId = id
          return { id, style: row, activeStyleId: id }
        })
        printJson(result)
        return
      }
      throw new Error(`未知 style 子命令：${sub}`)
    }

    if (cmd === 'format') {
      if (!['script', 'article'].includes(sub)) throw new Error('體裁只能是 script 或 article')
      const result = await store.mutate(`切換體裁為 ${sub}`, (draft) => applyOps(draft, [{ op: 'set_format', format: sub }]))
      printJson(result)
      return
    }

    if (cmd === 'produce') {
      if (sub === 'prompt') {
        const id = rest[0]
        if (!id) throw new Error('請提供靈感 ID')
        const state = await store.read()
        const saved = await settings.read()
        const item = state.items.find(i => i.id === id)
        if (!item) throw new Error(`找不到靈感：${id}`)
        const activeStyle = (state.styles ?? []).find(s => s.id === state.activeStyleId) ?? null
        const plan = planPrompts(state, item, saved)
        const article = articlePrompts(state, item, saved.voice, null)
        printJson({
          item,
          draftFormat: state.draftFormat ?? 'script',
          settings: { imageCount: saved.imageCount, shotCount: saved.shotCount, generateImages: saved.generateImages, imageReady: producer.ready(saved) },
          activeStyle: activeStyle ? { id: activeStyle.id, name: activeStyle.name, voice: styleToVoice(activeStyle), hasReference: Boolean(activeStyle.reference) } : null,
          activeRules: state.skills.filter(s => s.status === 'active' || s.status === 'exported'),
          planPrompts: plan,
          articlePrompts: article,
        })
        return
      }
      if (sub === 'apply') {
        const id = rest[0]
        if (!id) throw new Error('請提供靈感 ID')
        const plan = await readInput({ json: values.plan, file: values['plan-file'], label: '--plan / --plan-file' })
        const article = await readInput({ text: values.article, textFile: values['article-file'], label: '--article / --article-file' })
        const withImages = values['no-images'] ? false : values['with-images'] ? true : undefined
        const production = await producer.applyAgentDraft(id, { plan, article, format: values.format, withImages })
        printJson({ id, production })
        return
      }
      if (sub === 'revise') {
        const id = rest[0]
        if (!id) throw new Error('請提供靈感 ID')
        const revise = await readInput({ json: values.json, file: values.file, label: '--json / --file' })
        const saved = await settings.read()
        const canDraw = producer.ready(saved)
        let targets = []
        let receipts = []
        let errors = []
        await store.mutate(`修訂成稿 ${id}`, (draft) => {
          const target = draft.items.find(i => i.id === id)
          if (!target?.production) throw new Error(`靈感 ${id} 尚未有成稿`)
          const res = applyRevision(target.production, revise, { canDraw })
          targets = res.targets
          receipts = res.receipts
          errors = res.errors
          return draft
        })
        if (values.render && canDraw && targets.length) {
          await producer.renderAllAssets(id, { targets })
        }
        const latest = (await store.read()).items.find(i => i.id === id)?.production
        printJson({ id, receipts, errors, targets, production: latest })
        return
      }
      if (sub === 'render') {
        const id = rest[0]
        if (!id) throw new Error('請提供靈感 ID')
        const targets = values.target ? [values.target] : undefined
        const production = await producer.renderAllAssets(id, { targets })
        printJson({ id, production })
        return
      }
      if (sub === 'export') {
        const id = rest[0]
        if (!id) throw new Error('請提供靈感 ID')
        const state = await store.read()
        const savedSettings = await settings.read()
        const item = state.items.find(i => i.id === id)
        if (!item?.production?.article) throw new Error('還沒有可以匯出的成稿')
        const exportDir = values.dir ? resolveExportDir(values.dir) : resolveExportDir(savedSettings.exportDir)
        const result = await saveProduction(item.production, { filesDir: store.filesDir, exportDir })
        await store.mutate('保存成稿', (draft) => {
          const target = draft.items.find(i => i.id === id)
          if (target?.production) {
            target.production.savedPath = result.path
            target.production.savedHashes = result.hashes
            target.production.savedAt = new Date().toISOString()
          }
          return draft
        }, { undoable: false })
        printJson(result)
        return
      }
      throw new Error(`未知 produce 子命令：${sub}`)
    }

    if (cmd === 'schedule') {
      const id = sub
      const when = rest[0]
      if (!id || when === undefined) throw new Error('用法: media-desk schedule <id> <ISO|null> [--platform P]')
      const scheduledAt = when === 'null' ? null : when
      const op = { op: 'schedule_item', id, scheduledAt, ...(values.platform ? { platform: values.platform } : {}) }
      const result = await store.mutate(`排期 ${id}`, (draft) => applyOps(draft, [op]))
      printJson(result)
      return
    }

    if (cmd === 'metric') {
      if (sub !== 'add') throw new Error('目前只支援 metric add')
      if (!values.platform) throw new Error('請提供 --platform')
      const op = {
        op: 'add_metric',
        ...(values.item ? { itemId: values.item } : {}),
        platform: values.platform,
        date: values.date || new Date().toISOString(),
        views: values.views ? parseNum(values.views, 'views') : 0,
        likes: values.likes ? parseNum(values.likes, 'likes') : 0,
        comments: values.comments ? parseNum(values.comments, 'comments') : 0,
        shares: values.shares ? parseNum(values.shares, 'shares') : 0,
        saves: values.saves ? parseNum(values.saves, 'saves') : 0,
      }
      const result = await store.mutate('記錄數據', (draft) => applyOps(draft, [op]))
      printJson(result)
      return
    }

    if (cmd === 'insights') {
      const state = await store.read()
      const insights = computeInsights(state)
      if (values.propose) {
        const proposals = proposeRules(state)
        if (proposals.length) {
          await store.mutate('數據提煉寫作規則提案', (draft) => applyOps(draft, proposals.map(p => ({ op: 'add_skill', ...p, status: 'proposed' }))))
        }
        printJson({ insights, proposals })
        return
      }
      printJson(insights)
      return
    }

    if (cmd === 'skill') {
      if (sub === 'list') {
        const state = await store.read()
        printJson(state.skills)
        return
      }
      if (sub === 'add') {
        if (!values.name || !values.rule) throw new Error('請提供 --name 與 --rule')
        const op = { op: 'add_skill', name: values.name, rule: values.rule, status: values.status || 'active', source: values.source || '智能体记录' }
        const result = await store.mutate(`新增規則「${values.name}」`, (draft) => applyOps(draft, [op]))
        printJson(result)
        return
      }
      if (sub === 'update') {
        const id = rest[0]
        if (!id) throw new Error('請提供規則 ID')
        const op = { op: 'update_skill', id }
        if (values.name !== undefined) op.name = values.name
        if (values.rule !== undefined) op.rule = values.rule
        if (values.status !== undefined) op.status = values.status
        const result = await store.mutate(`更新規則 ${id}`, (draft) => applyOps(draft, [op]))
        printJson(result)
        return
      }
      if (sub === 'delete') {
        const id = rest[0]
        if (!id) throw new Error('請提供規則 ID')
        const result = await store.mutate(`刪除規則 ${id}`, (draft) => applyOps(draft, [{ op: 'delete_skill', id }]))
        printJson(result)
        return
      }
      if (sub === 'export') {
        const state = await store.read()
        const targetDir = values.dir || dshHome()
        const result = await exportSkill(state, targetDir)
        await store.mutate('匯出寫作規則 Skill', (draft) => {
          applyOps(draft, draft.skills.filter(s => !s.sample && s.status === 'active').map(s => ({ op: 'update_skill', id: s.id, status: 'exported' })))
          return draft
        }, { undoable: false })
        printJson(result)
        return
      }
      throw new Error(`未知 skill 子命令：${sub}`)
    }

    throw new Error(`未知指令：${cmd}（執行 media-desk --help 查看說明）`)
  })
}

run().catch((err) => fail(err.message))
