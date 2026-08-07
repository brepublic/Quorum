import * as React from 'react';
import { Dropdown, Icon, Menu } from 'semantic-ui-react';

export type Language = 'en' | 'zh-CN';

const STORAGE_KEY = 'muncoordinated-language';

const en: Record<string, string> = {
  'Resolution proposer': 'Proposer',
  'Resolution seconder': 'Seconder',
  'Amendment proposer': 'Proposer',
  'Motion action: Extend': 'Extend',
  'Motion action: Close': 'Close',
  'Motion action: Open': 'Open',
  'Motion action: Introduce': 'Introduce',
  'Motion action: Suspend': 'Suspend',
  'Motion action: Resume': 'Resume',
  'Motion action: Reorder': 'Reorder',
  'Motion action: Create': 'Create',
  'Motion action: Vote': 'Vote',
  'Motion action: Enact': 'Enact'
};

const zhCN: Record<string, string> = {
  'English': 'English',
  'Simplified Chinese': '简体中文',
  'Language': '语言',
  'No results found.': '未找到结果。',
  'Add ': '添加：',
  'Home': '首页',
  'Log in': '登录',
  'Login': '登录',
  'Logout': '退出登录',
  'Sign up': '注册',
  'Create account': '创建账户',
  'Create a committee': '创建委员会',
  'Create new committee': '新建委员会',
  'Create committee': '创建委员会',
  'Forgot password?': '忘记密码？',
  'Back to login': '返回登录',
  'Send reset email': '发送重置邮件',
  'Reset password': '重置密码',
  'Email': '电子邮箱',
  'Password': '密码',
  'Authentication error': '身份认证错误',
  'auth/invalid-email': '电子邮箱地址格式无效。',
  'auth/user-disabled': '此账户已被停用。',
  'auth/user-not-found': '未找到使用此电子邮箱的账户。',
  'auth/wrong-password': '密码错误。',
  'auth/invalid-credential': '电子邮箱或密码错误。',
  'auth/email-already-in-use': '此电子邮箱已被其他账户使用。',
  'auth/weak-password': '密码强度不足，请使用更强的密码。',
  'auth/too-many-requests': '尝试次数过多，请稍后再试。',
  'auth/network-request-failed': '网络请求失败，请检查网络连接。',
  'Logged in': '已登录',
  'No committees created': '尚未创建委员会',
  "Create a new committee and it'll appear here!": '创建新委员会后，它会显示在这里。',
  'Log in or create an account to continue': '请登录或创建账户以继续',
  'Account created': '账户已创建',
  'Your account was successfully created': '账户创建成功。',
  'Password reset': '重置密码',
  'Check your inbox at {email} for further instructions': '请查看 {email} 的收件箱并按邮件说明操作。',
  'Committee name': '委员会名称',
  'Committee topic': '委员会议题',
  'Conference name': '会议名称',
  'Name': '名称',
  'Topic': '议题',
  'Conference': '会议',
  'Template': '模板',
  'African Union': '非洲联盟',
  'Association of Southeast Asian Nations': '东南亚国家联盟',
  'European Union': '欧洲联盟',
  'North Atlantic Treaty Organization': '北大西洋公约组织',
  'UN Security Council': '联合国安全理事会',
  'Template to skip manual member creation (optional)': '使用模板免去手动添加成员（可选）',
  'Select a template to add': '选择要添加的模板',
  'Select a template to see which members will be added': '选择模板以查看将添加的成员',
  'Add members from a template (e.g. G20)': '从模板添加成员（例如 G20）',
  'Select preset member': '选择预设成员',
  'Rank': '席位类型',
  'Standard': '普通成员国',
  'Veto': '常任理事国',
  'NGO': '非政府组织',
  'Observer': '观察员',
  'Present': '出席',
  'Must Vote': '必须投票',
  'Add at least one committee member to proceed': '请至少添加一名委员会成员后再继续',
  "General Speakers' List": '主发言名单',
  'Setup': '设置',
  'Setup committee': '设置委员会',
  'Motions': '动议',
  'Unmod': '自由磋商',
  'Caucuses': '有主持核心磋商',
  'New caucus': '新建有主持核心磋商',
  'Resolutions': '决议草案',
  'New resolution': '新建决议草案',
  'Strawpolls': '意向性投票',
  'New strawpoll': '新建意向性投票',
  'Notes': '笔记',
  'Posts': '资料',
  'Stats': '统计',
  'Settings': '设置',
  'Help': '帮助',
  'Open': '开放',
  'Closed': '已关闭',
  'Stage': '就位',
  'Start': '开始',
  'Next': '下一位',
  'Stop': '停止',
  'Order': '交替排序',
  'Next speaking': '下一位发言',
  "Orders the list so that speakers are 'For', then 'Against', then 'Neutral', then 'For', etc.": '按“赞成、反对、中立”的顺序交替排列发言名单。',
  'Remove': '移除',
  'Yield': '让渡',
  'Queue': '发言队列',
  'Speaking time': '发言时间',
  'Delegates can queue': '代表可自行加入发言队列',
  'For': '赞成',
  'Neutral': '中立',
  'Against': '反对',
  'Set caucus name': '设置磋商名称',
  'untitled caucus': '未命名有主持核心磋商',
  'Set caucus details': '设置磋商议题',
  'Now speaking': '正在发言',
  'Speaker timer': '发言计时器',
  'Caucus timer': '磋商计时器',
  'Unmoderated caucus': '自由磋商',
  'Duration': '时长',
  'Set': '设置',
  'sec': '秒',
  'min': '分钟',
  'seconds': '秒',
  'Open unmoderated caucus': '开启自由磋商',
  'Open moderated caucus': '开启有主持核心磋商',
  'Extend unmoderated caucus': '延长自由磋商',
  'Extend moderated caucus': '延长有主持核心磋商',
  'Close moderated caucus': '结束有主持核心磋商',
  'Introduce draft resolution': '展示决议草案',
  'Introduce amendment': '展示修正案',
  'Suspend draft resolution speakers list': '暂停决议草案发言名单',
  'Vote on resolution': '对决议草案进行表决',
  'Open debate': '开启辩论',
  'Suspend debate': '暂停辩论',
  'Resume debate': '恢复辩论',
  'Close debate': '结束辩论',
  'Reorder draft resolutions': '调整决议草案顺序',
  'Propose strawpoll': '提议意向性投票',
  'Introduce working paper': '展示工作文件',
  'Speaker time does not evenly divide the caucus time': '发言时间不能整除磋商总时长',
  'Abstain': '弃权',
  'Abstaining': '弃权',
  'In favour': '赞成',
  'Proposer': '动议提出方',
  'Target caucus': '目标磋商',
  'Target resolution': '目标决议草案',
  'Delete': '删除',
  'Select type': '选择类型',
  'Type': '类型',
  'Delegates can propose motions': '代表可提出动议',
  'Delegates can vote on motions': '代表可对动议投票',
  'Sorted from most to least disruptive.': '按对议程影响程度从高到低排序。',
  '{count} votes required to pass a motion': '动议需获得 {count} 票方可通过',
  'Clear': '清空',
  'Text': '文本',
  'Feed': '动态',
  'Amendments': '修正案',
  'Create amendment': '创建修正案',
  "A resolution's proposer and seconder cannot be the same": '决议草案的提案国与附议国不能相同',
  'Delegates can create and edit, but not delete, amendments.': '代表可以创建和编辑修正案，但不能删除。',
  'Delete resolution?': '删除决议草案？',
  'Are you sure? This is irreversible and will delete all posts, text, amendments and voting history. You might want to close the resolution (top right dropdown) instead?': '确定要删除吗？此操作不可撤销，并将删除所有资料、正文、修正案及表决记录。您也可以改为在右上角的下拉菜单中关闭该决议草案。',
  'Associated caucus': '关联磋商',
  'Provision caucus': '创建关联磋商',
  'Voting': '表决',
  'Select majority type': '选择多数制类型',
  'Simple majority': '简单多数',
  'Two-thirds majority': '三分之二多数',
  'Two-thirds majority, ignoring abstentions': '三分之二多数（不计弃权票）',
  'Simple (50%) majority required': '须达到简单多数（50%）',
  'Two-thirds majority required': '须达到三分之二多数',
  'Two-thirds majority required, ignoring abstentions': '须达到三分之二多数（不计弃权票）',
  'Introduced': '已展示',
  'Passed': '通过',
  'Failed': '未通过',
  'Vetoed': '被否决',
  'Proposed': '已提出',
  'Incorporated': '已纳入',
  'Rejected': '未采纳',
  'Seconder': '附议方',
  'Delegates can amend': '代表可提出修正案',
  'Resolution text': '决议草案正文',
  'Set resolution name': '设置决议草案名称',
  'untitled resolution': '未命名决议草案',
  'More options': '更多选项',
  'Delete strawpoll?': '删除意向性投票？',
  'Are you sure that you want to delete this strawpoll?': '确定要删除此意向性投票吗？',
  'Yes': '是',
  'No': '否',
  'or': '或',
  'Cancel': '取消',
  'OK': '确定',
  'Enter poll option': '输入表决选项',
  'Number of votes received': '所得票数',
  '{count} votes': '{count} 票',
  'Add option': '添加选项',
  'Choose many': '可多选',
  'Choose one': '单选',
  'Delegates can add options': '代表可添加选项',
  'Create shareable poll': '创建在线表决',
  'Create manual poll': '创建人工计票表决',
  'Edit options': '编辑选项',
  'View results': '查看结果',
  'Reopen voting': '重新开放投票',
  'Type your question here': '在此输入问题',
  'undefined question': '未命名问题',
  'Uploader': '上传者',
  'Poster': '发布者',
  'Upload': '上传',
  'Post': '发布',
  'Link': '链接',
  'Body': '正文',
  'File': '文件',
  'storage/unauthorized': '没有权限上传此文件。',
  'View posts only by': '仅查看以下人员发布的资料',
  'uploaded a file': '上传了文件',
  'posted a link': '发布了链接',
  'Number': '人数',
  'Description': '说明',
  'Threshold': '门槛',
  'Total': '总计',
  'Delegates in committee': '委员会代表总数',
  'Delegates in attendance': '出席代表数',
  'Have voting rights': '有表决权',
  'Present delegates with voting rights': '出席且有表决权的代表数',
  'Debate': '法定人数',
  'Delegates needed for debate': '开始辩论所需代表数',
  '25% of of members with voting rights': '有表决权成员的 25%',
  'Procedural threshold': '程序性事项门槛',
  'Required votes for procedural matters': '程序性事项所需票数',
  '50% of present non-NGO delegates': '出席的非政府组织以外代表的 50%',
  'Operative threshold': '实质性事项门槛',
  'Required votes for operative matters, such as amendments': '修正案等实质性事项所需票数',
  '50% of present delegates with voting rights': '出席且有表决权代表的 50%',
  'Required votes for passing resolutions': '通过决议草案所需票数',
  '2/3 of present delegates with voting rights': '出席且有表决权代表的三分之二',
  'Draft resolution': '决议草案',
  'Delegates needed to table a draft resolution': '提交决议草案所需代表数',
  '25% of present delegates with voting rights': '出席且有表决权代表的 25%',
  'Amendment': '修正案',
  'Delegates needed to table an amendment': '提交修正案所需代表数',
  '10% of present delegates with voting rights': '出席且有表决权代表的 10%',
  'Times spoken': '发言次数',
  'Total speaking time': '发言总时长',
  'Motion proposals': '提出动议次数',
  'Amendment proposals': '提出修正案次数',
  "'Queue' should appear above 'Next speaking'": '将“发言队列”显示在“下一位发言”上方',
  "Alternate arrangement with 'Speaker timer' and 'Caucus timer' in separate columns": '将“发言计时器”和“磋商计时器”分列显示',
  'Connection Lost': '连接已断开',
  'Changes are no longer being committed to the server. Either wait for a reconnection or refresh the page. If you refresh the page, you will need to log in again.': '更改已无法提交至服务器。请等待重新连接或刷新页面；刷新后需要重新登录。',
  'Permission denied': '权限不足',
  'Please login as the owner of this committee in order to perform that action': '请以该委员会所有者身份登录后执行此操作。',
  'Connection lost': '连接已断开',
  'The connection to the server was lost. You may have been logged out': '与服务器的连接已断开，您的登录状态可能已失效。',
  'Connection regained': '连接已恢复',
  'The connection to the server was regained': '已恢复与服务器的连接。',
  'Dismiss': '关闭',
  'Not found': '未找到',
  'The {item} you were looking for (ID: {id}) could not be found. It may have been deleted, or the URL you navigated to was incorrect.': '未找到您要访问的{item}（ID：{id}）。该内容可能已被删除，或访问地址有误。',
  'page': '页面',
  'strawpoll': '意向性投票',
  'resolution': '决议草案',
  'caucus': '磋商',
  'Copy': '复制',
  'Copied!': '已复制！',
  'Please copy manually': '请手动复制',
  "Here's the shareable link to your committee": '这是委员会的分享链接',
  'Copy and send this to your delegates, and they will be able to:': '将此链接发送给代表，他们可以：',
  'Upload files': '上传文件',
  "Add themselves to speakers' lists": '自行加入发言名单',
  'Add and edit amendments on resolutions': '添加和编辑决议草案修正案',
  'Propose motions': '提出动议',
  'Vote on motions': '对动议投票',
  'Vote on strawpolls': '参与意向性投票',
  "Here's the shareable link to your strawpoll": '这是意向性投票的分享链接',
  'Keyboard shortcuts': '键盘快捷键',
  'Next speaker': '下一位发言者',
  'Toggle speaker timer': '启动或暂停发言计时器',
  'Toggle caucus timer': '启动或暂停磋商计时器',
  'Bug reporting & help requests': '错误报告与帮助请求',
  'License': '许可协议',
  'Social media': '社交平台',
  'The collaborative browser-based Model UN committee management app': '基于浏览器的模拟联合国协作式会场管理应用',
  'Committees created': '已创建委员会',
  'Delegates participating': '参与代表',
  'Collaborative': '实时协作',
  'Backed up to the cloud': '云端自动保存',
  'A comprehensive feature set': '功能全面',
  'Free and open-source': '免费且开源',
  'About': '关于',
  'Source': '源代码',
  'Services': '服务',
  'Forum': '论坛',
  'Support': '支持',
  'MUN Resources': '模联资源',
  'Info': '信息',
  'to create a new committee, or access an older committee.': '创建新委员会或访问已有委员会。',
  "Multiple directors may use the same account simultaneously. Choose a password you're willing to share.": '多位主席可同时使用同一账户。请选择便于共同使用的密码。',
  "Add themselves to speakers' lists that have the Delegates can queue flag enabled": '在已开启“代表可自行加入发言队列”的发言名单中自行排队',
  'Add and edit amendments on resolutions that have the Delegates can amend flag enabled': '在已开启“代表可提出修正案”的决议草案中添加和编辑修正案',
  'Propose motions that have the Delegates can propose motions flag enabled': '在已开启“代表可提出动议”时提出动议',
  'Vote on motions that have the Delegates can vote on motions flag enabled': '在已开启“代表可对动议投票”时参与投票',
  "Here's the shareable link to {action}": '这是用于{action}的分享链接',
  'vote on and propose motions': '对动议投票和提出动议',
  'vote on motions': '对动议投票',
  'propose motions': '提出动议',
  'Browser compatibility notice': '浏览器兼容性提示',
  'Muncoordinated works best with newer versions of Google Chrome. Use of other or older browsers has caused bugs and data loss.': 'Muncoordinated 在新版 Google Chrome 中运行效果最佳。使用其他浏览器或旧版浏览器可能导致错误或数据丢失。',
  'Muncoordinated works best with newer versions of': 'Muncoordinated 在新版',
  '. Use of other or older browsers has caused bugs and data loss.': ' 中运行效果最佳。使用其他浏览器或旧版浏览器可能导致错误或数据丢失。',
  'Using a shareable link delegates can:': '代表通过分享链接可以：',
  "Everyone will see all updates in real-time, without needing to refresh the page. It's like Google Docs, but for MUN.": '所有人无需刷新页面即可实时看到更新，协作体验类似用于模联会场的在线文档。',
  'For virtual MUNs, we recommend pairing Muncoordinated with Discord, which supports voice, note passing, and file and link sharing.': '线上模联可将 Muncoordinated 与 Discord 配合使用，以进行语音交流、传递纸条以及分享文件和链接。',
  'For virtual MUNs, we recommend pairing Muncoordinated with': '线上模联可将 Muncoordinated 与',
  'which supports voice, note passing, and file and link sharing.': '配合使用，以进行语音交流、传递纸条以及分享文件和链接。',
  "If you've got a big committee, multiple directors can manage it at the same time, using the same account.": '大型委员会可由多位主席使用同一账户同时管理。',
  "You won't have to worry about data loss ever again. All committee activity is automatically saved to the server, so you can resume a session with earlier data available.": '所有委员会活动都会自动保存至服务器，恢复会期时仍可使用此前的数据。',
  'Muncoordinated supports:': 'Muncoordinated 支持：',
  'Moderated and unmoderated caucuses': '有主持核心磋商和自由磋商',
  'Resolutions and amendments': '决议草案与修正案',
  'Roll-call voting': '点名表决',
  'Custom delegations': '自定义代表团',
  'File uploads': '文件上传',
  'Delegate performance statistics': '代表表现统计',
  "All of Muncoordinated's features are available for free, not locked behind paywalls.": 'Muncoordinated 的全部功能均可免费使用，不设付费墙。',
  "It's also open-source, so you're free to customize it to your needs and liking.": '项目同时开放源代码，您可以按实际需要进行定制。',
  "It's also": '项目同时',
  'open-source': '开放源代码',
  "so you're free to customize it to your needs and liking.": '您可以按实际需要进行定制。',
  'Made with': '用',
  'by': '制作，作者',
  'with assistance from the': '并得到以下组织协助：',
  'In the event that a bug or issue crops up, follow these steps:': '如遇错误或其他问题，请按以下步骤操作：',
  'Create an issue on the Muncoordinated issue tracking page. You can also use this for help requests regarding the app.': '在 Muncoordinated 问题跟踪页面新建问题，也可在此提出应用使用方面的求助。',
  'Create an issue on the': '在',
  'Muncoordinated issue tracking page': 'Muncoordinated 问题跟踪页面新建问题',
  'You can also use this for help requests regarding the app.': '也可在此提出应用使用方面的求助。',
  'Describe what you intended to do': '说明您原本希望执行的操作',
  'Describe what happened instead': '说明实际发生的情况',
  "List the version of the app you're using": '注明正在使用的应用版本',
  'List the time, date, and browser that you were using when this occurred': '注明问题发生的日期、时间和所用浏览器',
  'Muncoordinated is licensed under': 'Muncoordinated 采用以下许可协议：',
  "Want to meet other Muncoordinators? Visit The Muncoordinator's Discussion Space.": '欢迎前往 Muncoordinator 讨论区与其他用户交流。',
  'Want to meet other Muncoordinators? Visit': '欢迎前往',
  "The Muncoordinator's Discussion Space": 'Muncoordinator 讨论区与其他用户交流',
  '{action} {count} seconds ago': '{count} 秒前{action}',
  '{action} {count} minutes ago': '{count} 分钟前{action}',
  '{action} {count} hours ago': '{count} 小时前{action}',
  '{action} {count} days ago': '{count} 天前{action}',
  'Posted': '发布于',
  'Uploaded': '上传于',
  'Question': '问题',
  'Task': '任务',
  'Resolution proposer': '提案国',
  'Resolution seconder': '附议国',
  'Amendment proposer': '修正案提出国',
  'Extend': '延长',
  'Close': '结束',
  'Introduce': '展示',
  'Suspend': '暂停',
  'Resume': '恢复',
  'Reorder': '调整顺序',
  'Create': '创建',
  'Vote': '表决',
  'Enact': '执行',
  'Motion action: Extend': '延长',
  'Motion action: Close': '结束',
  'Motion action: Open': '开启',
  'Motion action: Introduce': '展示',
  'Motion action: Suspend': '暂停',
  'Motion action: Resume': '恢复',
  'Motion action: Reorder': '调整顺序',
  'Motion action: Create': '创建',
  'Motion action: Vote': '表决',
  'Motion action: Enact': '执行',
  'yes': '赞成',
  'no': '反对',
  'abstaining': '弃权',
  'simple majority': '简单多数',
  'two-thirds majority': '三分之二多数',
  '{votes} clears the required {thresholdName} of {threshold}': '{votes} 票达到所需的{thresholdName}门槛（{threshold} 票）',
  "Further votes may change the result from 'Passed'": '后续投票仍可能使结果不再为“通过”',
  'There are insufficient votes remaining to achieve a {thresholdName}': '剩余票数不足以达到{thresholdName}',
  '{name} was the first to veto the resolution': '{name} 首先对该决议草案行使否决权',
  'Extend unmoderated caucus by {time}': '将自由磋商延长 {time}',
  'Extend moderated caucus by {time}': '将有主持核心磋商延长 {time}',
  '{time} moderated caucus': '时长为 {time} 的有主持核心磋商',
  '{time} unmoderated caucus': '时长为 {time} 的自由磋商'
};

let currentLanguage: Language = detectInitialLanguage();
const listeners = new Set<(language: Language) => void>();

function detectInitialLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-CN') {
      return saved;
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function setLanguage(language: Language) {
  currentLanguage = language;
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Keep the in-memory preference when local storage is unavailable.
  }
  listeners.forEach(listener => listener(language));
}

export function t(key: string, values: Record<string, string | number> = {}): string {
  const template = currentLanguage === 'zh-CN' ? zhCN[key] ?? en[key] ?? key : en[key] ?? key;
  return Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    template
  );
}

const GENERATED_NAME_KEYS = new Set([
  "General Speakers' List",
  'untitled caucus',
  'untitled resolution',
  'undefined question'
]);

export function localizeGeneratedName(value: string): string {
  return GENERATED_NAME_KEYS.has(value) ? t(value) : value;
}

export function LanguageProvider(props: React.PropsWithChildren) {
  const [language, updateLanguage] = React.useState<Language>(currentLanguage);

  const dropdownComponent = Dropdown as typeof Dropdown & {
    defaultProps?: Record<string, unknown>;
  };
  dropdownComponent.defaultProps = {
    ...dropdownComponent.defaultProps,
    additionLabel: t('Add '),
    noResultsMessage: t('No results found.')
  };

  React.useEffect(() => {
    const listener = (nextLanguage: Language) => updateLanguage(nextLanguage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  React.useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <React.Fragment key={language}>{props.children}</React.Fragment>;
}

const LANGUAGE_OPTIONS = [
  { key: 'en', value: 'en', text: 'English' },
  { key: 'zh-CN', value: 'zh-CN', text: '简体中文' }
];

export function LanguageSwitcher() {
  const [language, updateLanguage] = React.useState<Language>(currentLanguage);

  React.useEffect(() => {
    const listener = (nextLanguage: Language) => updateLanguage(nextLanguage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <div className="language-switcher">
      <Icon name="language" aria-hidden="true" />
      <Dropdown
        aria-label={t('Language')}
        compact
        selection
        options={LANGUAGE_OPTIONS}
        value={language}
        onChange={(_, data) => setLanguage(data.value as Language)}
      />
    </div>
  );
}

export function LanguageMenuItem(props: { position?: 'left' | 'right' }) {
  return (
    <Menu.Item position={props.position}>
      <LanguageSwitcher />
    </Menu.Item>
  );
}
