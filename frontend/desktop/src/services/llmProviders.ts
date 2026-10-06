export type LLMProvider = 'openai' | 'deepseek' | 'qwen' | 'moonshot' | 'openrouter' | 'ollama' | 'custom'

export type LLMProviderPreset = {
  id: LLMProvider
  label: string
  baseUrl: string
  modelPlaceholder: string
  tokenPlaceholder: string
}

export const LLM_PROVIDER_PRESETS: LLMProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    modelPlaceholder: 'deepseek-flash',
    tokenPlaceholder: 'DeepSeek API Key'
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelPlaceholder: 'qwen-plus',
    tokenPlaceholder: 'DashScope API Key'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelPlaceholder: 'gpt-4.1-mini',
    tokenPlaceholder: 'OpenAI API Key'
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelPlaceholder: 'moonshot-v1-8k',
    tokenPlaceholder: 'Moonshot API Key'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelPlaceholder: 'openai/gpt-4.1-mini',
    tokenPlaceholder: 'OpenRouter API Key'
  },
  {
    id: 'ollama',
    label: 'Ollama 本地',
    baseUrl: 'http://localhost:11434/v1',
    modelPlaceholder: 'qwen2.5:7b',
    tokenPlaceholder: 'Ollama 可填写任意非空值'
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    modelPlaceholder: '填写 OpenAI 兼容模型名称',
    tokenPlaceholder: 'API Token'
  }
]

export function getProviderPreset(provider: string) {
  return LLM_PROVIDER_PRESETS.find((item) => item.id === provider) || LLM_PROVIDER_PRESETS[0]
}

/** This module calls the OpenAI-compatible protocol. Only correct the known
 * official DeepSeek Anthropic base; custom gateways must keep their URL. */
export function deepSeekOpenAIBaseUrl(provider: string, baseUrl: string): string | null {
  if (provider !== 'deepseek') return null
  try {
    const url = new URL(baseUrl.trim())
    if (url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === '/anthropic' || url.pathname === '/anthropic/')) return 'https://api.deepseek.com'
  } catch { /* An invalid URL needs user correction, not guessed replacement. */ }
  return null
}

/** Never display an upstream message: it may contain request credentials. */
export function llmConnectionFailureMessage(statusCode?: number | null): string {
  const messages: Record<number, string> = {
    400: '请求参数不被服务接受，请检查接口协议与配置。',
    401: '鉴权失败，请检查这个连接的 API Key。',
    402: '账户余额不足，请在服务平台检查余额或试用额度。',
    403: '没有访问权限，请检查 API Key 的权限和模型授权。',
    404: '接口未找到，请检查接口地址是否支持 OpenAI 兼容协议。',
    408: '服务请求超时，请稍后重试。',
    422: '请求格式不被服务接受，请检查接口协议与配置。',
    429: '请求被限流或额度已用尽，请检查平台额度后稍后重试。',
    500: '服务内部错误，请稍后重试。',
    502: '服务网关异常，请稍后重试。',
    503: '服务暂不可用，请稍后重试。',
    504: '服务网关超时，请稍后重试。',
  }
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return '连接检查失败，请检查后端、接口地址和 API Key。'
  }
  return `连接失败（HTTP ${statusCode}）：${messages[statusCode] || '服务未能完成连接检查，请检查接口地址与配置。'}`
}
