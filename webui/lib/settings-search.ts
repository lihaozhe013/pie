import type { SettingsSection } from './settings-navigation';
import { THEME_OPTIONS } from './theme.mts';
import { enLocale } from './i18n/messages/en';
import { zhCNLocale } from './i18n/messages/zh-CN';
import { zhTWLocale } from './i18n/messages/zh-TW';

export interface SettingsSearchEntry {
  section: SettingsSection;
  label: string;
  description?: string;
  target?: string;
  keywords: string;
  availability?: 'windows' | 'auth';
}

/** Search metadata only: never index saved configuration, tokens or credentials. */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  ...THEME_OPTIONS.map((option): SettingsSearchEntry => ({
    section: 'appearance',
    label: option.label,
    target: `settings-theme-${option.id}`,
    keywords: `theme color ${option.id} 主题 主題 配色`
  })),
  {
    section: 'appearance',
    label: 'settings.appearance',
    target: 'settings-theme',
    keywords: 'theme color light dark system 主题 主题颜色 主題 配色 系统 跟随'
  },
  {
    section: 'appearance',
    label: 'settings.uiFontFamily',
    description: 'settings.uiSizeDescription',
    target: 'settings-font-ui',
    keywords: 'ui font family 界面字体 介面字體 字体名称'
  },
  {
    section: 'appearance',
    label: 'settings.uiFontWeight',
    target: 'settings-font-ui-weight',
    keywords: 'ui weight bold 界面字重 粗细 粗細'
  },
  {
    section: 'appearance',
    label: 'settings.uiFontSize',
    description: 'settings.uiSizeDescription',
    target: 'settings-font-ui-size',
    keywords: 'ui size 界面字号 介面字級 导航 按钮'
  },
  {
    section: 'appearance',
    label: 'settings.monoFontFamily',
    description: 'settings.monoSizeDescription',
    target: 'settings-font-mono',
    keywords: 'mono monospace font family 等宽字体 等寬字體 代码字体'
  },
  {
    section: 'appearance',
    label: 'settings.monoFontWeight',
    target: 'settings-font-mono-weight',
    keywords: 'mono monospace weight 等宽字重 等寬字重'
  },
  {
    section: 'appearance',
    label: 'settings.monoFontSize',
    description: 'settings.monoSizeDescription',
    target: 'settings-font-mono-size',
    keywords: 'mono monospace code diff output size 等宽字号 等寬字級 代码字号 输出'
  },
  {
    section: 'appearance',
    label: 'settings.chatContentFontSize',
    description: 'settings.chatSizeDescription',
    target: 'settings-chat-content-font-size',
    keywords: 'chat body message text size 聊天 正文 消息 字号 字級'
  },
  {
    section: 'appearance',
    label: 'settings.chatContentWidth',
    description: 'settings.chatContentWidthDescription',
    target: 'settings-chat-content-width',
    keywords: 'chat width layout 聊天 宽度 寬度 布局'
  },
  {
    section: 'general',
    label: 'settings.quoteSelection',
    target: 'settings-quote-selection',
    keywords: 'quote selection 引用 选中 選取'
  },
  {
    section: 'general',
    label: 'settings.transcriptToolCards',
    description: 'settings.transcriptToolCardsDescription',
    target: 'settings-transcript-tool-cards',
    keywords:
      'tool card transcript conversation runs diff write edit patch 工具卡片 写入 编辑 編輯 补丁 補丁 对话记录 對話紀錄 执行历史 執行歷史 模式'
  },
  {
    section: 'general',
    label: 'settings.diffSideBySide',
    description: 'settings.diffSideBySideDescription',
    target: 'settings-diff-layout',
    keywords:
      'diff side by side split inline stacked columns write edit patch 并排 並排 内联 內聯 单栏 單欄 两栏 兩欄 分栏 分欄 拆分'
  },
  {
    section: 'general',
    label: 'settings.enterSendMode',
    target: 'settings-send-key',
    keywords: 'enter ctrl cmd send keyboard 发送 回车 傳送 換行 快捷键'
  },
  {
    section: 'general',
    label: 'settings.cacheMissNotices',
    description: 'settings.cacheMissNoticesDescription',
    target: 'settings-cache-notices',
    keywords: 'cache cost token 缓存 快取 费用 費用'
  },
  {
    section: 'general',
    label: 'settings.usePowerShell',
    description: 'settings.shellToolDescription',
    target: 'settings-shell',
    keywords: 'shell bash powershell windows 命令 终端 終端',
    availability: 'windows'
  },
  {
    section: 'general',
    label: 'settings.pushPermission',
    description: 'settings.pushPermissionDescription',
    target: 'settings-push',
    keywords: 'push notification ios 通知 推送'
  },
  {
    section: 'general',
    label: 'common.language',
    description: 'settings.languageDescription',
    target: 'settings-language',
    keywords: 'language locale english chinese 语言 語言 中文 英文'
  },
  {
    section: 'general',
    label: 'auth.logOut',
    target: 'settings-logout',
    keywords: 'logout sign out account 退出 登出 账户',
    availability: 'auth'
  },
  {
    section: 'instructions',
    label: 'settings.globalInstructions',
    description: 'globalAgents.description',
    keywords: 'AGENTS.md global instructions context memory 全局 全域 指令 上下文 记忆 記憶'
  },
  {
    section: 'models',
    label: 'common.models',
    keywords:
      'model provider api key base url reasoning context 模型 提供商 供应商 密钥 上下文 推理'
  },
  {
    section: 'models',
    label: 'models.contextLimit',
    description: 'models.contextLimitHelp',
    target: 'models-context-limit',
    keywords: 'context window limit compact tokens cap 上下文 窗口 上限 壓縮 視窗 壓縮'
  },
  {
    section: 'tools',
    label: 'settings.tools',
    description: 'settings.toolsDescription',
    keywords:
      'tool preset customize combine read bash edit write grep find ls 工具 预设 自定义 组合 組合 自訂'
  },
  { section: 'skills', label: 'common.skills', keywords: 'skill install prompt 技能 安装 安裝' },
  {
    section: 'plugins',
    label: 'common.plugins',
    keywords: 'plugin extension package 插件 扩展 擴充 套件'
  },
  {
    section: 'mcp',
    label: 'settings.mcp',
    keywords:
      'mcp server tools codemode sandbox exposure budget 服务器 伺服器 工具 代码模式 沙箱 预算'
  }
];

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'settings.general',
  instructions: 'settings.globalInstructions',
  appearance: 'settings.appearance',
  models: 'common.models',
  tools: 'settings.tools',
  skills: 'common.skills',
  plugins: 'common.plugins',
  mcp: 'settings.mcp'
};

const dictionaries = [enLocale.messages, zhCNLocale.messages, zhTWLocale.messages];
export function searchSettings(
  query: string,
  translate: (key: string) => string
): SettingsSearchEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return SETTINGS_SEARCH_ENTRIES.filter((entry) => {
    const keys = [entry.label, entry.description, SETTINGS_SECTION_LABELS[entry.section]].filter(
      (key): key is string => !!key
    );
    const text = [
      entry.keywords,
      ...keys.map(translate),
      ...dictionaries.flatMap((messages) => keys.map((key) => messages[key] ?? ''))
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
