/**
 * The AI's reads and edits of a Writer document, run in the office thread
 * through UNO. The document body is a sequence of blocks (paragraphs and
 * tables) numbered from 1; an edit is one undo step, so one Ctrl+Z reverts it.
 * The cursor is located in the same numbering, for the AI context.
 *
 * Every UNO call through zetajs costs on the order of a millisecond, so
 * listing the blocks is linear in the document: the list is kept until the
 * document changes, and the cursor is found in it by binary search.
 *
 * zetajs hands over UNO objects as dynamic proxies, so they are typed loosely here.
 */
import type { DocumentBlock, DocumentRead, EditOperation, EditResult, SelectionReport } from '../protocol.ts'

/* eslint-disable @typescript-eslint/no-explicit-any -- UNO proxies */

/** Text longer than this is cut per block in a read: a read is for the AI's context. */
const MAX_BLOCK_CHARS = 4000
/** Blocks returned by one read when no range is asked for. */
const DEFAULT_READ_BLOCKS = 200
/** Selections longer than this are cut before they leave LibreOffice (the editor core cuts further for the AI). */
const MAX_SELECTION_CHARS = 4000

interface Block {
  readonly element: any
  readonly kind: 'paragraph' | 'table'
}

/** The part of zetajs used here. */
export interface ZetaTypes {
  readonly type: { readonly float: unknown; readonly short: unknown }
  readonly Any: new (type: unknown, value: unknown) => unknown
  sameUnoObject(a: unknown, b: unknown): boolean
}

/** One per open document: it keeps the block list between calls. */
export class DocumentOperations {
  /** The body's blocks as last listed; undefined once the document changed. */
  private cached: Block[] | undefined

  constructor(private readonly zetajs: ZetaTypes, private readonly css: any, private readonly model: any) {}

  /** The document changed: block numbers may have moved. */
  invalidate(): void {
    this.cached = undefined
  }

  /** The body's blocks in order (listed again only after a change). */
  private blocks(): Block[] {
    if (this.cached !== undefined) return this.cached
    const blocks: Block[] = []
    const enumeration = this.model.getText().createEnumeration()
    while (enumeration.hasMoreElements()) {
      const element = enumeration.nextElement()
      blocks.push({ element, kind: element.supportsService('com.sun.star.text.TextTable') ? 'table' : 'paragraph' })
    }
    this.cached = blocks
    return blocks
  }

  /**
   * The block of a position: the table holding it (a table's cells are texts of their
   * own), or by binary search over the paragraphs (a position in the body text is in one).
   */
  private blockOf(blocks: readonly Block[], range: any, table: any): number {
    if (table !== undefined && table !== null) {
      const index = blocks.findIndex(block => block.kind === 'table' && this.zetajs.sameUnoObject(block.element, table))
      if (index >= 0) return index + 1
    }
    const paragraphs: number[] = []
    blocks.forEach((block, index) => { if (block.kind === 'paragraph') paragraphs.push(index) })
    const text = this.model.getText()
    let low = 0
    let high = paragraphs.length - 1
    let found = paragraphs[0] ?? 0
    while (low <= high) {
      const middle = (low + high) >> 1
      const index = paragraphs[middle]!
      // compareRegionStarts(a, b): 1 when a is before b, 0 when equal, -1 when after.
      if (text.compareRegionStarts(blocks[index]!.element.getStart(), range) >= 0) {
        found = index
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return found + 1
  }

  /**
   * Where the user is, in block numbers. Without `force`, only while the block list is
   * current (undefined after a change: listing again is linear, too slow while typing).
   */
  selection(force: boolean): SelectionReport | undefined {
    if (!force && this.cached === undefined) return undefined
    const blocks = this.blocks()
    if (blocks.length === 0) return { cursorLine: 1, fromLine: 1, toLine: 1, text: '' }
    const view = this.model.getCurrentController().getViewCursor()
    let table: any
    try { table = view.getPropertyValue('TextTable') } catch { /* not in a table */ }
    const from = this.blockOf(blocks, view.getStart(), table)
    const to = this.blockOf(blocks, view.getEnd(), table)
    let text = ''
    try { text = String(view.getString()) } catch { /* not text, e.g. a selected image */ }
    return { cursorLine: to, fromLine: from, toLine: to, text: text.length > MAX_SELECTION_CHARS ? text.slice(0, MAX_SELECTION_CHARS) : text }
  }

  private block(blocks: readonly Block[], index: number): Block {
    const block = blocks[index - 1]
    if (!Number.isInteger(index) || block === undefined) throw new Error(`block ${index} does not exist (the document has ${blocks.length})`)
    return block
  }

  private range(blocks: readonly Block[], from: number, to: number): Block[] {
    if (to < from) throw new Error(`the range ${from}–${to} is empty`)
    this.block(blocks, from)
    this.block(blocks, to)
    return blocks.slice(from - 1, to)
  }

  private describe(block: Block, index: number): DocumentBlock {
    const cut = (text: string): string => text.length > MAX_BLOCK_CHARS ? `${text.slice(0, MAX_BLOCK_CHARS)}…` : text
    if (block.kind === 'table') {
      const table = block.element
      const rows = table.getRows().getCount()
      const columns = table.getColumns().getCount()
      const lines: string[] = []
      for (let row = 0; row < rows; row++) {
        const cells: string[] = []
        for (let column = 0; column < columns; column++) {
          try {
            cells.push(String(table.getCellByPosition(column, row).getString()))
          } catch {
            // A merged cell.
          }
        }
        lines.push(cells.join(' | '))
      }
      return { index, kind: 'table', rows, columns, text: cut(lines.join('\n')) }
    }
    return { index, kind: 'paragraph', style: String(block.element.getPropertyValue('ParaStyleName')), text: cut(String(block.element.getString())) }
  }

  read(from: number | undefined, to: number | undefined): DocumentRead {
    const blocks = this.blocks()
    const total = blocks.length
    if (total === 0) return { total, blocks: [] }
    const first = from ?? 1
    const last = Math.min(to ?? first + DEFAULT_READ_BLOCKS - 1, total)
    return { total, blocks: this.range(blocks, first, last).map((block, offset) => this.describe(block, first + offset)) }
  }

  /**
   * Apply `operations` in order as one undo step: all or nothing. When one
   * fails, those before it are undone and the error names the failing one.
   */
  edit(operations: readonly EditOperation[]): EditResult {
    if (operations.length === 0) throw new Error('no operations')
    const undo = this.model.getUndoManager()
    const applied: string[] = []
    // No repaint per change: the view updates once, at the end.
    this.model.lockControllers()
    undo.enterUndoContext('AI edit')
    try {
      for (const operation of operations) {
        applied.push(this.apply(operation))
        this.invalidate()
      }
    } catch (error) {
      undo.leaveUndoContext()
      if (applied.length > 0) undo.undo()
      this.invalidate()
      this.model.unlockControllers()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`operation ${applied.length + 1} (${operations[applied.length]?.op}) failed, nothing was changed: ${reason}`)
    }
    undo.leaveUndoContext()
    this.model.unlockControllers()
    return { applied, total: this.blocks().length }
  }

  private apply(operation: EditOperation): string {
    switch (operation.op) {
      case 'replace': return this.replace(operation)
      case 'insert': return this.insert(operation)
      case 'delete': return this.delete(operation)
      case 'style': return this.style(operation)
      case 'format': return this.format(operation)
      default: throw new Error(`unknown operation ${JSON.stringify((operation as { op?: unknown }).op)}`)
    }
  }

  /** Every occurrence of `find`, limited to blocks `from`–`to` when given. */
  private matches(find: string, matchCase: boolean | undefined, from: number | undefined, to: number | undefined): any[] {
    if (find === '') throw new Error('`find` is empty')
    const descriptor = this.model.createSearchDescriptor()
    descriptor.setSearchString(find)
    descriptor.setPropertyValue('SearchCaseSensitive', matchCase === true)
    const found = this.model.findAll(descriptor)
    const ranges: any[] = []
    for (let i = 0; i < found.getCount(); i++) ranges.push(found.getByIndex(i))
    if (from === undefined && to === undefined) return ranges
    const blocks = this.blocks()
    const scope = this.range(blocks, from ?? 1, to ?? blocks.length)
    const text = this.model.getText()
    const start = scope[0]!.element.getStart()
    const end = scope[scope.length - 1]!.element.getEnd()
    return ranges.filter((range) => {
      try {
        // compareRegion*(a, b): 1 when a is before b, 0 when equal, -1 when after.
        return text.compareRegionStarts(start, range) >= 0 && text.compareRegionEnds(range, end) >= 0
      } catch {
        // In a table, frame or note: another text, outside any block range.
        return false
      }
    })
  }

  private replace(operation: Extract<EditOperation, { op: 'replace' }>): string {
    const ranges = this.matches(operation.find, operation.matchCase, operation.from, operation.to)
    for (const range of ranges) range.setString(operation.replace)
    return `replaced ${ranges.length} occurrence(s) of ${JSON.stringify(operation.find)}`
  }

  private paragraphStyle(name: string): string {
    const styles = this.model.getStyleFamilies().getByName('ParagraphStyles')
    if (styles.hasByName(name)) return name
    const known = [...styles.getElementNames()].slice(0, 40).join(', ')
    throw new Error(`no paragraph style ${JSON.stringify(name)}; some that exist: ${known}`)
  }

  private insert(operation: Extract<EditOperation, { op: 'insert' }>): string {
    const style = operation.style === undefined ? undefined : this.paragraphStyle(operation.style)
    const lines = operation.text.split(/\r?\n/)
    const text = this.model.getText()
    // One call for all the paragraphs: insertString splits at CR.
    const joined = lines.join('\r')
    let cursor: any
    if (operation.after === 0) {
      // Before the first block: the lines, then a break that pushes the rest down.
      text.insertString(text.createTextCursorByRange(text.getStart()), `${joined}\r`, false)
      cursor = text.createTextCursorByRange(text.getStart())
      for (let i = 1; i < lines.length; i++) cursor.gotoNextParagraph(true)
      cursor.gotoEndOfParagraph(true)
    } else {
      const block = this.block(this.blocks(), operation.after)
      if (block.kind === 'table') throw new Error(`block ${operation.after} is a table: insert after the paragraph that follows it, or before the table`)
      cursor = text.createTextCursorByRange(block.element.getEnd())
      text.insertString(cursor, `\r${joined}`, false)
      // The cursor ends after the new text: select back to the start of the first new paragraph.
      for (let i = 1; i < lines.length; i++) cursor.gotoPreviousParagraph(true)
      cursor.gotoStartOfParagraph(true)
    }
    if (style !== undefined) cursor.setPropertyValue('ParaStyleName', style)
    return `inserted ${lines.length} paragraph(s) after block ${operation.after}`
  }

  private delete(operation: Extract<EditOperation, { op: 'delete' }>): string {
    const blocks = this.blocks()
    const doomed = this.range(blocks, operation.from, operation.to)
    if (doomed.some(block => block.kind === 'table')) throw new Error('deleting tables is not supported; the range includes one')
    if (doomed.length === blocks.length) throw new Error('a document keeps at least one paragraph: replace the text of the last one instead')
    const text = this.model.getText()
    const next = blocks[operation.to]
    let cursor: any
    if (next !== undefined) {
      // Up to the start of the following block: the paragraphs and their breaks go.
      cursor = text.createTextCursorByRange(doomed[0]!.element.getStart())
      cursor.gotoRange(next.element.getStart(), true)
    } else {
      // The last paragraphs: from the end of the one before, taking its break.
      cursor = text.createTextCursorByRange(blocks[operation.from - 2]!.element.getEnd())
      cursor.gotoRange(doomed[doomed.length - 1]!.element.getEnd(), true)
    }
    cursor.setString('')
    return `deleted blocks ${operation.from}–${operation.to}`
  }

  private style(operation: Extract<EditOperation, { op: 'style' }>): string {
    const style = this.paragraphStyle(operation.style)
    const targets = this.range(this.blocks(), operation.from, operation.to).filter(block => block.kind === 'paragraph')
    for (const block of targets) block.element.setPropertyValue('ParaStyleName', style)
    return `set ${JSON.stringify(style)} on ${targets.length} paragraph(s)`
  }

  private format(operation: Extract<EditOperation, { op: 'format' }>): string {
    const { bold, italic, underline } = operation
    if (bold === undefined && italic === undefined && underline === undefined) throw new Error('give at least one of bold, italic, underline')
    const ranges = this.matches(operation.find, operation.matchCase, operation.from, operation.to)
    const { css, zetajs } = this
    // UNO extracts exact types: a plain JavaScript number would arrive as a long.
    const weight = new zetajs.Any(zetajs.type.float, bold === true ? css.awt.FontWeight.BOLD : css.awt.FontWeight.NORMAL)
    const line = new zetajs.Any(zetajs.type.short, underline === true ? css.awt.FontUnderline.SINGLE : css.awt.FontUnderline.NONE)
    for (const range of ranges) {
      if (bold !== undefined) range.setPropertyValue('CharWeight', weight)
      if (italic !== undefined) range.setPropertyValue('CharPosture', italic ? css.awt.FontSlant.ITALIC : css.awt.FontSlant.NONE)
      if (underline !== undefined) range.setPropertyValue('CharUnderline', line)
    }
    return `formatted ${ranges.length} occurrence(s) of ${JSON.stringify(operation.find)}`
  }
}
