import type {ContentLanguage} from './localization.js';

export const ERROR_TEXT = {
  DOCUMENT_FILE_NOT_PUBLISHED: {en: "This file is unavailable. Choose a published file from this committee.", 'zh-CN': "此文件不可用，请选择本委员会已发布的文件。"},
  SAVE_TIMEOUT: {en: "Saving timed out. Try again.", "zh-CN": "保存超时，请重试。"},
  IMAGE_REQUIRED: {en: "Please choose an image file", "zh-CN": "请选择图片文件"},
  FLAG_TOO_LARGE: {en: "Flag images must be smaller than 5 MB", "zh-CN": "旗帜图片必须小于 5 MB"},
  FLAG_PROCESSING_FAILED: {en: "Could not process flag image", "zh-CN": "无法处理旗帜图片"},
  CHAIR_HOST_REQUIRED: {en: "No chair computer is paired.", "zh-CN": "当前没有主席电脑。"},
  CHAIR_COMMIT_PENDING: {en: "Waiting for Chair computer to save the file", "zh-CN": "等待主席电脑保存文件"},
  THEME_TOO_LARGE: {en: "Theme file is too large. The maximum size is 3 MB.", "zh-CN": "主题文件过大，最大为 3 MB。"},

  INVALID_FILE_EXTENSION: {en: 'Allowed file formats: {formats}', 'zh-CN': '允许的文件格式：{formats}'},
  BAD_REQUEST: {en: "The request is invalid.", 'zh-CN': "请求无效。"},
  AUTHENTICATION_REQUIRED: {en: "Please log in again.", 'zh-CN': "请重新登录。"},
  FORBIDDEN: {en: "You do not have permission to perform this action.", 'zh-CN': "你没有权限执行此操作。"},
  NOT_FOUND: {en: "The requested resource was not found.", 'zh-CN': "未找到请求的内容。"},
  METHOD_NOT_ALLOWED: {en: "This action is not supported.", 'zh-CN': "不支持此操作。"},
  REVISION_CONFLICT: {en: "The state changed. Reload and try again.", 'zh-CN': "状态已更新，请重新载入后重试。"},
  IDEMPOTENCY_CONFLICT: {en: "This request key was used for different content. Retry the action.", 'zh-CN': "请求标识已用于其他内容，请重新操作。"},
  RESOURCE_CONFLICT: {en: "The current state does not allow this action.", 'zh-CN': "当前状态不允许此操作。"},
  SPEAKER_ALREADY_QUEUED: {en: "This seat is already on the speaker list and cannot be added again.", 'zh-CN': "该席位已在发言名单中，不能重复加入。"},
  STALE_STORAGE_LEASE: {en: "Storage changed. Reload and try again.", 'zh-CN': "存储已变更，请重新载入后重试。"},
  CURSOR_EXPIRED: {en: "The update history expired. Reload to reconnect.", 'zh-CN': "更新记录已过期，请重新载入以连接。"},
  LINK_EXPIRED: {en: "This link has expired.", 'zh-CN': "链接已失效。"},
  PAYLOAD_TOO_LARGE: {en: "The file is too large. Choose a smaller file.", 'zh-CN': "文件过大，请选择较小的文件。"},
  VALIDATION_FAILED: {en: "Check the entered values and try again.", 'zh-CN': "请检查输入内容后重试。"},
  CHAIR_DECISION_REQUIRED: {en: "A chair decision is required.", 'zh-CN': "需要主席裁定。"},
  RATE_LIMITED: {en: "Too many requests. Wait a while before trying again.", 'zh-CN': "请求过于频繁，请稍后重试。"},
  INTERNAL_ERROR: {en: "The server could not complete the request. Try again later.", 'zh-CN': "服务器未能完成请求，请稍后重试。"},
  SERVICE_NOT_READY: {en: "The service is unavailable. Try again later.", 'zh-CN': "服务暂不可用，请稍后重试。"},
  INVALID_COMMITTEE_LANGUAGE: {en: "Choose a supported committee language.", 'zh-CN': "请选择支持的委员会语言。"},
  MISSING_CONTENT_TRANSLATION: {en: "The selected content is missing required translations.", 'zh-CN': "所选内容缺少所需语言的翻译。"},
  SOURCE_REVISION_CHANGED: {en: "The selected source changed. Refresh the preview.", 'zh-CN': "所选来源已变更，请刷新预览。"},
  UNKNOWN_FIXED_MEMBER: {en: "Select a member from the committee directory.", 'zh-CN': "请从委员会固定目录选择成员。"},
  INVALID_EMAIL: {en: "Enter a valid email address.", 'zh-CN': "请输入有效的邮箱地址。"},
  DISPLAY_NAME_REQUIRED: {en: "Enter a display name.", 'zh-CN': "请输入显示名称。"},
  PASSWORD_TOO_SHORT: {en: "Password must be at least 12 characters.", 'zh-CN': "密码至少需要 12 个字符。"},
  BOOTSTRAP_SECRET_REQUIRED: {en: "Bootstrap secret is required.", 'zh-CN': "请输入初始化密钥。"},
  INCORRECT_CREDENTIALS: {en: "Email or password is incorrect.", 'zh-CN': "邮箱或密码不正确。"},
  INCORRECT_PASSWORD: {en: "Password is incorrect.", 'zh-CN': "密码不正确。"},
  INCORRECT_CURRENT_PASSWORD: {en: "Current password is incorrect.", 'zh-CN': "当前密码不正确。"},
  EMAIL_IN_USE: {en: "This email address is already in use.", 'zh-CN': "该邮箱地址已被使用。"},
  ACCOUNT_NOT_ACTIVE: {en: "Only active accounts support this action.", 'zh-CN': "只有活动账号可以执行此操作。"},
  ADMIN_ACCOUNT_PROTECTED: {en: "The system administrator account cannot be disabled or anonymized.", 'zh-CN': "不能停用或匿名化系统管理员账号。"},
  ACCOUNT_DISABLE_REQUIRED: {en: "Disable the account before anonymizing it.", 'zh-CN': "请先停用账号，再进行匿名化。"},
  INVALID_REPLACEMENT_ACCOUNT: {en: "Select an active replacement account.", 'zh-CN': "请选择活动的接收账号。"},
  CONFIRMATION_EMAIL_MISMATCH: {en: "The confirmation email does not match.", 'zh-CN': "确认邮箱不匹配。"},
  COMMITTEE_DELETION_PENDING: {en: "Wait for committee deletion to finish.", 'zh-CN': "请等待委员会删除完成。"},
  PASSWORD_CHANGE_REQUIRED: {en: "Change the temporary password first.", 'zh-CN': "请先修改临时密码。"},
  SYSTEM_ADMIN_REQUIRED: {en: "System administrator access is required.", 'zh-CN': "需要系统管理员权限。"},
  INVALID_FIELD: {en: "Check the highlighted field.", 'zh-CN': "请检查标记的字段。"},
  NETWORK_ERROR: {en: "Unable to connect. Check your network and try again.", 'zh-CN': "无法连接，请检查网络后重试。"},
  INVALID_RESPONSE: {en: "The server returned an invalid response. Try again later.", 'zh-CN': "服务器返回了无效响应，请稍后重试。"},
  ABORTED: {en: "The operation was cancelled.", 'zh-CN': "操作已取消。"},
  OPERATION_FAILED: {en: "Request failed. Try again later.", 'zh-CN': "请求失败，请稍后重试。"},
 } as const;
export type LocalizedErrorReason = keyof typeof ERROR_TEXT;

/** Unknown server messages and exception bodies never become user-facing text. */
export function formatApiError(error: unknown, language: ContentLanguage): string {
  const value = error && typeof error === 'object' ? error as {
    code?: unknown; requestId?: unknown; reason?: unknown; params?: {formats?: unknown}; localization?: {reason?: unknown; params?: {formats?: unknown}}; name?: unknown;
  } : undefined;
  const reason = value?.localization?.reason ?? value?.reason;
  const key = typeof reason === 'string' && Object.hasOwn(ERROR_TEXT, reason) ? reason
    : typeof value?.code === 'string' && Object.hasOwn(ERROR_TEXT, value.code) ? value.code
      : value?.name === 'AbortError' ? 'ABORTED' : 'OPERATION_FAILED';
  let text: string = ERROR_TEXT[key as LocalizedErrorReason][language];
  if (['OPERATION_FAILED', 'INTERNAL_ERROR', 'INVALID_RESPONSE'].includes(key) && typeof value?.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)) {
    text += language === 'zh-CN' ? ` 请求编号：${value.requestId}` : ` Request ID: ${value.requestId}`;
  }
  const formats = value?.localization?.params?.formats ?? value?.params?.formats;
  return key === 'INVALID_FILE_EXTENSION' ? text.replace('{formats}',
    typeof formats === 'string' && formats.length <= 2048 && /^[a-zA-Z0-9., ]+$/.test(formats) ? formats : '—') : text;
}
