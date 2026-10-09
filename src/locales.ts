/** `dshDocument` namespace. Simplified Chinese follows DSH's own `zh`. */
export const zh = {
  loading: '正在启动 LibreOffice…（首次使用需下载约 60 MB）',
  opening: '正在打开文件…',
  'error.start': '无法启动 LibreOffice：{reason}',
  'error.open': '无法打开此文件：{reason}',
  'error.timeout': 'LibreOffice 启动超时，请检查网络后重新打开此文件。',
  'error.save': '保存失败：{reason}',
  'error.reload': '无法载入磁盘上的新版本：{reason}',
  'conflict.message': '此文件已在磁盘上被修改，与你未保存的内容冲突。',
  'conflict.useDisk': '使用磁盘上的版本',
  'conflict.keepMine': '保留我的版本',
  missing: '文件已被删除，继续编辑将重新创建。',
  retry: '重试',
  frameTitle: 'LibreOffice 文档编辑器',
}

export const en: typeof zh = {
  loading: 'Starting LibreOffice… (about 60 MB to download the first time)',
  opening: 'Opening the file…',
  'error.start': 'Could not start LibreOffice: {reason}',
  'error.open': 'Could not open this file: {reason}',
  'error.timeout': 'LibreOffice took too long to start. Check the network, then open the file again.',
  'error.save': 'Could not save: {reason}',
  'error.reload': 'Could not load the new version from disk: {reason}',
  'conflict.message': 'This file changed on disk and conflicts with your unsaved edits.',
  'conflict.useDisk': 'Use the version on disk',
  'conflict.keepMine': 'Keep my version',
  missing: 'This file was deleted. Keep editing to recreate it.',
  retry: 'Retry',
  frameTitle: 'LibreOffice document editor',
}
