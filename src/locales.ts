/** `dshDocument` namespace. Simplified Chinese follows DSH's own `zh`. */
export const zh = {
  loading: '正在启动 LibreOffice…（首次使用需下载约 60 MB）',
  opening: '正在打开文件…',
  'error.start': '无法启动 LibreOffice：{reason}',
  'error.open': '无法打开此文件：{reason}',
  'error.timeout': 'LibreOffice 启动超时，请检查网络后重新打开此文件。',
  frameTitle: 'LibreOffice 文档编辑器',
}

export const en: typeof zh = {
  loading: 'Starting LibreOffice… (about 60 MB to download the first time)',
  opening: 'Opening the file…',
  'error.start': 'Could not start LibreOffice: {reason}',
  'error.open': 'Could not open this file: {reason}',
  'error.timeout': 'LibreOffice took too long to start. Check the network, then open the file again.',
  frameTitle: 'LibreOffice document editor',
}
