/** Immutable text selected in a preview or editor, without host file/session identity. */
export interface TextSelection {
  text: string;
  location?: string;
}

/** Hit the painted selection, rather than a nearest caret snapped from blank editor space. */
export function hitsVisibleTextSelection(root: HTMLElement, event: MouseEvent, paintedSelector?: string): boolean {
  if (event.clientX === 0 && event.clientY === 0 && event.button === 0) return true;
  const rectangles: DOMRectReadOnly[] = [];
  const selection = root.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount === 1) {
    const range = selection.getRangeAt(0);
    if (root.contains(range.startContainer) && root.contains(range.endContainer))
      rectangles.push(...Array.from(range.getClientRects()));
  }
  if (paintedSelector)
    for (const element of root.querySelectorAll(paintedSelector)) rectangles.push(element.getBoundingClientRect());
  return rectangles.some(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom,
  );
}

/** Read only a selection wholly inside this file and hit by the context-menu gesture. */
export function readDomTextSelection(root: HTMLElement, event: MouseEvent): TextSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const excluded =
    'button,[role="tablist"],[role="status"],[role="alert"],.ofv-toolbar,.ofv-loading,.ofv-error,.ofv-empty';
  if (Array.from(root.querySelectorAll(excluded)).some((element) => range.intersectsNode(element))) return null;
  if (!hitsVisibleTextSelection(root, event)) return null;
  const text = selection.toString();
  return text.trim() ? { text } : null;
}
