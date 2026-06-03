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
    modelPlaceholder: 'deepseek-chat',
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
