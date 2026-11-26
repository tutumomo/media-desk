// 助手模型选择：顶栏按钮 + 弹窗。支持跟随 DeepSeek Harness 默认模型、选择已接入提供方，或自定义接入第三方大模型。
import React from 'react'
import { fetchModels, saveAssistant, setDesk, testAssistant, useDesk } from './desk.js'
import { t, useLang } from './i18n.js'
import { Dialog, Icon } from './ui.jsx'

const LLM_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' },
  { id: 'silicon', label: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'bailian', label: '阿里云百炼', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'ark', label: '火山方舟', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
  { id: 'zhipu', label: '智谱', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { id: 'ollama', label: 'Ollama', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
  { id: 'custom', label: '其他自定义', protocol: 'openai', baseUrl: '', model: '' },
]

export function ModelButton() {
  useLang()
  const model = useDesk(s => s.model)
  const override = useDesk(s => s.settings?.assistant?.model)
  const custom = useDesk(s => s.settings?.assistantCustom)
  const label = (custom?.enabled && custom?.model) || override || model || t('助手模型')
  return (
    <button type="button" className="md-open-dock" title={t('助手模型')} onClick={() => setDesk({ modelPickOpen: true })}>
      <Icon name="spark" size={13} />{label}
    </button>
  )
}

export function ModelPicker() {
  useLang()
  const open = useDesk(s => s.modelPickOpen)
  const settings = useDesk(s => s.settings)
  const override = settings?.assistant
  const customSaved = settings?.assistantCustom
  const [data, setData] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testReply, setTestReply] = React.useState(null)
  const [form, setForm] = React.useState(null)

  React.useEffect(() => {
    if (!open) return
    setData(null)
    setTestReply(null)
    fetchModels().then(setData).catch(() => setData({ providers: [], default: null }))
  }, [open])

  React.useEffect(() => {
    if (!open || !settings) return
    const ac = settings.assistantCustom ?? {}
    setForm({
      enabled: Boolean(ac.enabled),
      protocol: ac.protocol ?? 'openai',
      baseUrl: ac.baseUrl ?? '',
      model: ac.model ?? '',
      apiKey: '',
    })
  }, [open, settings])

  if (!open || !form) return null
  const close = () => setDesk({ modelPickOpen: false })
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }))

  const pickHarness = async (provider, model) => {
    setBusy(true)
    if (await saveAssistant({ assistant: { provider, model }, assistantCustom: { enabled: false } })) close()
    setBusy(false)
  }

  const customActive = Boolean(customSaved?.enabled)
  const isCurrentHarness = (provider, model) => !customActive && !form.enabled && override?.provider === provider && override?.model === model
  const activePreset = LLM_PRESETS.find(p => p.baseUrl && p.baseUrl === form.baseUrl && p.protocol === form.protocol)?.id ?? (form.baseUrl ? 'custom' : null)

  return (
    <Dialog title={t('助手模型')} onClose={close} width={520}>
      <form className="md-form" onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        const ok = await saveAssistant({
          assistantCustom: {
            enabled: true,
            protocol: form.protocol,
            baseUrl: form.baseUrl,
            model: form.model,
            apiKey: form.apiKey,
          },
        })
        setBusy(false)
        if (ok) close()
      }}>
        <div className="md-field">
          <span>{t('模型来源')}</span>
          <div className="md-presets">
            <button
              type="button"
              disabled={busy}
              className={!customActive && !form.enabled && !override?.model ? 'is-on' : ''}
              onClick={() => pickHarness('', '')}
            >
              {t('跟随默认')}{data?.default?.model ? `（${data.default.model}）` : ''}
            </button>
            <button
              type="button"
              disabled={busy}
              className={form.enabled ? 'is-on' : ''}
              onClick={() => set('enabled', true)}
            >
              {t('自定义第三方模型')}
            </button>
          </div>
          <small>{t('可跟随宿主默认模型，或直接接入任何兼容 OpenAI / Anthropic 接口的第三方大模型。')}</small>
        </div>

        {!data ? <p className="md-muted"><span className="md-shimmer">{t('正在读取可用模型…')}</span></p> : null}
        {(data?.providers ?? []).map(p => (
          <div className="md-field" key={p.provider}>
            <span>{p.name}</span>
            <div className="md-presets">
              {p.models.map(m => (
                <button type="button" key={m.id} disabled={busy} className={isCurrentHarness(p.provider, m.id) ? 'is-on' : ''} onClick={() => pickHarness(p.provider, m.id)}>{m.name}</button>
              ))}
            </div>
          </div>
        ))}

        <div className="md-field">
          <span>{t('第三方模型预设')}</span>
          <div className="md-presets">
            {LLM_PRESETS.map(preset => (
              <button
                type="button"
                key={preset.id}
                className={activePreset === preset.id ? 'is-on' : ''}
                onClick={() => {
                  setTestReply(null)
                  setForm(f => ({
                    ...f,
                    enabled: true,
                    protocol: preset.protocol,
                    baseUrl: preset.baseUrl,
                    model: preset.model || f.model,
                  }))
                }}
              >
                {t(preset.label)}
              </button>
            ))}
          </div>
        </div>

        <div className="md-field-row">
          <label className="md-field">
            <span>{t('接口协议')}</span>
            <select value={form.protocol} onChange={e => { set('protocol', e.target.value); set('enabled', true) }}>
              <option value="openai">{t('OpenAI 兼容')}</option>
              <option value="anthropic">{t('Anthropic 兼容')}</option>
            </select>
          </label>
          <label className="md-field">
            <span>{t('模型')}</span>
            <input
              value={form.model}
              onChange={e => { set('model', e.target.value); set('enabled', true) }}
              placeholder={form.protocol === 'anthropic' ? 'claude-sonnet-4-5' : 'deepseek-chat / gpt-4o'}
            />
          </label>
        </div>

        <label className="md-field">
          <span>{t('接口地址')}</span>
          <input
            type="url"
            value={form.baseUrl}
            onChange={e => { set('baseUrl', e.target.value); set('enabled', true) }}
            placeholder={form.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'}
          />
          <small>{t(form.protocol === 'anthropic' ? '自动请求 /v1/messages（或自定义前缀下的 /messages）。' : '自动请求 /chat/completions，适用于 OpenAI、DeepSeek、OpenRouter、百炼、Ollama 等。')}</small>
        </label>

        <label className="md-field">
          <span>{t('密钥')}{customSaved?.hasKey ? t('（已保存，末四位 {hint}）', { hint: customSaved.keyHint }) : ''}</span>
          <input
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={e => { set('apiKey', e.target.value); set('enabled', true) }}
            placeholder={customSaved?.hasKey ? t('留空表示不修改') : 'sk-…'}
          />
          <small>{t('只保存在这台电脑上（settings.json，权限 600），本地 Ollama 等无密钥服务可留空。')}</small>
        </label>

        {testReply ? (
          <p className="md-muted">{t('连接正常（{model}）：{reply}', { model: testReply.model, reply: testReply.reply })}</p>
        ) : null}

        <div className="md-form-foot">
          <button
            type="button"
            className="md-btn"
            disabled={testing || busy || !form.baseUrl.trim() || !form.model.trim()}
            onClick={async () => {
              setTesting(true)
              setTestReply(null)
              const res = await testAssistant({
                protocol: form.protocol,
                baseUrl: form.baseUrl,
                model: form.model,
                apiKey: form.apiKey,
              })
              if (res) setTestReply(res)
              setTesting(false)
            }}
          >
            {testing ? <span className="md-shimmer">{t('正在测试…')}</span> : t('测试连接')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="md-btn" onClick={close}>{t('取消')}</button>
          <button type="submit" className="md-btn is-primary" disabled={busy || !form.baseUrl.trim() || !form.model.trim()}>
            {t('保存并启用')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
